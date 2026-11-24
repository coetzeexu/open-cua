import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { App } from "@modelcontextprotocol/ext-apps";
// @ts-expect-error User-facing example is plain JavaScript.
import { modelTools, modelResult } from "../examples/harness-client.mjs";
// @ts-expect-error User-facing example is plain JavaScript.
import * as bridges from "../examples/harness-app-bridge.mjs";
const { attachCUAPanel, attachCUALogin } = bridges;
test("harness examples filter model context and bridge only bound UI calls", async () => {
  assert.deepEqual(
    modelTools([
      { name: "cua_exec", inputSchema: {} },
      { name: "cua_ui_input", _meta: { ui: { visibility: ["app"] } } },
    ]),
    [{ name: "cua_exec", description: undefined, inputSchema: {} }],
  );
  const viewResult = {
    content: [{ type: "text", text: "opened" }],
    structuredContent: { sessionId: "session", tabId: "tab" },
    _meta: {
      cua: { sessionId: "session", tabId: "tab", token: "private-token" },
    },
  };
  assert.ok(!JSON.stringify(modelResult(viewResult)).includes("private-token"));
  const [hostTransport, viewTransport] = InMemoryTransport.createLinkedPair();
  const calls: any[] = [];
  const bridge = await attachCUAPanel({
    transport: hostTransport,
    viewResult,
    callPrivateTool: async (name: string, args: any) => {
      calls.push({ name, args });
      return { content: [], _meta: { cua: { ok: true } } };
    },
  });
  const app = new App(
    { name: "test-ui", version: "1" },
    {},
    { autoResize: false },
  );
  let received: any;
  app.ontoolresult = (r) => {
    received = r;
  };
  try {
    await app.connect(viewTransport);
    const deadline = Date.now() + 1000;
    while (!received && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(received._meta.cua.token, "private-token");
    await app.callServerTool({
      name: "cua_ui_state",
      arguments: { sessionId: "session", token: "replacement" },
    });
    assert.equal(calls[0].args.token, "private-token");
    await assert.rejects(
      app.callServerTool({
        name: "cua_exec",
        arguments: { sessionId: "session", code: "bad" },
      }),
    );
    await assert.rejects(
      app.callServerTool({
        name: "cua_ui_state",
        arguments: { sessionId: "other" },
      }),
    );
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
    await bridge.close();
  }
});

test("login bridge binds request authority and excludes browser tools", async () => {
  const [hostTransport, viewTransport] = InMemoryTransport.createLinkedPair();
  const calls: any[] = [];
  const loginResult = {
    content: [],
    _meta: {
      cua: { sessionId: "session", requestId: "request", token: "login-token" },
    },
  };
  const bridge = await attachCUALogin({
    transport: hostTransport,
    loginResult,
    callPrivateTool: async (name: string, args: any) => {
      calls.push({ name, args });
      return { content: [] };
    },
  });
  const app = new App(
    { name: "test-login", version: "1" },
    {},
    { autoResize: false },
  );
  try {
    await app.connect(viewTransport);
    await app.callServerTool({
      name: "cua_ui_login_answer",
      arguments: {
        sessionId: "session",
        requestId: "request",
        token: "replacement",
        action: "submit",
        values: { pass: "private" },
      },
    });
    assert.equal(calls[0].args.token, "login-token");
    for (const [name, requestId] of [
      ["cua_ui_input", "request"],
      ["cua_ui_login_answer", "other"],
    ])
      await assert.rejects(
        app.callServerTool({
          name,
          arguments: { sessionId: "session", requestId },
        }),
      );
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
    await bridge.close();
  }
});

for (const fail of [false, true]) {
  test(`login bridge resumes only from a verified receipt once (host failure=${fail})`, async () => {
    const [hostTransport, viewTransport] = InMemoryTransport.createLinkedPair();
    const queued: any[] = [];
    const receipt = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "Login submitted; poll execution-test and continue.",
        },
      ],
    };
    const bridge = await attachCUALogin({
      transport: hostTransport,
      loginResult: {
        content: [],
        _meta: {
          cua: {
            sessionId: "session",
            requestId: "request",
            token: "private-token",
          },
        },
      },
      callPrivateTool: async () => ({
        content: [],
        _meta: { cua: { status: "submitted", continuation: receipt } },
      }),
      enqueueUserMessage: async (message: any, options: any) => {
        queued.push({ message, options });
        if (fail) throw Error("Lost acknowledgement");
      },
    });
    const app = new App(
      { name: "login-test", version: "1" },
      {},
      { autoResize: false },
    );
    try {
      await app.connect(viewTransport);
      assert.equal((await app.sendMessage(receipt)).isError, true);
      assert.equal(queued.length, 0);
      await app.callServerTool({
        name: "cua_ui_login_answer",
        arguments: {
          sessionId: "session",
          requestId: "request",
          action: "submit",
          values: { pass: "synthetic-private" },
        },
      });
      assert.equal(
        (
          await app.sendMessage({
            role: "user",
            content: [{ type: "text", text: "synthetic-private" }],
          })
        ).isError,
        true,
      );
      const results = await Promise.all([
        app.sendMessage(receipt),
        app.sendMessage(receipt),
      ]);
      assert.equal(queued.length, 1);
      assert.equal(results[0].isError === true, fail);
      assert.equal(results[1].isError === true, fail);
      assert.equal(
        queued[0].options.idempotencyKey,
        "cua-login:session:request",
      );
      assert.ok(!JSON.stringify(queued).includes("synthetic-private"));
      assert.ok(!JSON.stringify(queued).includes("private-token"));
    } finally {
      await app.close();
      await bridge.close();
    }
  });
}

