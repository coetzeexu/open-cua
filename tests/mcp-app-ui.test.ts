import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
const wait = async (test: () => boolean) => {
  const end = Date.now() + 4000;
  while (!test()) {
    if (Date.now() > end) throw Error("UI did not reach expected state");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function testPanel(
  scenario:
    | "input"
    | "drag"
    | "failed-drag"
    | "recover"
    | "click"
    | "typing"
    | "wheel"
    | "frame-retry",
) {
  const window = new Window({
    url: "https://isolated-app.test",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const calls: any[] = [];
  let control = "agent";
  let closed = false;
  let offline = false;
  let frameOffline = false;
  let imageLoaded = true;
  const payload = {
    sessionId: "session",
    tabId: "tab",
    token: "x".repeat(64),
    recoveryToken: "r".repeat(64),
    expiresAt: Date.now() + 60000,
  };
  const state = () => ({
    status: { control },
    requests: [],
    sessionId: "session",
    tabId: "tab",
  });
  const host = {
    postMessage(message: any) {
      calls.push(message);
      if (message.method === "ui/initialize")
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            hostInfo: { name: "test-host", version: "1" },
            hostCapabilities: { serverTools: {} },
            hostContext: { theme: "light", displayMode: "inline" },
          },
        });
      if (message.method === "ui/notifications/initialized") {
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { sessionId: "session", tabId: "tab" } },
        });
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: "Panel opened" }],
            structuredContent: { sessionId: "session", tabId: "tab" },
            _meta: { cua: payload },
          },
        });
      }
      if (message.method === "tools/call") {
        const { name, arguments: a } = message.params;
        if (name === "cua_ui_recover") {
          assert.equal(a.token, payload.recoveryToken);
          payload.token = "y".repeat(64);
          payload.recoveryToken = "s".repeat(64);
          control = "agent";
          offline = false;
          imageLoaded = false;
          setTimeout(
            () =>
              send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [],
                  _meta: { cua: { ...payload, recreated: true } },
                },
              }),
            100,
          );
          return;
        }
        assert.equal(a.token, payload.token);
        if (offline || (frameOffline && name === "cua_ui_frame")) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { isError: true, content: [] },
          });
          return;
        }
        if (name === "cua_ui_control") {
          if (a.action === "take") control = "human";
          if (a.action === "resume") control = "agent";
          if (a.action === "close") closed = true;
        }
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [],
            _meta: {
              cua:
                name === "cua_ui_frame"
                  ? { id: 1, width: 800, height: 600, data: "test-image" }
                  : state(),
            },
          },
        });
      }
    },
  };
  function send(data: any) {
    const source = calls.find(
      (m) => m.id === data.id && m.method === "tools/call",
    );
    if (source?.params?.arguments?.input?.phase === "move") {
      if (scenario === "failed-drag")
        data.result = {
          isError: true,
          content: [{ type: "text", text: "Stale frame" }],
        };
      setTimeout(
        () =>
          window.dispatchEvent(
            new window.MessageEvent("message", { data, source: host as any }),
          ),
        100,
      );
      return;
    }
    queueMicrotask(() =>
      window.dispatchEvent(
        new window.MessageEvent("message", { data, source: host as any }),
      ),
    );
  }
  Object.defineProperty(window, "parent", { value: host });
  Object.defineProperty(window, "Image", {
    value: class {
      onload?: () => void;
      onerror?: () => void;
      private value = "";
      set src(v: string) {
        this.value = v;
        if (!imageLoaded)
          setTimeout(() => {
            imageLoaded = true;
            this.onload?.();
          }, 200);
        else queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.value;
      }
    },
  });
  try {
    const html = await readFile("packages/mcp/dist/browser.html", "utf8");
    const script = html.match(/<script type="module">([\s\S]*)<\/script>/)![1];
    assert.ok(!script.includes("__APP_SCRIPT__"));
    window.document.write(html.replace(/<script[\s\S]*<\/script>/, ""));
    window.eval(script);
    const doc = window.document;
    await wait(() => !!doc.getElementById("screen")?.getAttribute("src"));
    assert.equal((doc.getElementById("insert") as any).disabled, true);
    (doc.querySelector("[data-action=take]") as any).click();
    await wait(
      () => doc.getElementById("status")?.textContent === "人工控制中",
    );
    if (scenario === "recover") {
      offline = true;
      (doc.getElementById("refresh") as any).click();
      await wait(() => !(doc.getElementById("wake-overlay") as any).hidden);
      assert.equal(doc.getElementById("screen")?.getAttribute("src"), null);
      assert.ok(
        doc.getElementById("viewport")?.classList.contains("disconnected"),
      );
      assert.equal(doc.getElementById("wake-label")?.textContent, "唤醒");
      (doc.getElementById("recover") as any).click();
      assert.equal(
        doc.getElementById("wake-overlay")?.getAttribute("aria-busy"),
        "true",
      );
      assert.equal((doc.getElementById("recover") as any).disabled, true);
      await wait(() =>
        calls.some(
          (m) =>
            m.params?.name === "cua_ui_frame" &&
            m.params.arguments.token === "y".repeat(64),
        ),
      );
      assert.equal(imageLoaded, false);
      assert.equal((doc.getElementById("wake-overlay") as any).hidden, false);
      assert.equal(doc.getElementById("wake-label")?.textContent, "正在唤醒…");
      await wait(
        () =>
          !!doc
            .getElementById("recovery-note")
            ?.textContent?.includes("已新建会话"),
      );
      assert.equal((doc.getElementById("wake-overlay") as any).hidden, true);
      assert.equal(imageLoaded, true);
      assert.equal(doc.getElementById("status")?.textContent, "模型控制中");
      assert.equal((doc.getElementById("insert") as any).disabled, true);
      assert.ok(
        calls.some(
          (m) =>
            m.params?.name === "cua_ui_frame" &&
            m.params.arguments.token === payload.token,
        ),
      );
    } else if (scenario === "frame-retry") {
      frameOffline = true;
      (doc.getElementById("refresh") as any).click();
      await wait(
        () => !!doc.getElementById("error")?.textContent?.includes("自动重试"),
      );
      assert.equal((doc.getElementById("wake-overlay") as any).hidden, true);
      assert.equal(doc.getElementById("status")?.textContent, "人工控制中");
      assert.ok(doc.getElementById("screen")?.getAttribute("src"));
      frameOffline = false;
      (doc.getElementById("refresh") as any).click();
      await wait(() => !doc.getElementById("error")?.textContent);
      assert.equal(doc.getElementById("status")?.textContent, "人工控制中");
    } else if (scenario === "input") {
      const input = doc.getElementById("text") as any;
      input.value = "synthetic-private";
      (doc.getElementById("insert") as any).click();
      await wait(() => calls.some((m) => m.params?.name === "cua_ui_input"));
      assert.equal(input.value, "");
      const sent = calls.find((m) => m.params?.name === "cua_ui_input");
      assert.equal(sent.params.arguments.input.text, "synthetic-private");
    } else if (["click", "typing", "wheel"].includes(scenario)) {
      const screen = doc.getElementById("screen") as any;
      screen.setPointerCapture = () => {};
      screen.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      });
      const point = {
        button: 0,
        clientX: 20,
        clientY: 50,
        pointerId: 1,
        preventDefault() {},
      };
      if (scenario === "click") {
        screen.onpointerdown(point);
        screen.onpointerup(point);
        await wait(() =>
          calls.some((m) => m.params?.arguments?.input?.type === "click"),
        );
        const inputs = calls.filter((m) => m.params?.name === "cua_ui_input");
        assert.equal(
          inputs.length,
          1,
          "a short click needs one remote request",
        );
        assert.equal(inputs[0].params.arguments.input.x, 20);
        screen.onpointerdown(point);
        screen.onpointercancel();
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(
          calls.filter((m) => m.params?.name === "cua_ui_input").length,
          1,
          "cancelled clicks must not be dispatched",
        );
      } else if (scenario === "typing") {
        for (const key of "rapid typing")
          screen.onkeydown({ key, preventDefault() {} });
        screen.onkeydown({ key: "Enter", preventDefault() {} });
        await wait(
          () =>
            calls.filter((m) => m.params?.name === "cua_ui_input").length === 2,
        );
        const inputs = calls
          .filter((m) => m.params?.name === "cua_ui_input")
          .map((m) => m.params.arguments.input);
        assert.equal(inputs[0].type, "text");
        assert.equal(inputs[0].text, "rapid typing");
        assert.equal(inputs[1].key, "Enter", "flush text before special keys");
      } else {
        for (let i = 0; i < 100; i++)
          screen.onwheel({ ...point, deltaX: 0, deltaY: 10 });
        await wait(() =>
          calls.some((m) => m.params?.arguments?.input?.type === "wheel"),
        );
        const inputs = calls.filter((m) => m.params?.name === "cua_ui_input");
        assert.equal(
          inputs.length,
          1,
          "coalesce a wheel burst instead of queueing 100 requests",
        );
        assert.equal(inputs[0].params.arguments.input.deltaY, 1000);
      }
    } else {
      const screen = doc.getElementById("screen") as any;
      screen.setPointerCapture = () => {};
      screen.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      });
      const event = (x: number) => ({
        button: 0,
        clientX: x,
        clientY: 50,
        pointerId: 1,
        preventDefault() {},
      });
      screen.onpointerdown(event(10));
      await wait(() =>
        calls.some((m) => m.params?.arguments?.input?.phase === "down"),
      );
      screen.onpointermove(event(100));
      await wait(() =>
        calls.some((m) => m.params?.arguments?.input?.phase === "move"),
      );
      screen.onpointermove(event(250));
      screen.onpointerup(event(400));
      await wait(() =>
        calls.some((m) => m.params?.arguments?.action === "release"),
      );
      const moves = calls.filter(
        (m) => m.params?.arguments?.input?.phase === "move",
      );
      assert.deepEqual(
        moves.map((m) => m.params.arguments.input.x),
        [100, 400],
      );
      const released = calls.findIndex(
        (m) => m.params?.arguments?.action === "release",
      );
      assert.ok(released > calls.indexOf(moves.at(-1)));
      if (scenario === "failed-drag")
        assert.ok(doc.getElementById("error")?.textContent);
    }
    (doc.querySelector("[data-action=resume]") as any).click();
    await wait(
      () => doc.getElementById("status")?.textContent === "模型控制中",
    );
    send({
      jsonrpc: "2.0",
      id: 900,
      method: "ui/resource-teardown",
      params: {},
    });
    await wait(() => closed);
    assert.ok(
      !calls.some(
        (m) =>
          m.method === "ui/message" || m.method === "ui/update-model-context",
      ),
    );
    assert.ok(!doc.body.textContent?.includes(payload.token));
  } finally {
    await window.happyDOM.close();
  }
}
test("bundled MCP App handshakes, takes control and submits private input without model messages", () =>
  testPanel("input"));
test("panel drag coalesces delayed moves and sends pointerup position before release", () =>
  testPanel("drag"));
test("panel releases the pointer even when the final move is rejected", () =>
  testPanel("failed-drag"));

test("panel recovery replaces credentials and refreshes the recreated session", () =>
  testPanel("recover"));
test("a quick panel click uses one request and cancelled presses do not click", () =>
  testPanel("click"));
test("panel batches typed text while preserving Enter ordering", () =>
  testPanel("typing"));
test("panel coalesces wheel bursts", () => testPanel("wheel"));
test("a frame failure preserves human control and retries without a wake cycle", () =>
  testPanel("frame-retry"));
