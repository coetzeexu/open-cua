// Opt-in: dedicated initialized AgentBay session. The caller owns its lifecycle.
// Tests real Chromium + bundled App with a simulated AppBridge host, not native host UX.
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentBayBrowserProvider } from "@cua/browser-agentbay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Window } from "happy-dom";
import { attachCUASecureForm } from "../examples/harness-app-bridge.mjs";
import { fieldIds } from "./fixtures/secure-form-cloud.mjs";

const key = process.env.AGENTBAY_API_KEY,
  cloudId = process.env.AGENTBAY_SESSION_ID;
assert.ok(
  key && cloudId,
  "Provide AGENTBAY_API_KEY and a dedicated initialized AGENTBAY_SESSION_ID",
);
const http = !!process.env.CUA_MCP_URL;
assert.ok(!http || process.env.CUA_MCP_TOKEN, "HTTP MCP token required");
const values = {
  name: randomUUID(),
  birth: `${randomInt(1960, 2001)}-${String(randomInt(1, 13)).padStart(2, "0")}-${String(randomInt(1, 28)).padStart(2, "0")}`,
  country: "CN",
  passport: randomUUID(),
  email: `${randomUUID()}@example.test`,
  phone: `09${randomInt(10000000, 99999999)}`,
  password: randomBytes(24).toString("hex"),
};
const privateStrings = [
  key,
  process.env.CUA_MCP_TOKEN,
  ...Object.entries(values)
    .filter(([id]) => id !== "country")
    .map(([, value]) => value),
].filter(Boolean);
const report = {
  mode: http ? "sandbox-http" : "agentbay-attach-stdio",
  host: "simulated AppBridge + bundled App",
  browser: "real AgentBay Chromium",
  checks: [],
  success: false,
  cleanupVerified: false,
};
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS ${name}`);
};
const privateCheck = (data) => {
  const text = JSON.stringify(data);
  assert.ok(
    privateStrings.every((value) => !text.includes(value)),
    "Private data found in model-visible channel",
  );
};
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const directory = await mkdtemp(join(tmpdir(), "cua-secure-cloud-"));
const run = randomBytes(8).toString("hex"),
  remote = `/tmp/cua-secure-${run}`;
const port = Number(process.env.CUA_SECURE_FORM_PORT ?? 31988);
const provider = new AgentBayBrowserProvider({ apiKey: key });
let cloud,
  client,
  transport,
  window,
  bridge,
  sessionId,
  requestId,
  executionId,
  tabId,
  alive;
let step = "connect cloud",
  notifications = 0,
  continuationReceived = false,
  submittedArgs;
async function command(code) {
  const r = await cloud.command.executeCommand(code, 60000);
  assert.ok(r.success && r.exitCode === 0, "Sandbox command failed");
  return r.output;
}
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    assert.ok(Date.now() < end, `Timed out: ${step}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function modelCall(name, args) {
  privateCheck(args);
  const raw = await client.callTool({ name, arguments: args });
  const safe = {
    content: raw.content,
    structuredContent: raw.structuredContent,
    isError: raw.isError,
  };
  privateCheck(safe);
  return { raw, safe };
}
async function settle(result) {
  const end = Date.now() + 60000;
  while (result.structuredContent?.status === "running") {
    assert.ok(Date.now() < end, "Execution timed out");
    result = (
      await modelCall("cua_poll", {
        sessionId,
        executionId: result.structuredContent.executionId,
        waitMs: 1000,
      })
    ).safe;
  }
  return result;
}
async function execute(code) {
  const r = await settle(
    (await modelCall("cua_exec", { sessionId, code })).safe,
  );
  assert.ok(
    r.structuredContent?.status === "succeeded",
    `Execution failed: ${r.structuredContent?.error?.code ?? "unknown"}`,
  );
  return r;
}
async function status() {
  return JSON.parse(
    await command(
      `python3 -c ${quote(`import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}/status').read().decode())`)}`,
    ),
  );
}
async function protectedReads() {
  const r = await execute(
    "try{await tab.ax.snapshot()}catch{} try{await tab.dom.snapshot()}catch{} try{await tab.screenshot.capture()}catch{} try{await tab.evaluate(()=>document.title)}catch{}",
  );
  assert.equal(r.structuredContent.operations.length, 4);
  assert.ok(
    r.structuredContent.operations.every(
      (o) =>
        o.error?.code === "SECURE_FORM_PROTECTED" &&
        o.outcome === "not_executed",
    ),
  );
}
async function privateCall(name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `Private tool rejected: ${name}`);
  return r;
}
try {
  const got = await provider.client.get(cloudId);
  assert.ok(got.success && got.session, "Dedicated sandbox unavailable");
  cloud = got.session;
  alive = setInterval(() => void cloud.keepAlive().catch(() => {}), 45000);
  alive.unref();
  const linked = await cloud.getLink(undefined, port);
  assert.ok(linked.success && linked.data, "HTTPS forwarding unavailable");
  const fixtureURL = new URL(linked.data);
  fixtureURL.protocol = "https:";
  fixtureURL.pathname = "/";
  const config = {
    port,
    origin: fixtureURL.origin,
    hashes: Object.fromEntries(
      Object.entries(values).map(([id, v]) => [
        id,
        createHash("sha256").update(v).digest("hex"),
      ]),
    ),
  };
  await writeFile(join(directory, "fixture.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  for (const [local, remoteFile] of [
    [resolve("scripts/fixtures/secure-form-cloud.mjs"), `${remote}.mjs`],
    [join(directory, "fixture.json"), `${remote}.json`],
  ])
    assert.ok(
      (await cloud.fileSystem.uploadFile(local, remoteFile)).success,
      "Fixture upload failed",
    );
  await command(
    `nohup node ${quote(remote + ".mjs")} ${quote(remote + ".json")} > ${quote(remote + ".log")} 2>&1 < /dev/null & echo $! > ${quote(remote + ".pid")}`,
  );
  await until(async () => {
    try {
      return (await status()).events === 0;
    } catch {
      return false;
    }
  }, 15000);
  check("synthetic fixture with expected hashes and value-free status");
  client = new Client(
    { name: "cloud-secure-form-acceptance", version: "1" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  );
  if (http)
    transport = new StreamableHTTPClientTransport(
      new URL(process.env.CUA_MCP_URL),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${process.env.CUA_MCP_TOKEN}` },
        },
      },
    );
  else {
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        defaultProfile: "cloud",
        profiles: {
          cloud: {
            provider: "agentbay",
            agentbay: { mode: "attach", sessionId: cloudId },
          },
        },
        service: { executeWaitMs: 50, cellTimeoutMs: 60000 },
      }),
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("packages/cli/dist/index.js"), "serve", "--config", path],
      env: { ...process.env, CUA_MCP_APPS: "1" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
  }
  await client.connect(transport);
  assert.ok(
    (await client.listTools()).tools.some((t) => t.name === "cua_secure_form"),
  );
  sessionId = (
    await modelCall("cua_session_create", {
      profile: http ? "sandbox" : "cloud",
    })
  ).safe.structuredContent.sessionId;
  step = "navigate real cloud browser";
  const boot = await execute(
    `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(fixtureURL.href)}});output.json({tabId:tab.id});`,
  );
  tabId = JSON.parse(
    boot.structuredContent.output.find((o) => o.type === "json").text,
  ).tabId;
  // A real page readiness check; never use a fake browser or inject values into model code.
  await execute(
    'await tab.waitForFunction(()=>document.querySelectorAll("input,select").length===7);',
  );
  const controls = {
    birth: "date",
    country: "select",
    email: "email",
    phone: "tel",
    password: "password",
  };
  const fields = fieldIds
    .map(
      (id) =>
        `{id:${JSON.stringify(id)},label:${JSON.stringify(id)},groupId:"p1",control:${JSON.stringify(controls[id] ?? "text")},masked:${id === "passport" || id === "password"},target:tab.locator("#${id}")}`,
    )
    .join(",");
  step = "request private form";
  let pending = (
    await modelCall("cua_exec", {
      sessionId,
      code: `output.json(await tab.secureForm.request({title:"Passenger 1",groups:[{id:"p1",label:"Passenger 1"}],fields:[${fields}],delivery:{mode:"fill"},timeoutMs:120000}));`,
    })
  ).safe;
  executionId = pending.structuredContent.executionId;
  await until(async () => {
    const w = pending.structuredContent.warnings?.find(
      (w) => w.code === "USER_ACTION_REQUIRED",
    );
    if (w) {
      requestId = /requestId ([\w-]+)/.exec(w.message)?.[1];
      return !!requestId;
    }
    assert.equal(pending.structuredContent.status, "running");
    pending = (
      await modelCall("cua_poll", { sessionId, executionId, waitMs: 1000 })
    ).safe;
    return false;
  });
  const card = (await modelCall("cua_secure_form", { sessionId, requestId }))
    .raw;
  privateStrings.push(card._meta.cua.token);
  const html = (await client.readResource({ uri: "ui://cua/secure-form.html" }))
    .contents[0].text;
  assert.ok(!html.includes("__APP_SCRIPT__"));
  const hostTransport = {
    start: async () => {},
    close: async () => {},
    send: async (data) =>
      queueMicrotask(() =>
        window.dispatchEvent(
          new window.MessageEvent("message", { data, source: host }),
        ),
      ),
  };
  const host = { postMessage: (message) => hostTransport.onmessage?.(message) };
  window = new Window({
    url: "https://isolated-app.test",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  Object.defineProperty(window, "parent", { value: host });
  bridge = await attachCUASecureForm({
    transport: hostTransport,
    formResult: card,
    callPrivateTool: async (name, args) => {
      if (name === "cua_ui_secure_form_answer" && args.action === "submit")
        submittedArgs = structuredClone(args);
      return client.callTool({ name, arguments: args });
    },
    enqueueUserMessage: async (message) => {
      privateCheck(message);
      assert.ok(message.content[0].text.includes(executionId));
      notifications++;
      continuationReceived = true;
    },
  });
  window.document.write(html.replace(/<script[\s\S]*<\/script>/, ""));
  window.eval(html.match(/<script type="module">([\s\S]*)<\/script>/)[1]);
  step = "render bundled private App";
  await until(() => !window.document.getElementById("open").hidden);
  window.document.getElementById("open").click();
  await until(
    () => window.document.querySelectorAll("input,select").length === 7,
  );
  const inputs = [];
  for (const id of fieldIds) {
    const input = window.document.getElementById(`field-${id}`);
    inputs.push(input);
    input.value =
      id === "country"
        ? [...input.options].find((o) => o.textContent === "China").value
        : values[id];
  }
  step = "private delivery and automatic continuation";
  window.document
    .getElementById("secure-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await until(() => continuationReceived);
  const completed = await settle(
    (await modelCall("cua_poll", { sessionId, executionId, waitMs: 1000 }))
      .safe,
  );
  const receipt = JSON.parse(
    completed.structuredContent.output.find((o) => o.type === "json").text,
  );
  assert.equal(receipt.status, "filled");
  assert.deepEqual(receipt.confirmedFieldIds, fieldIds);
  assert.deepEqual(receipt.uncertainFieldIds, []);
  assert.equal(receipt.businessOutcome, "unverified");
  assert.equal(receipt.actionOutcome, "not_dispatched");
  await until(async () => {
    const s = await status();
    return s.matchedFieldIds.length === 7;
  });
  assert.deepEqual(await status(), {
    matchedFieldIds: fieldIds,
    events: 7,
    confirmations: 0,
  });
  assert.equal(notifications, 1);
  assert.ok(inputs.every((i) => i.value === ""));
  check(
    "seven randomized fields validated by site hashes, exact select value, no automatic submit",
  );
  check(
    "bundled App clears inputs and wakes original execution once without private data",
  );
  step = "duplicate delivery and recovery";
  await privateCall("cua_ui_secure_form_answer", submittedArgs);
  assert.equal((await status()).events, 7);
  const reopened = (
    await modelCall("cua_secure_form", { sessionId, requestId })
  ).raw;
  privateStrings.push(reopened._meta.cua.token);
  assert.equal(reopened._meta.cua.status, "filled");
  assert.ok(!("request" in reopened._meta.cua));
  const stale = await client.callTool({
    name: "cua_ui_secure_form_state",
    arguments: { sessionId, requestId, token: card._meta.cua.token },
  });
  assert.equal(stale.isError, true);
  check(
    "duplicate private submit does not replay; reopened card recovers receipt and revokes old grant",
  );
  await protectedReads();
  check("AX, DOM, screenshot and evaluate blocked before dispatch");
  step = "private human control";
  const panel = (await modelCall("cua_view", { sessionId, tabId })).raw;
  privateStrings.push(panel._meta.cua.token);
  const access = { sessionId, token: panel._meta.cua.token };
  await privateCall("cua_ui_control", { ...access, action: "take" });
  assert.ok(
    (await modelCall("cua_exec", { sessionId, code: 'output.text("blocked")' }))
      .safe.isError,
  );
  const frame = (await privateCall("cua_ui_frame", access))._meta.cua;
  assert.ok(frame.data?.length > 100);
  await privateCall("cua_ui_input", {
    ...access,
    input: { type: "click", x: 100, y: 40, frameId: frame.id },
  });
  await until(async () => (await status()).confirmations === 1);
  await privateCall("cua_ui_control", { ...access, action: "resume" });
  await execute(
    `var browser=await cua.connect();var tab=await browser.tabs.get(${JSON.stringify(tabId)});`,
  );
  await protectedReads();
  check(
    "private panel capture, takeover gate, human-route submit and handback; next-page echoes remain blocked",
  );
  await modelCall("cua_reset", { sessionId });
  await execute(
    `var browser=await cua.connect();var tab=await browser.tabs.get(${JSON.stringify(tabId)});output.json(await tab.secureForm.status(${JSON.stringify(requestId)}));`,
  );
  await protectedReads();
  assert.deepEqual(await status(), {
    matchedFieldIds: fieldIds,
    events: 7,
    confirmations: 1,
  });
  check(
    "reset preserves protection and value-free receipt; no duplicate field events",
  );
  report.success = true;
} catch (error) {
  report.failedStep = step;
  report.error =
    error instanceof assert.AssertionError
      ? "Acceptance assertion failed"
      : "Acceptance operation failed";
  process.exitCode = 1;
} finally {
  const cleanups = [];
  if (sessionId && client)
    cleanups.push(
      await client
        .callTool({ name: "cua_close", arguments: { sessionId } })
        .then((r) => r.structuredContent?.closed === true)
        .catch(() => false),
    );
  await window?.happyDOM.close();
  await bridge?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (cloud)
    cleanups.push(
      await command(
        `if [ -f ${quote(remote + ".pid")} ]; then kill "$(cat ${quote(remote + ".pid")})" 2>/dev/null || true; fi; rm -f ${quote(remote + ".mjs")} ${quote(remote + ".json")} ${quote(remote + ".log")} ${quote(remote + ".pid")}`,
      )
        .then(() => true)
        .catch(() => false),
    );
  clearInterval(alive);
  await rm(directory, { recursive: true, force: true });
  report.cleanupVerified = cleanups.length > 0 && cleanups.every(Boolean);
  if (!report.cleanupVerified) {
    report.success = false;
    process.exitCode = 1;
  }
  // A fixed summary only: no private values, hashes, panel authority, URLs or raw diagnostics.
  if (process.env.CUA_SECURE_FORM_EVIDENCE)
    await writeFile(
      process.env.CUA_SECURE_FORM_EVIDENCE,
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
}
