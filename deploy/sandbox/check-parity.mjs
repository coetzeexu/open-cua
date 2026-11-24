// Explicit sandbox acceptance: no cloud allocation, real browser + synthetic inputs only.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startHttp, loadConfig } from "@cua/cli";
import { discoverEndpoint } from "./discover-endpoint.mjs";
assert.equal(
  process.env.CUA_SANDBOX_SMOKE,
  "1",
  "Run explicitly in a dedicated test sandbox.",
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(root, "artifacts/parity-verified");
await mkdir(directory, { recursive: true });
const report = {
  time: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  checks: [],
  success: false,
};
let gateway;
const run = async (script, overrides) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(root, "deploy/sandbox", script)],
    {
      cwd: root,
      env: { ...process.env, ...overrides },
      timeout: 180000,
      windowsHide: true,
    },
  );
  console.log(stdout.trim());
};
try {
  const target = JSON.parse(
    await readFile(join(root, "runtime/target.json"), "utf8"),
  );
  assert.equal(target.target, `${process.platform}-${process.arch}`);
  assert.equal(target.bunRequired, false);
  const endpoint = await discoverEndpoint(process.env.CUA_BROWSER_PROFILE);
  report.checks.push(
    "packaged Node 24 and production dependencies; native profile-based browser discovery",
  );
  await run("check-cli.mjs", { CUA_CLI_EVIDENCE: join(directory, "cli") });
  report.checks.push(
    "CLI console, credentials, approval, handoff, status, journal recovery",
  );
  for (const entry of ["cli", "launcher"]) {
    await run("mock-messages.mjs", {
      CUA_SMOKE_ENTRY: entry,
      CUA_SMOKE_OUTPUT: join(directory, "mcp-" + entry),
    });
    report.checks.push(
      `${entry}: stdio MCP mock navigation, observation, input, screenshot, reset, close and service-exit ownership cleanup`,
    );
  }
  process.env.CUA_BROWSER_CDP_URL = endpoint;
  const token = randomBytes(32).toString("hex");
  gateway = await startHttp(
    await loadConfig(join(root, "examples/cua.sandbox.json")),
    { port: 0, token },
  );
  await run("check-http.mjs", {
    CUA_HTTP_SMOKE: "1",
    CUA_MCP_URL: `http://127.0.0.1:${gateway.server.address().port}/mcp`,
    CUA_MCP_TOKEN: token,
    CUA_HTTP_EVIDENCE: join(directory, "http"),
  });
  await gateway.close();
  gateway = undefined;
  report.checks.push(
    "HTTP MCP authentication, browser mock messages, reconnect, deduplication, cancel, reset and DELETE cleanup",
  );
  report.success = true;
} finally {
  await gateway?.close();
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Sandbox parity ${report.success ? "PASSED" : "FAILED"}`);
}
