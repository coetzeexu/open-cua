// Opt-in acceptance: a real, already initialized AgentBay browser + bundled login App.
// Requires AGENTBAY_API_KEY and AGENTBAY_SESSION_ID. Never prints credentials.
// Default: local stdio CUA -> AgentBay attach. CUA_MCP_URL/TOKEN select sandbox HTTP.
// The host and model continuation are simulated; this does not claim native-host UX verification.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentBayBrowserProvider } from "@cua/browser-agentbay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Window } from "happy-dom";
import { attachCUALogin } from "../examples/harness-app-bridge.mjs";

const key = process.env.AGENTBAY_API_KEY;
const cloudId = process.env.AGENTBAY_SESSION_ID;
assert.ok(
  key && cloudId,
  "Provide the AgentBay API key and an initialized dedicated session",
);
const mode = process.env.CUA_MCP_URL ? "sandbox-http" : "agentbay-attach-stdio";
const directory = await mkdtemp(join(tmpdir(), "cua-login-cloud-"));
const password = randomBytes(24).toString("hex");
const hash = createHash("sha256").update(password).digest("hex");
const run = randomBytes(8).toString("hex");
const remoteFile = `/tmp/cua-login-${run}.mjs`;
const remotePid = `/tmp/cua-login-${run}.pid`;
const checks = [];
const report = {
  mode,
  browser: "AgentBay Chromium",
  host: "simulated AppBridge + bundled App",
  randomCredential: true,
  checks,
  success: false,
};
const provider = new AgentBayBrowserProvider({ apiKey: key });
let got;
for (let attempt = 0; attempt < 3; attempt++) {
  got = await provider.client.get(cloudId);
  if (got.success && got.session) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.ok(got.success && got.session, "Dedicated sandbox unavailable");
const cloud = got.session;
const alive = setInterval(() => void cloud.keepAlive().catch(() => {}), 60000);
alive.unref();
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
let client, transport, bridge, window, sessionId;
async function command(code) {
  const r = await cloud.command.executeCommand(code, 60000);
  assert.ok(r.success && r.exitCode === 0, "Sandbox command failed");
  return r.output;
}
async function wait(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, "Acceptance step timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const checkPrivate = (value) => {
  const text = JSON.stringify(value);
  assert.ok(
    !text.includes(password),
    "Credential found in model-visible result",
  );
  assert.ok(!text.includes(key), "Cloud API key found in model-visible result");
};
async function modelCall(name, args) {
  checkPrivate(args);
  const raw = await client.callTool({ name, arguments: args });
  const safe = {
    content: raw.content,
    structuredContent: raw.structuredContent,
    isError: raw.isError,
  };
  checkPrivate(safe);
  return { raw, safe };
}
async function execute(code) {
  let { safe } = await modelCall("cua_exec", { sessionId, code });
  const deadline = Date.now() + 45000;
  while (safe.structuredContent?.status === "running") {
    assert.ok(Date.now() < deadline, "Browser execution timed out");
    ({ safe } = await modelCall("cua_poll", {
      sessionId,
      executionId: safe.structuredContent.executionId,
      waitMs: 1000,
    }));
  }
  if (safe.structuredContent?.status !== "succeeded")
    report.executionFailure = {
      status: safe.structuredContent?.status,
      code: safe.structuredContent?.error?.code,
      operations: safe.structuredContent?.operations?.map((o) => ({
        kind: o.kind,
        status: o.status,
        code: o.error?.code,
      })),
    };
  assert.ok(
    safe.structuredContent?.status === "succeeded",
    "Browser execution did not succeed",
  );
  return safe;
}
try {
  let fixture = await readFile("examples/login-scenario.mjs", "utf8");
  fixture = fixture.replace(
    "import { randomBytes }",
    "import { randomBytes, createHash }",
  );
  fixture = fixture.replace(
    'values.get("password") !== "CuaDemo2026!"',
    `createHash("sha256").update(values.get("password") ?? "").digest("hex") !== "${hash}"`,
  );
  assert.ok(fixture.includes(hash), "Fixture credential replacement failed");
  // Stay on the credential document so observation protection can be checked,
  // then navigate to the real cookie-protected order page.
  fixture = fixture.replace(
    '<form method="post" action="/login">',
    `<form method="post" action="/login" onsubmit="event.preventDefault();fetch('/login',{method:'POST',body:new URLSearchParams(new FormData(this))}).then(r=>{document.querySelector('[role=status]').textContent=r.ok?'登录成功':'登录失败';})">`,
  );
  fixture = fixture.replace(
    "<h1>登录订单后台</h1>",
    '<h1>登录订单后台</h1><p role="status">等待登录</p><a href="/orders">进入订单列表</a>',
  );
  fixture = fixture.replace('), "127.0.0.1", () => {', '), "0.0.0.0", () => {');
  const localFile = join(directory, "fixture.mjs");
  await writeFile(localFile, fixture, { mode: 0o600 });
  const uploaded = await cloud.fileSystem.uploadFile(localFile, remoteFile);
  assert.ok(uploaded.success, "Fixture upload failed");
  await command(
    `nohup node ${quote(remoteFile)} > ${quote(remoteFile + ".log")} 2>&1 < /dev/null & echo $! > ${quote(remotePid)}`,
  );
  await command(
    "python3 -c \"import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:31987/login').status == 200\"",
  );
  checks.push("isolated sandbox HTTP fixture with randomized password hash");
  const linked = await cloud.getLink(undefined, 31987);
  assert.ok(
    linked.success && linked.data,
    "Fixture HTTPS forwarding unavailable",
  );
  const fixtureURL = new URL(linked.data);
  fixtureURL.protocol = "https:";
  fixtureURL.pathname = "/orders";
  client = new Client(
    { name: "cloud-login-acceptance", version: "1" },
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
  if (mode === "sandbox-http") {
    assert.ok(process.env.CUA_MCP_TOKEN, "Sandbox MCP token required");
    transport = new StreamableHTTPClientTransport(
      new URL(process.env.CUA_MCP_URL),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${process.env.CUA_MCP_TOKEN}` },
        },
      },
    );
  } else {
    const configFile = join(directory, "config.json");
    await writeFile(
      configFile,
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
      args: [
        resolve("packages/cli/dist/index.js"),
        "serve",
        "--config",
        configFile,
      ],
      env: { ...process.env, CUA_MCP_APPS: "1" },
      stderr: "pipe",
    });
    // Do not retain raw process diagnostics from the credential-bearing environment.
    transport.stderr?.on("data", () => {});
  }
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(
    listed.tools.some((t) => t.name === "cua_login"),
    "Login tool missing",
  );
  const created = await modelCall("cua_session_create", {
    profile: mode === "sandbox-http" ? "sandbox" : "cloud",
  });
  sessionId = created.safe.structuredContent.sessionId;
  const observed = await execute(
    `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(fixtureURL.href)}});output.json(await tab.ax.snapshot({full:true}));`,
  );
  let view = JSON.parse(
    observed.structuredContent.output.find((o) => o.type === "json").text,
  );
  for (
    let i = 0;
    i < 30 &&
    !(
      view.url.endsWith("/login") &&
      view.nodes.some((n) => n.name === "密码" && n.sensitive)
    );
    i++
  ) {
    await new Promise((r) => setTimeout(r, 200));
    const next = await execute(
      "output.json(await tab.ax.snapshot({full:true}));",
    );
    view = JSON.parse(
      next.structuredContent.output.find((o) => o.type === "json").text,
    );
  }
  assert.ok(
    view.url.endsWith("/login") &&
      view.nodes.some((n) => n.name === "密码" && n.sensitive),
    "Login was not observed",
  );
  checks.push(
    "real cloud browser navigation, login detection and sensitive password field",
  );
  let pending = (
    await modelCall("cua_exec", {
      sessionId,
      code: 'output.json(await tab.auth.request({fields:[{id:"account",label:"账号",type:"username",target:tab.getByRole("textbox",{name:"账号",exact:true})},{id:"password",label:"密码",type:"password",target:tab.getByRole("textbox",{name:"密码",exact:true})}],submit:{target:tab.getByRole("button",{name:"登录",exact:true})}}));',
    })
  ).safe;
  const executionId = pending.structuredContent.executionId;
  const deadline = Date.now() + 45000;
  while (
    !pending.structuredContent.warnings?.some(
      (w) => w.code === "USER_ACTION_REQUIRED",
    )
  ) {
    assert.ok(
      Date.now() < deadline && pending.structuredContent.status === "running",
      "Credential request did not become pending",
    );
    pending = (
      await modelCall("cua_poll", { sessionId, executionId, waitMs: 1000 })
    ).safe;
  }
  const warning = pending.structuredContent.warnings.find(
    (w) => w.code === "USER_ACTION_REQUIRED",
  ).message;
  const requestId = /requestId ([\w-]+)/.exec(warning)?.[1];
  assert.ok(requestId, "Credential request ID missing");
  const card = (await modelCall("cua_login", { sessionId, requestId })).raw;
  const resource = await client.readResource({ uri: "ui://cua/login.html" });
  const html = resource.contents[0].text;
  assert.ok(!html.includes("__APP_SCRIPT__"), "App was not bundled");
  let notifications = 0,
    resumed;
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
  bridge = await attachCUALogin({
    transport: hostTransport,
    loginResult: card,
    callPrivateTool: async (name, args) =>
      client.callTool({ name, arguments: args }),
    enqueueUserMessage: async (message) => {
      notifications++;
      checkPrivate(message);
      assert.ok(
        !JSON.stringify(message).includes(card._meta.cua.token),
        "Private token found in continuation",
      );
      assert.ok(
        message.content[0].text.includes(executionId),
        "Continuation did not bind original execution",
      );
      resumed = (async () => {
        let result;
        const end = Date.now() + 45000;
        do {
          assert.ok(Date.now() < end, "Credential fill timed out");
          result = (
            await modelCall("cua_poll", {
              sessionId,
              executionId,
              waitMs: 1000,
            })
          ).safe;
        } while (result.structuredContent.status === "running");
        assert.ok(
          result.structuredContent.status === "succeeded",
          "Credential fill failed",
        );
        let snapshot;
        for (let i = 0; i < 20; i++) {
          snapshot = await execute(
            "output.json(await tab.ax.snapshot({full:true}));",
          );
          if (JSON.stringify(snapshot).includes("登录成功")) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(
          JSON.stringify(snapshot).includes("登录成功"),
          "Website did not accept randomized password",
        );
        assert.ok(
          JSON.stringify(snapshot).includes("[redacted]"),
          "Editable values not redacted",
        );
        let blocked = (
          await modelCall("cua_exec", {
            sessionId,
            code: "output.json(await tab.evaluate(()=>document.title));",
          })
        ).safe;
        const protectionDeadline = Date.now() + 30000;
        while (blocked.structuredContent?.status === "running") {
          assert.ok(
            Date.now() < protectionDeadline,
            "Protection check timed out",
          );
          blocked = (
            await modelCall("cua_poll", {
              sessionId,
              executionId: blocked.structuredContent.executionId,
              waitMs: 1000,
            })
          ).safe;
        }
        assert.ok(
          JSON.stringify(blocked).includes("CREDENTIAL_PROTECTED"),
          "Protected document evaluation was not blocked",
        );
        checks.push(
          "private App submission filled correct fields; website validated unknown randomized password",
        );
        checks.push(
          "original document AX redacted; model evaluate blocked; model outputs contain no password",
        );
        const orders = await execute(
          'await tab.getByRole("link",{name:"进入订单列表",exact:true}).click();await tab.getByRole("link",{name:"只看待发货",exact:true}).click();output.json(await tab.ax.snapshot({full:true}));',
        );
        const text = JSON.stringify(orders);
        assert.ok(
          [
            "DEMO-1001",
            "DEMO-1003",
            "DEMO-1004",
            "129.00",
            "299.00",
            "30.00",
          ].every((s) => text.includes(s)) && !text.includes("DEMO-1002"),
          "Pending orders did not match",
        );
        checks.push(
          "App ui/message resumed original execution and read 3 pending orders totaling 458 CNY",
        );
      })();
      resumed.catch(() => {});
    },
  });
  window.document.write(html.replace(/<script[\s\S]*<\/script>/, ""));
  window.eval(html.match(/<script type="module">([\s\S]*)<\/script>/)[1]);
  await wait(() => window.document.querySelectorAll("input").length === 2);
  const [account, pass] = window.document.querySelectorAll("input");
  account.value = "demo";
  pass.value = password;
  window.document
    .getElementById("login")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await wait(() => !!resumed);
  await resumed;
  assert.ok(
    notifications === 1 && account.value === "" && pass.value === "",
    "Notification duplication or local value retention",
  );
  checks.push("one continuation notification; App inputs cleared");
  const tabId = view.nodes.find((n) => n.ref)?.ref.tabId;
  const panel = (await modelCall("cua_view", { sessionId, tabId })).raw;
  const panelAccess = { sessionId, token: panel._meta.cua.token };
  const frame = await client.callTool({
    name: "cua_ui_frame",
    arguments: panelAccess,
  });
  assert.ok(
    frame._meta.cua.data?.length > 100,
    "Cloud browser preview unavailable",
  );
  await client.callTool({
    name: "cua_ui_control",
    arguments: { ...panelAccess, action: "take" },
  });
  const blocked = (
    await modelCall("cua_exec", {
      sessionId,
      code: 'output.text("should not run")',
    })
  ).safe;
  assert.ok(blocked.isError, "Human takeover did not block model execution");
  await client.callTool({
    name: "cua_ui_control",
    arguments: { ...panelAccess, action: "resume" },
  });
  checks.push("cloud browser panel capture and takeover/resume supported");
  report.success = true;
} catch (error) {
  report.error = String(error)
    .replaceAll(password, "[REDACTED]")
    .replaceAll(key, "[REDACTED]")
    .replace(/(?:https?|wss?):\/\/[^\s"']+/g, "[URL]");
  process.exitCode = 1;
} finally {
  if (sessionId && client)
    await client
      .callTool({ name: "cua_close", arguments: { sessionId } })
      .catch(() => {});
  await window?.happyDOM.close();
  await bridge?.close().catch(() => {});
  await client?.close().catch(() => {});
  await command(
    `if [ -f ${quote(remotePid)} ]; then kill "$(cat ${quote(remotePid)})" 2>/dev/null || true; fi; rm -f ${quote(remoteFile)} ${quote(remoteFile + ".log")} ${quote(remotePid)}`,
  ).catch(() => {});
  clearInterval(alive);
  await rm(directory, { recursive: true, force: true });
  if (process.env.CUA_LOGIN_EVIDENCE)
    await writeFile(
      process.env.CUA_LOGIN_EVIDENCE,
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
}
