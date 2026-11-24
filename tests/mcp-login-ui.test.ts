import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

async function wait(check: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw Error("Login UI did not reach expected state");
    await new Promise((r) => setTimeout(r, 10));
  }
}
for (const scenario of [
  "submit",
  "cancel",
  "expired",
  "failure",
  "host-reject",
  "host-error",
  "host-timeout",
  "missing-receipt",
] as const) {
  test(`private login card ${scenario} uses only scoped app tools and clears input`, async () => {
    const window = new Window({
      url: "https://isolated.test",
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    const calls: any[] = [];
    let answer: any;
    const grant = {
      sessionId: "session",
      requestId: "request",
      token: "a".repeat(64),
      expiresAt: Date.now() + 60000,
      request: {
        origin: "https://login.test",
        fields: [
          { id: "account", label: "账号", type: "username" },
          { id: "pass", label: "密码", type: "password" },
        ],
      },
    };
    const continuation = {
      role: "user",
      content: [
        {
          type: "text",
          text: "登录卡片已私密提交（sessionId=session，requestId=request，executionId=execution）。请轮询原执行，确认登录结果后继续任务。",
        },
      ],
    };
    function send(data: any) {
      queueMicrotask(() =>
        window.dispatchEvent(
          new window.MessageEvent("message", { data, source: host as any }),
        ),
      );
    }
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
              hostCapabilities: { serverTools: {}, message: { text: {} } },
              hostContext: { theme: "light", displayMode: "inline" },
            },
          });
        if (message.method === "ui/notifications/initialized")
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: { content: [], _meta: { cua: grant } },
          });
        if (message.method === "ui/message") {
          assert.equal(window.document.querySelectorAll("input").length, 0);
          assert.deepEqual(message.params, continuation);
          if (scenario === "host-timeout") return;
          send({
            jsonrpc: "2.0",
            id: message.id,
            ...(scenario === "host-error"
              ? { error: { code: -32601, message: "Unsupported" } }
              : {
                  result: scenario === "host-reject" ? { isError: true } : {},
                }),
          });
        }
        if (message.method === "tools/call") {
          const { name, arguments: args } = message.params;
          assert.equal(args.sessionId, grant.sessionId);
          assert.equal(args.requestId, grant.requestId);
          assert.equal(args.token, grant.token);
          assert.ok(
            ["cua_ui_login_state", "cua_ui_login_answer"].includes(name),
          );
          if (name === "cua_ui_login_answer") answer = structuredClone(args);
          send({
            jsonrpc: "2.0",
            id: message.id,
            result:
              scenario === "failure"
                ? { isError: true, content: [] }
                : {
                    content: [],
                    _meta: {
                      cua: {
                        ...(scenario !== "missing-receipt"
                          ? { continuation }
                          : {}),
                        status:
                          name === "cua_ui_login_state"
                            ? "expired"
                            : args.action === "submit"
                              ? "submitted"
                              : "cancelled",
                      },
                    },
                  },
          });
        }
      },
    };
    Object.defineProperty(window, "parent", { value: host });
    try {
      const html = await readFile("packages/mcp/dist/login.html", "utf8");
      const script = html.match(
        /<script type="module">([\s\S]*)<\/script>/,
      )![1];
      window.document.write(html.replace(/<script[\s\S]*<\/script>/, ""));
      window.eval(script);
      const doc = window.document;
      await wait(() => doc.querySelectorAll("input").length === 2);
      const [account, pass] = [...doc.querySelectorAll("input")];
      assert.equal(account.type, "text");
      assert.equal(pass.type, "password");
      assert.ok(
        doc
          .getElementById("origin")
          ?.textContent?.includes("https://login.test"),
      );
      account.value = "private-account";
      pass.value = "private-password";
      if (scenario === "cancel") (doc.getElementById("cancel") as any).click();
      else if (scenario !== "expired")
        (doc.getElementById("login") as any).dispatchEvent(
          new window.Event("submit", { cancelable: true }),
        );
      await wait(() => !!(doc.getElementById("login") as any).hidden);
      assert.equal(account.value, "");
      assert.equal(pass.value, "");
      assert.equal(doc.querySelectorAll("input").length, 0);
      if (
        [
          "submit",
          "host-reject",
          "host-error",
          "host-timeout",
          "missing-receipt",
        ].includes(scenario)
      ) {
        await wait(
          () =>
            !!doc
              .getElementById("status")
              ?.textContent?.includes(
                scenario === "submit" ? "已提交并通知" : "未能确认任务自动继续",
              ),
          scenario === "host-timeout" ? 12000 : 4000,
        );
        assert.deepEqual(answer.values, {
          account: "private-account",
          pass: "private-password",
        });
      } else if (scenario === "cancel") {
        assert.equal(answer.action, "decline");
        assert.equal(answer.values, undefined);
      } else if (scenario === "expired") assert.equal(answer, undefined);
      else
        assert.ok(
          doc.getElementById("status")?.textContent?.includes("未能确认"),
        );
      const messages = calls.filter((m) => m.method === "ui/message");
      assert.equal(
        messages.length,
        ["submit", "host-reject", "host-error", "host-timeout"].includes(
          scenario,
        )
          ? 1
          : 0,
      );
      assert.ok(!calls.some((m) => m.method === "ui/update-model-context"));
      assert.ok(!JSON.stringify(messages).includes("private-account"));
      assert.ok(!JSON.stringify(messages).includes("private-password"));
      assert.ok(!JSON.stringify(messages).includes(grant.token));
      // A duplicate submit event cannot resend either credentials or a notification.
      (doc.getElementById("login") as any).dispatchEvent(
        new window.Event("submit", { cancelable: true }),
      );
      assert.equal(
        calls.filter((m) => m.method === "ui/message").length,
        messages.length,
      );
      assert.equal(
        calls.filter((m) => m.params?.name === "cua_ui_login_answer").length,
        scenario === "expired" ? 0 : 1,
      );
      assert.ok(!doc.body.textContent?.includes(grant.token));
      assert.ok(!doc.body.textContent?.includes("private-password"));
    } finally {
      await window.happyDOM.close();
    }
  });
}
