import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openChromiumHumanView } from "../packages/browser-chromium/src/human-view.js";
test("human CDP view rejects stale frames, streams drag, and releases on navigation/close", async () => {
  const page = new EventEmitter() as any;
  const main = {};
  const commands: { method: string; params: any }[] = [];
  let detached = false;
  const cdp = {
    async send(method: string, params: any) {
      commands.push({ method, params });
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      if (method === "Page.captureScreenshot") return { data: "jpeg-data" };
    },
    async detach() {
      detached = true;
    },
  };
  page.mainFrame = () => main;
  page.context = () => ({ newCDPSession: async () => cdp });
  const view = await openChromiumHumanView(page);
  try {
    const frame = await view.capture();
    assert.equal(frame.data, "jpeg-data");
    assert.equal(commands[0].method, "Page.bringToFront");
    assert.equal(
      commands.find((c) => c.method === "Page.captureScreenshot")?.params
        .fromSurface,
      false,
    );
    await assert.rejects(
      view.input({ frameId: 999, type: "text", text: "never sent" }),
    );
    await assert.rejects(
      view.input({ frameId: frame.id, type: "click", x: 999, y: 10 }),
    );
    await view.input({
      frameId: frame.id,
      type: "pointer",
      phase: "down",
      x: 100,
      y: 100,
    });
    await view.input({
      frameId: frame.id,
      type: "pointer",
      phase: "move",
      x: 400,
      y: 100,
    });
    assert.equal(commands.at(-1)?.params.type, "mouseMoved");
    assert.equal(commands.at(-1)?.params.buttons, 1);
    page.emit("framenavigated", main);
    await new Promise((r) => setImmediate(r));
    assert.equal(commands.at(-1)?.params.type, "mouseReleased");
    await assert.rejects(
      view.input({ frameId: frame.id, type: "text", text: "stale secret" }),
    );
    // Release must remain available even when the last frame expired or navigated.
    await view.input({
      frameId: frame.id,
      type: "pointer",
      phase: "up",
      x: 400,
      y: 100,
    });
    const fresh = await view.capture();
    await view.input({
      frameId: fresh.id,
      type: "text",
      text: "synthetic otp",
    });
    assert.equal(commands.at(-1)?.method, "Input.insertText");
    await view.input({
      frameId: fresh.id,
      type: "pointer",
      phase: "down",
      x: 100,
      y: 100,
    });
  } finally {
    await view.close();
  }
  assert.equal(commands.at(-1)?.params.type, "mouseReleased");
  assert.equal(detached, true);
  assert.equal(page.listenerCount("framenavigated"), 0);
  await assert.rejects(view.capture());
});