test("secure form host binds authority and wakes only from settled server receipt", async () => {
  const [hostTransport, viewTransport] = InMemoryTransport.createLinkedPair();
  const queued: any[] = [];
  const calls: any[] = [];
  let settled = false;
  const receipt = {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Inspect secure request; never replay." },
    ],
  };
  const bridge = await bridges.attachCUASecureForm({
    transport: hostTransport,
    formResult: {
      content: [],
      _meta: {
        cua: {
          sessionId: "s",
          requestId: "r",
          token: "private-token",
          status: "pending",
        },
      },
    },
    callPrivateTool: async (name: string, args: any) => {
      calls.push({ name, args });
      return {
        content: [],
        _meta: {
          cua: {
            status: settled ? "filled" : "accepted",
            continuation: receipt,
          },
        },
      };
    },
    enqueueUserMessage: async (message: any, options: any) => {
      queued.push({ message, options });
    },
  });
  const app = new App(
    { name: "test-secure", version: "1" },
    {},
    { autoResize: false },
  );
  try {
    await app.connect(viewTransport);
    await app.callServerTool({
      name: "cua_ui_secure_form_answer",
      arguments: {
        sessionId: "s",
        requestId: "r",
        token: "replacement",
        action: "submit",
        submissionId: "opaque",
        schemaRevision: "rev",
        values: { name: "private-name" },
      },
    });
    assert.equal(calls[0].args.token, "private-token");
    assert.equal((await app.sendMessage(receipt)).isError, true);
    for (const [name, requestId] of [
      ["cua_ui_input", "r"],
      ["cua_ui_secure_form_state", "other"],
    ])
      await assert.rejects(
        app.callServerTool({ name, arguments: { sessionId: "s", requestId } }),
      );
    settled = true;
    await app.callServerTool({
      name: "cua_ui_secure_form_state",
      arguments: { sessionId: "s", requestId: "r" },
    });
    assert.equal(
      (
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text: "private-name" }],
        })
      ).isError,
      true,
    );
    await Promise.all([app.sendMessage(receipt), app.sendMessage(receipt)]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].options.idempotencyKey, "cua-secure-form:s:r");
    assert.ok(!JSON.stringify(queued).includes("private-name"));
    assert.ok(!JSON.stringify(queued).includes("private-token"));
  } finally {
    await app.close();
    await bridge.close();
  }
});
