// Protocol/REPL smoke only: never calls cua.connect() or opens a browser.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = await mkdtemp(
  join(process.platform === "darwin" ? "/tmp" : tmpdir(), "cua-harness-"),
);
const env = Object.fromEntries(
  ["PATH", "SystemRoot", "TEMP", "TMP", "LANG"].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
);
// Keep smoke sessions separate from the user's running CUA services.
env.HOME = home;
env.USERPROFILE = home;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    join(root, "packages/cli/dist/index.js"),
    "serve",
    "--config",
    join(root, "examples/cua.local.json"),
  ],
  cwd: root,
  env,
  stderr: "inherit",
});
const client = new Client({ name: "cua-harness-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "cua_exec",
      "cua_poll",
      "cua_cancel",
      "cua_reset",
      "cua_close",
      "cua_describe",
      "cua_session_create",
    ].sort(),
  );
  const created = await client.callTool({
    name: "cua_session_create",
    arguments: { profile: "local" },
  });
  assert.ok(!created.isError, "Session creation failed");
  const sessionId = created.structuredContent.sessionId;
  let response = await client.callTool({
    name: "cua_exec",
    arguments: {
      sessionId,
      requestId: "smoke-1",
      code: 'output.text("CUA harness smoke OK");',
    },
  });
  assert.ok(!response.isError, "Execution failed");
  let result = response.structuredContent;
  const output = [...result.output];
  while (result.status === "running") {
    response = await client.callTool({
      name: "cua_poll",
      arguments: {
        sessionId,
        executionId: result.executionId,
        cursor: result.cursor,
        waitMs: 1000,
      },
    });
    assert.ok(!response.isError, "Polling failed");
    result = response.structuredContent;
    output.push(...result.output);
  }
  assert.equal(result.status, "succeeded");
  assert.ok(output.some((o) => o.text === "CUA harness smoke OK"));
  const description = await client.callTool({
    name: "cua_describe",
    arguments: { sessionId },
  });
  assert.equal(description.structuredContent.connected, false);
  const closed = await client.callTool({
    name: "cua_close",
    arguments: { sessionId },
  });
  assert.equal(closed.structuredContent.closed, true);
  console.log(
    JSON.stringify({
      success: true,
      tools: tools.map((t) => t.name),
      browserConnected: false,
    }),
  );
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
