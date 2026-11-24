import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CUAService, PendingUserChannel } from "@cua/service";
import { startHttpGateway } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import type { HumanBrowserView } from "@cua/contracts";
import { MCPApps } from "../packages/mcp/src/apps.js";
const MIME = "text/html;profile=mcp-app";
async function fixture(viewOverrides: Partial<HumanBrowserView> = {}) {
  const provider = new FakeBrowserProvider();
  const events: string[] = [];
  const human = new PendingUserChannel();
  Object.assign(provider.connection, {
    async openHumanView(tabId: string): Promise<HumanBrowserView> {
      await provider.connection.get(tabId);
      return {
        capture: async () => ({
          data: "private-frame",
          id: 1,
          width: 640,
          height: 480,
        }),
        input: async (a) => {
          events.push(a.type);
        },
        release: async () => {
          events.push("release");
        },
        close: async () => {
          events.push("close");
        },
        ...viewOverrides,
      };
    },
  });
  const connect = provider.connect.bind(provider);
  const openHumanView = (provider.connection as any).openHumanView;
  provider.connect = async () => {
    const connection = await connect();
    Object.assign(connection, { openHumanView });
    return connection;
  };
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    executeWaitMs: 0,
    terminationGraceMs: 10,
    userChannel: human,
  });
  const gateway = await startHttpGateway(service, {
    token: "x".repeat(64),
    port: 0,
    apps: true,
  });
  const address = gateway.server.address() as { port: number };
  const peers: Client[] = [];
  async function peer(apps = true) {
    const client = new Client({ name: "test-host", version: "1" }, {
      capabilities: apps
        ? {
            extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } },
          }
        : {},
    } as any);
    peers.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${"x".repeat(64)}` } },
      },
    );
    await client.connect(transport);
    return { client, transport };
  }
  async function close() {
    await Promise.allSettled(peers.map((c) => c.close()));
    await gateway.close();
    await service.close();
  }
  return { provider, events, service, human, peer, close };
}
async function call(c: Client, name: string, args: any) {
  return c.callTool({ name, arguments: args }) as Promise<any>;
}
async function boot(c: Client) {
  const created = await call(c, "cua_session_create", { profile: "fake" });
  const sessionId = created.structuredContent.sessionId;
  let r = (
    await call(c, "cua_exec", {
      sessionId,
      code: "var b=await cua.connect();var t=await b.tabs.create();output.text(t.id);",
    })
  ).structuredContent;
  while (r.status === "running")
    r = (
      await call(c, "cua_poll", {
        sessionId,
        executionId: r.executionId,
        waitMs: 1000,
      })
    ).structuredContent;
  assert.equal(r.status, "succeeded");
  return { sessionId, tabId: r.output[0].text };
}
test("MCP Apps capability fallback, private grant and shared control through HTTP", async () => {
  const f = await fixture();
  try {
    const { client, transport } = await f.peer();
    const plain = await f.peer(false);
    assert.equal((await plain.client.listTools()).tools.length, 8);
    assert.equal((await plain.client.listResources()).resources.length, 0);
    assert.equal(
      (await call(plain.client, "cua_view", { sessionId: "x", tabId: "x" }))
        .isError,
      true,
    );
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 21);
    assert.deepEqual(
      (tools.find((t) => t.name === "cua_ui_input")!._meta as any).ui
        .visibility,
      ["app"],
    );
    const resource = await client.readResource({
      uri: "ui://cua/browser.html",
    });
    assert.equal(resource.contents[0].mimeType, MIME);
    assert.ok(
      String((resource.contents[0] as any).text).includes("取得控制权"),
    );
    assert.ok(
      !String((resource.contents[0] as any).text).includes("__APP_SCRIPT__"),
    );
    const ids = await boot(client);
    const viewed = await call(client, "cua_view", ids);
    const access = { sessionId: ids.sessionId, token: viewed._meta.cua.token };
    assert.ok(access.token);
    assert.ok(!JSON.stringify(viewed.structuredContent).includes(access.token));
    assert.ok(!JSON.stringify(viewed.content).includes(access.token));
    assert.equal(
      (await call(plain.client, "cua_ui_frame", access)).isError,
      true,
    );
    const stranger = await f.peer();
    assert.equal(
      (await call(stranger.client, "cua_ui_frame", access)).isError,
      true,
    );
    assert.equal(
      (await call(client, "cua_ui_frame", { ...access, token: "0".repeat(64) }))
        .isError,
      true,
    );
    const frame = await call(client, "cua_ui_frame", access);
    assert.equal(frame._meta.cua.data, "private-frame");
    assert.deepEqual(frame.content, []);
    assert.equal(
      (
        await call(client, "cua_ui_input", {
          ...access,
          input: { frameId: 1, type: "text", text: "secret" },
        })
      ).isError,
      true,
    );
    const pending = (
      await call(client, "cua_exec", {
        sessionId: ids.sessionId,
        code: 'await new Promise(r=>setTimeout(r,5000));output.text("should not run")',
      })
    ).structuredContent;
    const take = await call(client, "cua_ui_control", {
      ...access,
      action: "take",
    });
    assert.equal(take._meta.cua.status.control, "human");
    assert.equal(
      (
        await call(client, "cua_poll", {
          sessionId: ids.sessionId,
          executionId: pending.executionId,
        })
      ).structuredContent.status,
      "cancelled",
    );
    assert.equal(
      (
        await call(client, "cua_exec", {
          sessionId: ids.sessionId,
          code: 'output.text("blocked")',
        })
      ).isError,
      true,
    );
    const result = await call(client, "cua_ui_input", {
      ...access,
      input: { frameId: 1, type: "text", text: "secret" },
    });
    assert.ok(!result.isError);
    assert.ok(!JSON.stringify(result).includes("secret"));
    assert.ok(f.events.includes("text"));
    assert.equal(
      (await call(client, "cua_ui_control", { ...access, action: "interrupt" }))
        ._meta.cua.status.control,
      "paused",
    );
    assert.equal(
      (await call(client, "cua_ui_control", { ...access, action: "resume" }))
        ._meta.cua.status.control,
      "agent",
    );
    const reopened = await call(client, "cua_view", ids);
    assert.notEqual(reopened._meta.cua.token, access.token);
    assert.equal((await call(client, "cua_ui_frame", access)).isError, true);
    await transport.terminateSession();
    assert.ok(f.events.filter((e) => e === "close").length >= 2);
    assert.equal(f.service.status().length, 0);
  } finally {
    await f.close();
  }
});
test("private credential replies are scoped, single-use, and do not echo values", async () => {
  const f = await fixture();
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    const v = await call(client, "cua_view", ids);
    const access = { sessionId: ids.sessionId, token: v._meta.cua.token };
    const abort = new AbortController();
    const request = {
      id: "otp-request",
      sessionId: ids.sessionId,
      origin: "https://example.test",
      fields: [{ id: "otp", label: "手机验证码", type: "otp" }],
      expiresAt: Date.now() + 5000,
    };
    const answer = f.human.collectCredentials(request, abort.signal);
    const state = await call(client, "cua_ui_state", access);
    assert.equal(state._meta.cua.requests[0].id, request.id);
    assert.deepEqual(state.content, []);
    const r = await call(client, "cua_ui_answer", {
      ...access,
      requestId: request.id,
      action: "submit",
      values: { otp: "synthetic-123" },
    });
    assert.ok(!r.isError);
    assert.ok(!JSON.stringify(r).includes("synthetic-123"));
    assert.deepEqual(await answer, {
      action: "accept",
      values: { otp: "synthetic-123" },
    });
    assert.equal(
      (
        await call(client, "cua_ui_answer", {
          ...access,
          requestId: request.id,
          action: "submit",
          values: { otp: "replay" },
        })
      ).isError,
      true,
    );
    const other = f.human
      .collectCredentials(
        { ...request, id: "other", sessionId: "not-owned" },
        abort.signal,
      )
      .catch(() => {});
    assert.equal(
      (
        await call(client, "cua_ui_answer", {
          ...access,
          requestId: "other",
          action: "decline",
        })
      ).isError,
      true,
    );
    abort.abort();
    await other;
  } finally {
    await f.close();
  }
});
test("expired panel grants revoke view without returning control to model", async () => {
  const f = await fixture();
  let apps: MCPApps | undefined;
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    apps = new MCPApps(f.service, (id) => id === ids.sessionId, 30);
    const result: any = await apps.call("cua_view", ids);
    const access = { sessionId: ids.sessionId, token: result._meta.cua.token };
    await f.service.interruptSession({
      sessionId: ids.sessionId,
      takeControl: true,
    });
    await new Promise((r) => setTimeout(r, 65));
    assert.equal(
      ((await apps.call("cua_ui_frame", access)) as any).isError,
      true,
    );
    assert.ok(f.events.includes("close"));
    assert.equal(f.service.status()[0].control, "human");
    const recovered: any = await apps.call("cua_ui_recover", {
      sessionId: ids.sessionId,
      token: result._meta.cua.recoveryToken,
    });
    assert.ok(!recovered.isError);
    assert.equal(recovered._meta.cua.tabId, ids.tabId);
  } finally {
    await apps?.close();
    await f.close();
  }
});

test("stalled panel capture cannot block interruption, takeover or state and does not multiply captures", async () => {
  let finish!: (
    frame: Awaited<ReturnType<HumanBrowserView["capture"]>>,
  ) => void;
  let started!: () => void;
  const capturing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let captures = 0;
  const f = await fixture({
    capture: () => {
      captures++;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  let apps: MCPApps | undefined;
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    apps = new MCPApps(f.service, (id) => id === ids.sessionId, 60000, 100);
    const viewed: any = await apps.call("cua_view", ids);
    const access = { sessionId: ids.sessionId, token: viewed._meta.cua.token };
    const shot = apps.call("cua_ui_frame", access);
    await capturing;
    for (const [action, expected] of [
      ["interrupt", "paused"],
      ["take", "human"],
    ]) {
      const control: any = await apps.call("cua_ui_control", {
        ...access,
        action,
      });
      assert.equal(control._meta.cua.status.control, expected);
      assert.equal(
        (
          await call(client, "cua_exec", {
            sessionId: ids.sessionId,
            code: 'output.text("must not execute")',
          })
        ).isError,
        true,
      );
    }
    const state: any = await apps.call("cua_ui_state", access);
    assert.equal(state._meta.cua.status.control, "human");
    assert.equal(((await shot) as any).isError, true);
    assert.equal(
      ((await apps.call("cua_ui_frame", access)) as any).isError,
      true,
    );
    assert.equal(captures, 1);
    finish({ id: 1, width: 10, height: 10, data: "late-frame" });
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = apps.call("cua_ui_frame", access);
    assert.equal(captures, 2);
    finish({ id: 2, width: 10, height: 10, data: "fresh-frame" });
    assert.equal(((await fresh) as any)._meta.cua.data, "fresh-frame");
  } finally {
    await apps?.close();
    await f.close();
  }
});

test("panel close revokes authority during capture and discards its late frame", async () => {
  let finish!: (
    frame: Awaited<ReturnType<HumanBrowserView["capture"]>>,
  ) => void;
  const f = await fixture({
    capture: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  let apps: MCPApps | undefined;
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    apps = new MCPApps(f.service, (id) => id === ids.sessionId);
    const viewed: any = await apps.call("cua_view", ids);
    const access = { sessionId: ids.sessionId, token: viewed._meta.cua.token };
    const shot = apps.call("cua_ui_frame", access);
    const closed: any = await apps.call("cua_ui_control", {
      ...access,
      action: "close",
    });
    assert.ok(!closed.isError);
    assert.ok(f.events.includes("close"));
    finish({ id: 1, width: 10, height: 10, data: "must-not-deliver" });
    const late: any = await shot;
    assert.equal(late.isError, true);
    assert.ok(!JSON.stringify(late).includes("must-not-deliver"));
  } finally {
    await apps?.close();
    await f.close();
  }
});

test("panel recovery rotates authority and recreates a collected session", async () => {
  const f = await fixture();
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    const opened = await call(client, "cua_view", ids);
    const recovery = {
      sessionId: ids.sessionId,
      token: opened._meta.cua.recoveryToken,
    };
    assert.equal(
      (
        await call(client, "cua_ui_recover", {
          ...recovery,
          token: "0".repeat(64),
        })
      ).isError,
      true,
    );
    const resumed = await call(client, "cua_ui_recover", recovery);
    assert.equal(resumed._meta.cua.recreated, false);
    assert.equal(resumed._meta.cua.tabId, ids.tabId);
    assert.equal(
      (await call(client, "cua_ui_recover", recovery)).isError,
      true,
    );
    await f.service.closeSession({ sessionId: ids.sessionId });
    const fresh = await call(client, "cua_ui_recover", {
      sessionId: ids.sessionId,
      token: resumed._meta.cua.recoveryToken,
    });
    assert.ok(!fresh.isError);
    assert.equal(fresh._meta.cua.recreated, true);
    assert.notEqual(fresh._meta.cua.sessionId, ids.sessionId);
    assert.deepEqual(fresh.content, []);
    const state = await call(client, "cua_ui_state", {
      sessionId: fresh._meta.cua.sessionId,
      token: fresh._meta.cua.token,
    });
    assert.equal(state._meta.cua.status.control, "agent");
  } finally {
    await f.close();
  }
});

test("login card fills bound fields through a running auth execution without browser control", async () => {
  const f = await fixture();
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    const page = f.provider.connection.pages[0];
    page.url = "https://login.test/form";
    page.sensitive.add("#pass");
    let execution = (
      await call(client, "cua_exec", {
        sessionId: ids.sessionId,
        code: `output.json(await t.auth.request({fields:[
        {id:"account",label:"账号",type:"username",target:t.locator("#user").target},
        {id:"password",label:"密码",type:"password",target:t.locator("#pass").target}
      ],submit:{target:t.locator("#login").target}}));`,
      })
    ).structuredContent;
    const deadline = Date.now() + 5000;
    while (!f.service.humanRequests(ids.sessionId).length) {
      assert.ok(Date.now() < deadline);
      execution = (
        await call(client, "cua_poll", {
          sessionId: ids.sessionId,
          executionId: execution.executionId,
          waitMs: 100,
        })
      ).structuredContent;
      assert.equal(execution.status, "running");
    }
    const requestId = f.service.humanRequests(ids.sessionId)[0].id;
    const resource = await client.readResource({ uri: "ui://cua/login.html" });
    assert.ok(
      String((resource.contents[0] as any).text).includes("账号密码登录"),
    );
    assert.ok(
      !String((resource.contents[0] as any).text).includes("__APP_SCRIPT__"),
    );
    const login = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId,
    });
    assert.ok(!login.isError);
    const access = {
      sessionId: ids.sessionId,
      requestId,
      token: login._meta.cua.token,
    };
    assert.ok(
      !JSON.stringify([login.content, login.structuredContent]).includes(
        access.token,
      ),
    );
    assert.equal(f.service.status()[0].control, "agent");
    assert.equal(f.events.length, 0);
    const stranger = await f.peer();
    assert.equal(
      (
        await call(stranger.client, "cua_ui_login_answer", {
          ...access,
          action: "submit",
          values: { account: "private-account", password: "private-pass" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...access,
          requestId: "wrong",
          action: "decline",
        })
      ).isError,
      true,
    );
    assert.equal((await call(client, "cua_ui_frame", access)).isError, true);
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...access,
          action: "submit",
          values: { account: "private-account" },
        })
      ).isError,
      true,
    );
    assert.equal(page.filled.size, 0);
    const submitted = await call(client, "cua_ui_login_answer", {
      ...access,
      action: "submit",
      values: { account: "private-account", password: "private-pass" },
    });
    assert.equal(submitted._meta.cua.status, "submitted");
    const receipt = submitted._meta.cua.continuation;
    assert.equal(receipt.role, "user");
    assert.ok(receipt.content[0].text.includes(execution.executionId));
    assert.ok(receipt.content[0].text.includes(ids.sessionId));
    assert.ok(receipt.content[0].text.includes(requestId));
    assert.ok(!JSON.stringify(receipt).includes(access.token));
    assert.ok(!JSON.stringify(receipt).includes("private-account"));
    assert.ok(!JSON.stringify(receipt).includes("private-pass"));

    assert.ok(!JSON.stringify(submitted).includes("private-pass"));
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...access,
          action: "submit",
          values: { account: "replay", password: "replay" },
        })
      ).isError,
      true,
    );
    do {
      execution = (
        await call(client, "cua_poll", {
          sessionId: ids.sessionId,
          executionId: execution.executionId,
          waitMs: 1000,
        })
      ).structuredContent;
    } while (execution.status === "running");
    assert.equal(execution.status, "succeeded");
    assert.equal(page.filled.get("#user"), "private-account");
    assert.equal(page.filled.get("#pass"), "private-pass");
    assert.ok(!JSON.stringify(execution).includes("private-pass"));
    assert.ok(!JSON.stringify(execution).includes("private-account"));
    assert.equal(
      (await call(client, "cua_ui_login_state", access))._meta.cua.status,
      "submitted",
    );
    // Taking over cancels the real waiting SDK request, invalidating its card.
    const waiting = (
      await call(client, "cua_exec", {
        sessionId: ids.sessionId,
        code: 'await t.auth.request({fields:[{id:"pass",label:"Password",type:"password",target:t.locator("#pass").target}]});',
      })
    ).structuredContent;
    const end = Date.now() + 5000;
    while (!f.service.humanRequests(ids.sessionId).length) {
      assert.ok(Date.now() < end);
      await new Promise((r) => setTimeout(r, 10));
    }
    const nextId = f.service.humanRequests(ids.sessionId)[0].id;
    const next = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId: nextId,
    });
    const nextAccess = {
      sessionId: ids.sessionId,
      requestId: nextId,
      token: next._meta.cua.token,
    };
    const panel = await call(client, "cua_view", ids);
    await call(client, "cua_ui_control", {
      sessionId: ids.sessionId,
      token: panel._meta.cua.token,
      action: "take",
    });
    assert.equal(
      (
        await call(client, "cua_poll", {
          sessionId: ids.sessionId,
          executionId: waiting.executionId,
        })
      ).structuredContent.status,
      "cancelled",
    );
    assert.equal(
      (await call(client, "cua_ui_login_state", nextAccess))._meta.cua.status,
      "expired",
    );
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...nextAccess,
          action: "submit",
          values: { pass: "late" },
        })
      ).isError,
      true,
    );
    assert.equal(page.filled.get("#pass"), "private-pass");
  } finally {
    await f.close();
  }
});

test("login grants expire, rotate, cancel and remain independent of browser panel grants", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const { client } = await f.peer();
    const ids = await boot(client);
    const request = {
      id: "login-one",
      sessionId: ids.sessionId,
      origin: "https://login.test",
      fields: [{ id: "pass", label: "Password", type: "password" }],
      expiresAt: Date.now() + 10000,
    };
    const answer = f.human.collectCredentials(request, abort.signal);
    const first = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId: request.id,
    });
    const second = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId: request.id,
    });
    const access = {
      sessionId: ids.sessionId,
      requestId: request.id,
      token: second._meta.cua.token,
    };
    assert.equal(
      (
        await call(client, "cua_ui_login_state", {
          ...access,
          token: first._meta.cua.token,
        })
      ).isError,
      true,
    );
    const panel = await call(client, "cua_view", ids);
    assert.equal(
      (await call(client, "cua_ui_login_state", access))._meta.cua.status,
      "pending",
    );
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...access,
          token: panel._meta.cua.token,
          action: "decline",
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...access,
          action: "decline",
        })
      )._meta.cua.status,
      "cancelled",
    );
    assert.deepEqual(await answer, { action: "decline" });
    const pending = f.human
      .collectCredentials({ ...request, id: "aborted" }, abort.signal)
      .catch(() => {});
    const card = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId: "aborted",
    });
    abort.abort();
    await pending;
    const expired = {
      sessionId: ids.sessionId,
      requestId: "aborted",
      token: card._meta.cua.token,
    };
    assert.equal(
      (await call(client, "cua_ui_login_state", expired))._meta.cua.status,
      "expired",
    );
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          ...expired,
          action: "submit",
          values: { pass: "late" },
        })
      ).isError,
      true,
    );
    const otpAbort = new AbortController();
    const otp = f.human
      .collectCredentials(
        {
          ...request,
          id: "otp-only",
          fields: [{ id: "otp", label: "SMS code", type: "otp" }],
        },
        otpAbort.signal,
      )
      .catch(() => {});
    assert.equal(
      (
        await call(client, "cua_login", {
          sessionId: ids.sessionId,
          requestId: "otp-only",
        })
      ).isError,
      true,
    );
    otpAbort.abort();
    await otp;
    const ttlAbort = new AbortController();
    const ttl = f.human
      .collectCredentials(
        { ...request, id: "ttl", expiresAt: Date.now() + 100 },
        ttlAbort.signal,
      )
      .catch(() => {});
    const timed = await call(client, "cua_login", {
      sessionId: ids.sessionId,
      requestId: "ttl",
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      (
        await call(client, "cua_ui_login_answer", {
          sessionId: ids.sessionId,
          requestId: "ttl",
          token: timed._meta.cua.token,
          action: "submit",
          values: { pass: "late" },
        })
      ).isError,
      true,
    );
    ttlAbort.abort();
    await ttl;
  } finally {
    abort.abort();
    await f.close();
  }
});
