import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectChromiumEndpoint } from "@cua/browser-chromium";
import { discoverEndpoint } from "./discover-endpoint.mjs";

// Run explicitly inside a dedicated sandbox. Never allocates/deletes a cloud session.
assert.equal(
  process.env.CUA_SANDBOX_SMOKE,
  "1",
  "Set CUA_SANDBOX_SMOKE=1 inside the test sandbox.",
);
assert.equal(
  ["linux", "win32"].includes(process.platform),
  true,
  "Run inside a Windows or Linux sandbox.",
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const runId = `internal-${randomUUID()}`;
const directory = resolve(
  process.env.CUA_SMOKE_OUTPUT ?? join(root, "artifacts/sandbox", runId),
);
await mkdir(directory, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "cua-internal-"));
const endpoint =
  process.env.CUA_BROWSER_CDP_URL ??
  (await discoverEndpoint(process.env.CUA_BROWSER_PROFILE));
const report = {
  runId,
  timestamp: new Date().toISOString(),
  hostname: hostname(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runnerPid: process.pid,
  servicePid: null,
  workerPids: [],
  browserVersion: null,
  endpointHost: new URL(endpoint).hostname,
  endpointSource: process.env.CUA_BROWSER_CDP_URL
    ? "injected"
    : "profile-process",
  checks: [],
  steps: [],
  success: false,
};
let verifier;
let sentinel;
let client;
const text = (result) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
try {
  verifier = await connectChromiumEndpoint(endpoint, {
    mode: "attach",
    existingContextOnly: true,
  });
  report.browserVersion = verifier.browser.version();
  const originals = [...verifier.context.pages()];
  sentinel = await verifier.context.newPage();
  const sentinelTitle = `CUA user sentinel ${runId}`;
  await sentinel.goto(
    `data:text/html,<title>${sentinelTitle}</title><p>User page preserved</p>`,
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        }
      : {}),
    LANG: "C.UTF-8",
    CUA_BROWSER_PROFILE:
      process.env.CUA_BROWSER_PROFILE ?? "/tmp/agentbay_browser",
  };
  if (process.env.CUA_BROWSER_CDP_URL || process.env.CUA_SMOKE_ENTRY === "cli")
    env.CUA_BROWSER_CDP_URL = endpoint;
  // No API key, handoff URL, or unrelated host environment is passed to CUA.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args:
      process.env.CUA_SMOKE_ENTRY === "cli"
        ? [
            join(root, "packages/cli/dist/index.js"),
            "serve",
            "--config",
            join(root, "examples/cua.sandbox.json"),
          ]
        : [join(root, "deploy/sandbox/start.mjs")],
    env,
    stderr: "pipe",
    cwd: root,
  });
  transport.stderr?.resume();
  client = new Client(
    { name: "mock-model-inside-sandbox", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  report.servicePid = transport.pid;
  assert.equal((await client.listTools()).tools.length, 7);
  report.checks.push(
    "real stdio MCP service started inside sandbox without AgentBay credentials",
  );

  const call = async (name, args) => {
    let result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120000,
    });
    while (result.structuredContent?.status === "running") {
      result = await client.callTool({
        name: "cua_poll",
        arguments: { executionId: result.structuredContent.executionId },
      });
    }
    report.steps.push({
      name,
      arguments: args,
      status:
        result.structuredContent?.status ??
        (result.isError ? "error" : "completed"),
      errors: (result.structuredContent?.operations ?? []).flatMap((o) =>
        o.error ? [o.error.code] : [],
      ),
    });
    assert.notEqual(result.isError, true, `MCP ${name} failed`);
    if (name === "cua_exec")
      assert.equal(
        result.structuredContent?.status,
        "succeeded",
        JSON.stringify(report.steps.at(-1)),
      );
    return result;
  };
  const fixture =
    '<!doctype html><title>CUA inside sandbox</title><main><h1>Sandbox mock messages</h1><label>Message <input aria-label="Message"></label><button>Submit</button><p role="status">Waiting</p></main><script>document.querySelector("button").onclick=()=>{document.querySelector("[role=status]").textContent=document.querySelector("input").value;};</script>';
  const fixtureUrl = `data:text/html,${encodeURIComponent(fixture)}`;
  const first = await call("cua_exec", {
    code: `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(fixtureUrl)}});output.text(await tab.evaluate(()=>document.title));output.json({id:tab.id});`,
  });
  assert.match(text(first), /CUA inside sandbox/);
  const tabId = JSON.parse(
    first.content.find((c) => c.type === "text" && c.text.startsWith("{")).text,
  ).id;
  const ownedPage = verifier.context
    .pages()
    .find((p) => p.url() === fixtureUrl);
  assert.ok(ownedPage);
  report.checks.push(
    "navigation and evaluation reached the existing sandbox browser",
  );
  if (process.platform === "linux") {
    const workers = (
      await readFile(
        `/proc/${transport.pid}/task/${transport.pid}/children`,
        "utf8",
      )
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    assert.ok(workers.length);
    report.workerPids = workers;
    for (const pid of workers) {
      const workerEnv = (await readFile(`/proc/${pid}/environ`, "utf8")).split(
        "\0",
      );
      assert.ok(
        !workerEnv.some((v) =>
          /^(AGENTBAY_API_KEY|CUA_BROWSER_CDP_URL|CUA_BROWSER_HANDOFF_URL)=/.test(
            v,
          ),
        ),
      );
    }
    report.checks.push(
      "service and REPL worker PIDs verified in local /proc; worker has no control-plane or CDP environment",
    );
  } else {
    const { processStart } = await import("@cua/service");
    assert.ok(await processStart(transport.pid));
    report.checks.push("Windows service process start identity verified");
  }
  const observed = await call("cua_exec", {
    code: "output.json(await tab.ax.snapshot());",
  });
  assert.match(text(observed), /Message/);
  const action = await call("cua_exec", {
    requestId: "mock-sandbox-submit",
    code: 'await tab.getByRole("textbox",{name:"Message"}).fill("mock model reached sandbox browser");await tab.getByRole("button",{name:"Submit"}).click();output.json(await tab.ax.snapshot());',
  });
  assert.match(text(action), /mock model reached sandbox browser/);
  report.checks.push(
    "AX observation, real fill and click, resulting page text",
  );
  const shot = await call("cua_exec", {
    code: "output.image(await tab.screenshot.capture());",
  });
  const image = shot.content.find((c) => c.type === "image");
  assert.equal(image?.mimeType, "image/jpeg");
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length > 100);
  await writeFile(join(directory, "browser.jpg"), bytes);
  report.checks.push("JPEG screenshot returned through MCP image content");
  await call("cua_exec", {
    code: `var users=await browser.userTabs.list();var user=await browser.userTabs.claim(users.find(t=>t.title===${JSON.stringify(sentinelTitle)}));output.text(await user.evaluate(()=>document.title));`,
  });
  await call("cua_reset", {});
  const afterReset = await call("cua_exec", {
    code: `var browser=await cua.connect();var tab=await browser.tabs.get(${JSON.stringify(tabId)});output.text(await tab.evaluate(()=>document.querySelector('[role=status]').textContent));`,
  });
  assert.equal(
    afterReset.content.find((c) => c.type === "text").text,
    "mock model reached sandbox browser",
  );
  report.checks.push("worker reset preserves browser tab and form result");
  const closed = await call("cua_close", {});
  assert.equal(closed.structuredContent.closed, true);
  await verifier.health();
  assert.equal(ownedPage.isClosed(), true);
  assert.equal(sentinel.isClosed(), false);
  assert.equal(await sentinel.title(), sentinelTitle);
  assert.ok(originals.every((p) => !p.isClosed()));
  report.checks.push(
    "cua_close closes owned page, preserves claimed and pre-existing pages, browser remains alive",
  );
  const exitUrl = "data:text/html,<title>CUA exit cleanup</title>";
  await call("cua_exec", {
    code: `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(exitUrl)}});output.text(await tab.evaluate(()=>document.title));`,
  });
  const exitPage = verifier.context.pages().find((p) => p.url() === exitUrl);
  assert.ok(exitPage);
  await client.close();
  client = undefined;
  for (let i = 0; i < 100 && !exitPage.isClosed(); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(exitPage.isClosed(), true);
  await verifier.health();
  assert.equal(sentinel.isClosed(), false);
  assert.ok(originals.every((p) => !p.isClosed()));
  const journals = join(home, ".cua/state/instances");
  const lines = (
    await Promise.all(
      (await readdir(journals))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => readFile(join(journals, f), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(lines, /"kind":"(?:agentbay|local-profile)"/);
  report.checks.push(
    "stdio/service exit cleans owned tabs without deleting browser or sandbox; no cloud/profile ownership journal",
  );
  report.success = true;
} finally {
  await client?.close();
  await sentinel?.close();
  await verifier?.close();
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await rm(home, { recursive: true, force: true });
  console.log(
    `Sandbox mock messages ${report.success ? "PASSED" : "FAILED"}: ${directory}`,
  );
}
