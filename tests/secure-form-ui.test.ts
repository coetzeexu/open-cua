import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

async function wait(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= until)
      throw Error("Secure form UI did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const scenario of [
  "success",
  "unknown",
  "cancel",
  "return",
  "attention",
  "notification-failed",
  "recovered",
  "required",
  "malformed",
  "expired",
  "failed_before_write",
  "stale",
] as const) {
  test(`secure form ${scenario} preserves private delivery and recoverable progress`, async () => {
    const window = new Window({
      url: "https://isolated.test",
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    const calls: any[] = [];
    let delivered = false;
    let queryCount = 0;
    let answer: any;
    const continuation = {
      role: "user",
      content: [
        {
          type: "text",
          text: "Secure form request-test finished. Inspect original execution-test; do not replay.",
        },
      ],
    };
    const grant = {
      sessionId: "session-test",
      requestId: "request-test",
      token: "a".repeat(64),
      status: "pending",
      expiresAt: Date.now() + 15 * 60_000,
      request: {
        schemaRevision: "revision-test",
        expiresAt: scenario === "expired" ? Date.now() - 1 : Date.now() + 60000,
        origin: "https://verified.test:8443",
        title: "乘客 1",
        delivery: { mode: "fill" },
        groups: [{ id: "passenger", label: "乘客资料" }],
        fields: [
          {
            id: "name",
            groupId: "passenger",
            label: "姓名",
            control: scenario === "malformed" ? "unsupported-widget" : "text",
            required: true,
            nonEmpty: true,
          },
          {
            id: "birth",
            groupId: "passenger",
            label: "生日",
            control: "date",
            required: true,
          },
          {
            id: "country",
            label: "国籍",
            control: "select",
            required: true,
            options: [{ id: "option-opaque", label: "Verified option" }],
          },
          {
            id: "passport",
            label: "护照",
            control: "text",
            masked: true,
            required: true,
          },
        ],
      },
    };
    function send(data: any) {
      queueMicrotask(() =>
        window.dispatchEvent(
          new window.MessageEvent("message", { data, source: host as any }),
        ),
      );
    }
    function respond(message: any, value: any) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [], _meta: { cua: value } },
      });
    }
    const host = {
      postMessage(message: any) {
        calls.push(structuredClone(message));
        if (message.method === "ui/initialize")
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              hostInfo: { name: "test", version: "1" },
              hostCapabilities: { serverTools: {}, message: { text: {} } },
              hostContext: { theme: "light", displayMode: "inline" },
            },
          });
        if (message.method === "ui/notifications/initialized")
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content: [],
              _meta: {
                cua:
                  scenario === "recovered"
                    ? {
                        ...grant,
                        request: undefined,
                        status: "filled",
                        continuation,
                      }
                    : grant,
              },
            },
          });
        if (message.method === "ui/message") {
          assert.equal(
            window.document.querySelectorAll("input,select").length,
            0,
          );
          assert.deepEqual(message.params, continuation);
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: scenario === "notification-failed" ? { isError: true } : {},
          });
        }
        if (message.method === "tools/call") {
          const { name, arguments: args } = message.params;
          assert.equal(args.token, grant.token);
          assert.ok(
            ["cua_ui_secure_form_state", "cua_ui_secure_form_answer"].includes(
              name,
            ),
          );
          if (name.endsWith("answer")) {
            answer = structuredClone(args);
            if (args.action === "decline") {
              respond(message, { status: "cancelled" });
              return;
            }
            delivered = true;
            if (scenario === "unknown") {
              send({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: "Lost acknowledgement" },
              });
              return;
            }
            respond(message, { status: "accepted" });
          } else {
            queryCount++;
            respond(
              message,
              scenario === "cancel"
                ? { status: "cancelled" }
                : delivered
                  ? {
                      status:
                        scenario === "attention"
                          ? "partial_or_unknown"
                          : scenario === "failed_before_write"
                            ? "failed_before_write"
                            : scenario === "stale"
                              ? "stale"
                              : "filled",
                      nextAction:
                        scenario === "failed_before_write"
                          ? "new_request"
                          : "human_review",
                      continuation,
                    }
                  : grant,
            );
          }
        }
      },
    };
    Object.defineProperty(window, "parent", { value: host });
    try {
      const html = await readFile("packages/mcp/dist/secure-form.html", "utf8");
      window.document.write(html.replace(/<script[\s\S]*<\/script>/, ""));
      window.eval(html.match(/<script type="module">([\s\S]*)<\/script>/)![1]);
      const doc = window.document;
      if (scenario === "recovered") {
        await wait(() => calls.some((call) => call.method === "ui/message"));
        assert.equal(doc.querySelectorAll("input,select").length, 0);
        assert.equal(
          calls.filter(
            (call) => call.params?.name === "cua_ui_secure_form_answer",
          ).length,
          0,
        );
        assert.equal((doc.getElementById("open") as any).hidden, true);
        return;
      }
      if (["expired", "malformed"].includes(scenario)) {
        await wait(
          () =>
            !!doc
              .getElementById("status")
              ?.textContent.includes(
                scenario === "expired" ? "过期" : "配置不可用",
              ),
        );
        assert.equal(doc.querySelectorAll("input,select").length, 0);
        assert.equal((doc.getElementById("open") as any).hidden, true);
        assert.equal(answer, undefined);
        assert.ok(
          grant.expiresAt > Date.now(),
          "read grant remains valid after pending request expiry",
        );
        return;
      }
      await wait(() => !(doc.getElementById("open") as any).hidden);
      assert.equal(doc.querySelectorAll("input").length, 0);
      (doc.getElementById("open") as any).click();
      await wait(() => doc.querySelectorAll("input,select").length === 4);
      const value = (id: string) => doc.getElementById(`field-${id}`) as any;
      assert.equal(value("birth").type, "date");
      assert.equal(value("passport").type, "password");
      assert.equal(
        doc.getElementById("origin")?.textContent,
        grant.request.origin,
      );
      assert.equal((doc.getElementById("fullscreen") as any).hidden, true);
      assert.ok(
        doc
          .getElementById("fields")
          ?.textContent.includes("网页已有内容，本次将覆盖"),
      );
      value("name").value = "private-name";
      value("birth").value = "1990-02-03";
      value("country").value = "option-opaque";
      value("passport").value = "private-passport";
      const refs = [...doc.querySelectorAll("input,select")];
      if (scenario === "required") {
        value("name").value = "   ";
        (doc.getElementById("secure-form") as any).dispatchEvent(
          new window.Event("submit", { cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(answer, undefined);
        assert.equal((doc.getElementById("secure-form") as any).hidden, false);
        assert.ok(value("name").validationMessage);
        value("name").value = "private-name";
        value("name").dispatchEvent(new window.Event("input"));
      }
      if (scenario === "return") {
        (doc.getElementById("back") as any).click();
        assert.equal(doc.querySelectorAll("input,select").length, 0);
        (doc.getElementById("open") as any).click();
        assert.ok(
          [...doc.querySelectorAll("input,select")].every(
            (input) => !("value" in input && input.value),
          ),
        );
        assert.equal(answer, undefined);
      } else {
        if (scenario === "cancel")
          (doc.getElementById("cancel") as any).click();
        else
          (doc.getElementById("secure-form") as any).dispatchEvent(
            new window.Event("submit", { cancelable: true }),
          );
        await wait(() =>
          scenario === "cancel"
            ? !!doc.getElementById("status")?.textContent.includes("取消")
            : scenario === "stale"
              ? !!doc
                  .getElementById("status")
                  ?.textContent.includes("页面已变化")
              : calls.some((call) => call.method === "ui/message"),
        );
        assert.ok(refs.every((input) => !("value" in input && input.value)));
        if (scenario !== "cancel") {
          assert.equal(answer.schemaRevision, "revision-test");
          assert.ok(answer.submissionId);
          assert.deepEqual(answer.values, {
            name: "private-name",
            birth: "1990-02-03",
            country: "option-opaque",
            passport: "private-passport",
          });
          assert.ok(
            queryCount > 0,
            "accepted is queried, never announced as completed",
          );
          assert.ok(
            !doc.getElementById("status")?.textContent.includes("登录成功"),
          );
          if (scenario === "attention")
            assert.ok(
              doc.getElementById("status")?.textContent.includes("人工检查"),
            );
          if (scenario === "failed_before_write") {
            assert.ok(
              doc
                .getElementById("status")
                ?.textContent.includes("交付前检查失败"),
            );
            assert.ok(
              doc
                .getElementById("next-action")
                ?.textContent.includes("建立新请求"),
            );
          }
          if (scenario === "notification-failed")
            await wait(
              () =>
                !!doc
                  .getElementById("notice")
                  ?.textContent.includes("未能确认"),
            );
        } else {
          assert.deepEqual(
            Object.keys(answer).sort(),
            ["sessionId", "requestId", "token", "action"].sort(),
          );
          assert.equal(answer.values, undefined);
        }
        (doc.getElementById("secure-form") as any).dispatchEvent(
          new window.Event("submit", { cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          calls.filter(
            (call) => call.params?.name === "cua_ui_secure_form_answer",
          ).length,
          1,
        );
      }
      const modelMessages = calls.filter((call) =>
        ["ui/message", "ui/update-model-context"].includes(call.method),
      );
      assert.equal(
        modelMessages.length,
        ["return", "cancel", "stale"].includes(scenario) ? 0 : 1,
      );
      for (const secret of [
        "private-name",
        "private-passport",
        "1990-02-03",
        grant.token,
      ])
        assert.ok(!JSON.stringify(modelMessages).includes(secret));
      assert.equal(window.localStorage.length, 0);
      assert.equal(window.sessionStorage.length, 0);
    } finally {
      await window.happyDOM.close();
    }
  });
}
