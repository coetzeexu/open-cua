// Explicit browser acceptance, callable from a local harness against a remote sandbox.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
assert.equal(
  process.env.CUA_HTTP_SMOKE,
  "1",
  "Explicitly enable the browser acceptance run.",
);
const url = new URL(process.env.CUA_MCP_URL);
const token = process.env.CUA_MCP_TOKEN;
assert.ok(token?.length >= 32, "Inject the gateway token privately");
const directory = resolve(
  process.env.CUA_HTTP_EVIDENCE ?? "artifacts/http-verified",
);
await mkdir(directory, { recursive: true });
const report = {
  success: false,
  time: new Date().toISOString(),
  clientPlatform: process.platform,
  checks: [],
};
const headers = { Authorization: `Bearer ${token}` };
let client, transport;
const connect = async (sessionId) => {
  client = new Client({ name: "remote-cua-harness", version: "1" });
  transport = new StreamableHTTPClientTransport(url, {
    sessionId,
    requestInit: { headers },
  });
  await client.connect(transport);
};
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `Tool ${name} failed`);
  return response.structuredContent;
};
const done = async (result, sessionId) => {
  const output = [...result.output];
  while (result.status === "running") {
    result = await call("cua_poll", {
      sessionId,
      executionId: result.executionId,
      cursor: result.cursor,
      waitMs: 1000,
    });
    output.push(...result.output);
  }
  assert.equal(result.status, "succeeded");
  return { ...result, output };
};
try {
  assert.equal((await fetch(url)).status, 401);
  await connect();
  assert.equal((await client.listTools()).tools.length, 7);
  const { sessionId } = await call("cua_session_create", {
    profile: "sandbox",
  });
  report.checks.push(
    "Bearer authentication, seven tools, explicit sandbox CUA session",
  );
  const fixture = `<!doctype html><meta charset="utf-8"><title>HTTP MCP fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value;document.querySelector('#count').textContent=++window.n">Apply</button><output></output><div id="count">0</div><script>window.n=0</script>`;
  let r = await done(
    await call("cua_exec", {
      sessionId,
      code: `var b=await cua.connect();var t=await b.tabs.create({url:${JSON.stringify("data:text/html," + encodeURIComponent(fixture))}});output.json(await t.ax.snapshot());output.json(await t.evaluate(()=>({platform:navigator.platform,title:document.title})));`,
    }),
    sessionId,
  );
  const info = JSON.parse(r.output.at(-1).text);
  report.browserPlatform = info.platform;
  assert.equal(info.title, "HTTP MCP fixture");
  if (process.env.CUA_EXPECT_BROWSER_PLATFORM)
    assert.equal(info.platform, process.env.CUA_EXPECT_BROWSER_PLATFORM);
  const args = {
    sessionId,
    requestId: "apply-once",
    code: `await t.getByRole('textbox',{name:'Name'}).fill('remote mock message');await t.getByRole('button',{name:'Apply',exact:true}).click();output.json(await t.ax.snapshot());`,
  };
  const first = await call("cua_exec", args);
  const mcpId = transport.sessionId;
  await client.close();
  await connect(mcpId);
  r = await done(await call("cua_exec", args), sessionId);
  assert.equal(r.executionId, first.executionId);
  assert.ok(r.output.some((o) => o.text?.includes("remote mock message")));
  r = await done(
    await call("cua_exec", {
      sessionId,
      code: `output.json(await t.evaluate(()=>Number(document.querySelector('#count').textContent)));`,
    }),
    sessionId,
  );
  assert.equal(JSON.parse(r.output[0].text), 1);
  report.checks.push(
    "local harness navigates, observes and inputs through remote internal browser; reconnect deduplicates action",
  );
  const pending = await call("cua_exec", {
    sessionId,
    code: `await new Promise(r=>setTimeout(r,30000));await t.getByRole('button',{name:'Apply'}).click();`,
  });
  assert.equal(pending.status, "running");
  await call("cua_cancel", { sessionId, executionId: pending.executionId });
  const cancelled = await call("cua_poll", {
    sessionId,
    executionId: pending.executionId,
    waitMs: 0,
  });
  assert.equal(cancelled.status, "cancelled");
  await call("cua_reset", { sessionId });
  r = await done(
    await call("cua_exec", {
      sessionId,
      code: `var b=await cua.connect();var t=(await b.tabs.list())[0];output.json(await t.evaluate(()=>Number(document.querySelector('#count').textContent)));`,
    }),
    sessionId,
  );
  assert.equal(JSON.parse(r.output[0].text), 1);
  report.checks.push(
    "explicit cancel stops trailing action; REPL reset retains browser tab and reacquires handles",
  );
  await transport.terminateSession();
  assert.equal(
    (await fetch(url, { headers: { ...headers, "Mcp-Session-Id": mcpId } }))
      .status,
    404,
  );
  report.checks.push(
    "DELETE ends MCP session and invalidates subsequent requests",
  );
  report.success = true;
} finally {
  try {
    await transport?.terminateSession();
  } catch {}
  await client?.close();
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
