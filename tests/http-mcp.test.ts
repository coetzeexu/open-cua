import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CUAService } from "@cua/service";
import { startHttpGateway } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setup(options: Record<string, number> = {}) {
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: new FakeBrowserProvider(),
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    executeWaitMs: 0,
  });
  const token = randomBytes(32).toString("hex");
  const gateway = await startHttpGateway(service, {
    token,
    port: 0,
    ...options,
  });
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const peers: { client: Client; transport: StreamableHTTPClientTransport }[] =
    [];
  const peer = async (sessionId?: string) => {
    const client = new Client({ name: "http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, {
      sessionId,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    peers.push({ client, transport });
    await client.connect(transport);
    return { client, transport };
  };
  const request = (
    method: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const close = async () => {
    await Promise.allSettled(peers.map((p) => p.client.close()));
    await gateway.close();
    await service.close();
  };
  return { service, gateway, url, token, peer, request, close };
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r));
  return r.structuredContent as any;
}
async function done(client: Client, result: any, sessionId?: string) {
  const output = [...result.output];
  while (result.status === "running") {
    result = await call(client, "cua_poll", {
      sessionId,
      executionId: result.executionId,
      cursor: result.cursor,
      waitMs: 1000,
    });
    output.push(...result.output);
  }
  return { ...result, output };
}
test("HTTP rejects unauthenticated, foreign origin/host, malformed and oversized requests without sessions", async () => {
  const s = await setup({ maxBodyBytes: 1024 });
  try {
    for (const method of ["GET", "POST", "DELETE"])
      assert.equal(
        (await s.request(method, { Authorization: "Bearer wrong" })).status,
        401,
      );
    assert.equal(
      (await s.request("GET", { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      await new Promise<number>((resolve, reject) => {
        const r = httpRequest(
          s.url,
          {
            headers: {
              Host: "evil.example",
              Authorization: `Bearer ${s.token}`,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        r.on("error", reject);
        r.end();
      }),
      403,
    );
    assert.equal((await s.request("GET")).status, 400);
    assert.equal(
      (
        await s.request(
          "POST",
          {},
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
        )
      ).status,
      400,
    );
    assert.equal(
      (await s.request("POST", {}, { data: "x".repeat(2048) })).status,
      413,
    );
    assert.equal(
      (await s.request("GET", { "Mcp-Session-Id": "missing" })).status,
      404,
    );
    assert.equal(s.gateway.connectionCount(), 0);
    assert.equal(s.service.status().length, 0);
  } finally {
    await s.close();
  }
});
test("HTTP sessions retain REPL on reconnect, deduplicate lost responses and isolate CUA ownership", async () => {
  const s = await setup();
  try {
    const a = await s.peer();
    assert.equal((await a.client.listTools()).tools.length, 8);
    const created = await call(a.client, "cua_session_create", {
      profile: "fake",
    });
    assert.ok(created.api);
    const sessionId = created.sessionId;
    const args = {
      sessionId,
      requestId: "once",
      code: 'var n=(typeof n === "undefined" ? 0 : n)+1;await new Promise(r=>setTimeout(r,200));output.json(n);',
    };
    const first = await call(a.client, "cua_exec", args);
    assert.equal(first.status, "running");
    const id = a.transport.sessionId;
    assert.ok(id);
    await a.client.close();
    const resumed = await s.peer(id);
    const repeated = await call(resumed.client, "cua_exec", args);
    assert.equal(first.executionId, repeated.executionId);
    const result = await done(resumed.client, repeated, sessionId);
    assert.equal(result.output.at(-1).text, "1");
    const other = await s.peer();
    const unauthorized = await other.client.callTool({
      name: "cua_exec",
      arguments: { sessionId, code: "output.text(n)" },
    });
    assert.equal(unauthorized.isError, true);
    const state = await done(
      resumed.client,
      await call(resumed.client, "cua_exec", {
        sessionId,
        code: "output.json(n);",
      }),
      sessionId,
    );
    assert.equal(state.output[0].text, "1");
    await resumed.transport.terminateSession();
    assert.equal(s.service.status().length, 0);
    assert.equal(
      (await s.request("GET", { "Mcp-Session-Id": id })).status,
      404,
    );
  } finally {
    await s.close();
  }
});
test("HTTP takeover gates the same Service session and does not add model control tools", async () => {
  const s = await setup();
  try {
    const p = await s.peer();
    const { sessionId } = await call(p.client, "cua_session_create", {
      profile: "fake",
    });
    await done(
      p.client,
      await call(p.client, "cua_exec", {
        sessionId,
        code: "var b=await cua.connect();var t=await b.tabs.create();",
      }),
      sessionId,
    );
    const running = await call(p.client, "cua_exec", {
      sessionId,
      code: 'await new Promise(r=>setTimeout(r,5000));await t.getByRole("button").click();',
    });
    await s.service.interruptSession({ sessionId, takeControl: true });
    const cancelled = await call(p.client, "cua_poll", {
      sessionId,
      executionId: running.executionId,
      waitMs: 0,
    });
    assert.equal(cancelled.status, "cancelled");
    const blocked = await p.client.callTool({
      name: "cua_exec",
      arguments: { sessionId, code: 'output.text("blocked")' },
    });
    assert.equal(blocked.isError, true);
    assert.equal(
      (await p.client.listTools()).tools.some((t) =>
        /resume|interrupt|control/.test(t.name),
      ),
      false,
    );
    await s.service.resumeSession({ sessionId });
    const result = await done(
      p.client,
      await call(p.client, "cua_exec", {
        sessionId,
        code: "output.text(typeof b);",
      }),
      sessionId,
    );
    assert.equal(result.output[0].text, "undefined");
  } finally {
    await s.close();
  }
});
test("idle HTTP sessions expire but active executions survive, DELETE cancels and frees resources", async () => {
  const s = await setup({ idleMs: 150, maxConnections: 1 });
  try {
    const p = await s.peer();
    const { sessionId } = await call(p.client, "cua_session_create", {
      profile: "fake",
    });
    const r = await call(p.client, "cua_exec", {
      sessionId,
      code: 'await new Promise(r=>setTimeout(r,700));output.text("done");',
    });
    await sleep(300);
    assert.equal(s.gateway.connectionCount(), 1);
    await assert.rejects(s.peer());
    assert.equal(s.gateway.connectionCount(), 1);
    await done(p.client, r, sessionId);
    const id = p.transport.sessionId!;
    await p.client.close();
    for (let i = 0; i < 40 && s.gateway.connectionCount(); i++) await sleep(25);
    assert.equal(s.gateway.connectionCount(), 0);
    assert.equal(s.service.status().length, 0);
    assert.equal(
      (await s.request("GET", { "Mcp-Session-Id": id })).status,
      404,
    );
    const q = await s.peer();
    await call(q.client, "cua_exec", {
      code: "await new Promise(r=>setTimeout(r,5000));",
    });
    await q.transport.terminateSession();
    assert.equal(s.service.status().length, 0);
  } finally {
    await s.close();
  }
});

test("HTTP idle grace starts after a long poll response completes", async () => {
  const s = await setup({ idleMs: 200 });
  try {
    const p = await s.peer();
    const { sessionId } = await call(p.client, "cua_session_create", {
      profile: "fake",
    });
    const execution = await done(
      p.client,
      await call(p.client, "cua_exec", {
        sessionId,
        code: 'output.text("done")',
      }),
      sessionId,
    );
    const original = s.service.getExecution.bind(s.service);
    s.service.getExecution = async (args) => {
      await sleep(350);
      return original(args);
    };
    const result = await call(p.client, "cua_poll", {
      sessionId,
      executionId: execution.executionId,
      waitMs: 1000,
    });
    assert.equal(result.status, "succeeded");
    await sleep(125);
    assert.equal(s.gateway.connectionCount(), 1);
    assert.equal((await p.client.listTools()).tools.length, 8);
    await p.client.close();
    for (let i = 0; i < 40 && s.gateway.connectionCount(); i++) await sleep(25);
    assert.equal(s.gateway.connectionCount(), 0);
  } finally {
    await s.close();
  }
});

test("capacity reclaims empty discovery clients but preserves browser owners", async () => {
  const s = await setup({ maxConnections: 2 });
  try {
    const owner = await s.peer();
    await call(owner.client, "cua_describe");
    let empty = await s.peer();
    for (let i = 0; i < 10; i++) {
      const expired = empty.transport.sessionId!;
      await empty.client.ping();
      empty = await s.peer();
      assert.equal(s.gateway.connectionCount(), 2);
      assert.equal(
        (await s.request("GET", { "Mcp-Session-Id": expired })).status,
        404,
      );
      assert.equal(
        (await call(owner.client, "cua_describe")).workerAlive,
        true,
      );
    }
  } finally {
    await s.close();
  }
});

test("ping does not prevent an empty HTTP transport from idle expiry", async () => {
  const s = await setup({ idleMs: 150 });
  try {
    const p = await s.peer();
    const id = p.transport.sessionId!;
    const heartbeat = setInterval(() => {
      void p.client.ping().catch(() => {});
    }, 20);
    try {
      for (let i = 0; i < 40 && s.gateway.connectionCount(); i++)
        await sleep(25);
      assert.equal(s.gateway.connectionCount(), 0);
      assert.equal(
        (await s.request("GET", { "Mcp-Session-Id": id })).status,
        404,
      );
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await s.close();
  }
});

test("concurrent admission never exceeds transport capacity", async () => {
  const s = await setup({ maxConnections: 1 });
  try {
    await s.peer();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => s.peer()),
    );
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.ok(s.gateway.connectionCount() <= 1);
  } finally {
    await s.close();
  }
});
