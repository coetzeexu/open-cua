import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  startRunner,
  type RunnerConfig,
  type ScriptManifest,
  type McpConnection,
} from "@cua/runner";
import { RunStore } from "../packages/runner/src/store.js";
import { CUAService } from "@cua/service";
import { startHttpGateway } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";

const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const TOKEN = "runner-test-token-012345678901234567890";
process.env.CUA_RUNNER_TEST_TOKEN = TOKEN;
const fileSchema = {
  type: "object",
  "x-cua-file": true,
  additionalProperties: false,
  required: ["file_id", "sha256", "size_bytes"],
  properties: {
    file_id: { type: "string" },
    sha256: { type: "string" },
    size_bytes: { type: "integer", minimum: 0 },
  },
};

async function fixture(t: TestContext, realMcp = false) {
  const directory = await mkdtemp(join(tmpdir(), "cua-runner-"));
  const inputData = Buffer.from("bom-example");
  const uploads: Array<{ path: string; data: Buffer; principal?: string }> = [];
  let main = "return {output:{order_id:ctx.input.name},files:[]};";
  let verify = "return result.output.order_id === ctx.input.name;";
  let inputSchema: any = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
  };
  let outputSchema: any = {
    type: "object",
    additionalProperties: false,
    required: ["order_id"],
    properties: { order_id: { type: "string" } },
  };
  let version = "1";
  let sourceStatus = 200;
  let uploadStatus = 200;
  let uploadFailureAt = 0;
  let inputOverride: Buffer | undefined;
  const manifest = (): ScriptManifest => ({
    protocol_version: 1,
    cua_script_id: "purchase",
    script_version: version,
    description: "Fixture script",
    input_schema: inputSchema,
    output_schema: outputSchema,
    entry: "main.js",
    verify_entry: "verify.js",
    entry_sha256: digest(main),
    verify_sha256: digest(verify),
    observation_mode: "default",
    timeout_ms: 10000,
  });
  let sourceUrl = "";
  const source = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (path.startsWith("/scripts/")) {
      res.statusCode = sourceStatus;
      if (sourceStatus !== 200) return res.end();
      if (path.endsWith("published.json"))
        return res.end(JSON.stringify({ script_version: version }));
      if (path.endsWith("manifest.json"))
        return res.end(JSON.stringify(manifest()));
      if (path.endsWith("main.js")) return res.end(main);
      if (path.endsWith("verify.js")) return res.end(verify);
    }
    if (path === "/files/upload-1") return res.end(inputOverride ?? inputData);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      uploads.push({
        path,
        data,
        principal: req.headers["x-cua-principal"] as string,
      });
      res.statusCode = uploads.length === uploadFailureAt ? 503 : uploadStatus;
      if (res.statusCode !== 200) return res.end();
      const parts = path.split("/");
      return res.end(
        JSON.stringify({
          file_id: parts[4],
          name: decodeURIComponent(parts[5]),
          size_bytes: data.length,
          sha256: digest(data),
          mime_type: req.headers["content-type"],
          download_url: `${sourceUrl}${path}`,
        }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();
  assert.ok(address && typeof address !== "string");
  sourceUrl = `http://127.0.0.1:${address.port}`;
  const calls: Array<{ name: string; args: any }> = [];
  let executions = 0;
  let running = 0;
  let maxRunning = 0;
  let lost = false;
  let badCleanup = false;
  let delay = 0;
  let userAction = false;
  const results = new Map<string, any>();
  const mock: McpConnection = {
    sessionId: "mock-transport",
    async call(name, args, signal) {
      calls.push({ name, args });
      if (name === "cua_session_create") return { sessionId: randomUUID() };
      if (name === "cua_close") return { closed: !badCleanup };
      if (name === "cua_cancel") return { status: "cancelled" };
      if (name === "cua_poll") {
        const result = results.get(args.executionId as string);
        return {
          ...result,
          output: result.output.slice(args.cursor as number),
        };
      }
      assert.equal(name, "cua_exec");
      const probe = String(args.code).includes(".probe-");
      if (!probe) {
        executions++;
        running++;
        maxRunning = Math.max(maxRunning, running);
      }
      try {
        if (!probe && lost) throw Error("lost execution response");
        if (!probe && delay)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        const output: any[] = [];
        let status = "succeeded";
        try {
          await new AsyncFunction("output", "cua", String(args.code))(
            {
              json(v: unknown) {
                output.push({
                  type: "json",
                  sequence: output.length,
                  text: JSON.stringify(v),
                });
              },
            },
            {},
          );
        } catch {
          status = "failed";
        }
        const executionId = randomUUID();
        const result = {
          executionId,
          status,
          output,
          cursor: output.length,
          warnings: [],
        };
        results.set(executionId, result);
        // Force a poll and exercise cursor-based output collection.
        return {
          ...result,
          status: "running",
          output: output.slice(0, 1),
          cursor: Math.min(1, output.length),
          warnings:
            !probe && userAction ? [{ code: "USER_ACTION_REQUIRED" }] : [],
        };
      } finally {
        if (!probe) running--;
      }
    },
    async close() {},
  };
  const config: RunnerConfig = {
    listen: { host: "127.0.0.1", port: 0, token_env: "CUA_RUNNER_TEST_TOKEN" },
    mcp: {
      url: sourceUrl,
      token_env: "CUA_RUNNER_TEST_TOKEN",
      profile: "fake",
      observation_mode: "default",
    },
    script_source: { base_url: sourceUrl },
    input_files: { base_url: sourceUrl, max_bytes: 1024 },
    output_files: { base_url: sourceUrl, max_bytes: 1024 },
    work_directory: join(directory, "work"),
    state_directory: join(directory, "state"),
    limits: {
      max_queue_size: 10,
      request_max_bytes: 65536,
      max_script_bytes: 65536,
      max_files_per_run: 3,
      max_run_file_bytes: 2048,
      run_timeout_ms: 10000,
      io_timeout_ms: 2000,
      cleanup_timeout_ms: 2000,
      retention_days: 7,
    },
  };
  let service: CUAService | undefined;
  let gateway: Awaited<ReturnType<typeof startHttpGateway>> | undefined;
  if (realMcp) {
    service = new CUAService({
      profiles: {
        fake: () => ({
          browser: new FakeBrowserProvider(),
          capabilities: fakeCapabilities(),
          targetResolvers: [fakeResolver],
        }),
      },
      executeWaitMs: 0,
      history: { directory: join(directory, "history") },
    });
    gateway = await startHttpGateway(service, { token: TOKEN, port: 0 });
    const mcpAddress = gateway.server.address();
    assert.ok(mcpAddress && typeof mcpAddress !== "string");
    config.mcp.url = `http://127.0.0.1:${mcpAddress.port}/mcp`;
  }
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  t.after(async () => {
    await runner?.close();
    await gateway?.close();
    await service?.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (extra: Parameters<typeof startRunner>[1] = {}) => {
    runner = await startRunner(config, {
      ...(realMcp ? {} : { connect: async () => mock }),
      ...extra,
    });
    return runner;
  };
  const request = async (
    route: string,
    body: any,
    headers: Record<string, string> = {},
  ) => {
    assert.ok(runner);
    const response = await fetch(`${runner.url}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const submit = (
    requestId: string = randomUUID(),
    input: any = { name: "PO-1" },
  ) =>
    request("run_cua_script", {
      cua_script_id: "purchase",
      request_id: requestId,
      input,
    });
  const done = async (runId: string, headers: Record<string, string> = {}) => {
    for (let i = 0; i < 500; i++) {
      const r = await request("get_cua_result", { run_id: runId }, headers);
      if (
        ["succeeded", "failed", "timed_out", "interrupted"].includes(
          r.body.status,
        )
      )
        return r.body;
      await pause(10);
    }
    throw Error("Run did not complete");
  };
  return {
    directory,
    config,
    start,
    request,
    submit,
    done,
    calls,
    uploads,
    inputData,
    manifest,
    close: async () => {
      await runner?.close();
      runner = undefined;
    },
    get executions() {
      return executions;
    },
    get maxRunning() {
      return maxRunning;
    },
    set main(v: string) {
      main = v;
    },
    set verify(v: string) {
      verify = v;
    },
    set inputSchema(v: any) {
      inputSchema = v;
    },
    set outputSchema(v: any) {
      outputSchema = v;
    },
    set sourceStatus(v: number) {
      sourceStatus = v;
    },
    set uploadStatus(v: number) {
      uploadStatus = v;
    },
    set uploadFailureAt(v: number) {
      uploadFailureAt = v;
    },
    set inputOverride(v: Buffer) {
      inputOverride = v;
    },
    set version(v: string) {
      version = v;
    },
    set delay(v: number) {
      delay = v;
    },
    set lost(v: boolean) {
      lost = v;
    },
    set badCleanup(v: boolean) {
      badCleanup = v;
    },
    set userAction(v: boolean) {
      userAction = v;
    },
  };
}

test("runner real HTTP MCP: schema, async run, file input/output and verify without a browser", async (t) => {
  const f = await fixture(t, true);
  f.inputSchema = {
    type: "object",
    required: ["name", "bom"],
    additionalProperties: false,
    properties: { name: { type: "string" }, bom: fileSchema },
  };
  f.main = `const fs = await import('node:fs/promises'); const data = await fs.readFile(ctx.files['/bom']); await fs.writeFile(ctx.outputDirectory+'/report.txt',data); return {output:{order_id:ctx.input.name},files:[{path:'report.txt',mime_type:'text/plain'}]};`;
  await f.start();
  assert.equal(
    (await f.request("get_script_schema", { cua_script_id: "purchase" }))
      .status,
    200,
  );
  const admitted = await f.submit("real", {
    name: "PO-1",
    bom: {
      file_id: "upload-1",
      sha256: digest(f.inputData),
      size_bytes: f.inputData.length,
    },
  });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  const result = await f.done(admitted.body.run_id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.cleanup, "succeeded");
  assert.equal(result.business_success, true);
  assert.deepEqual(result.output, { order_id: "PO-1" });
  assert.equal(result.files.length, 1);
  assert.ok(result.files[0].name.startsWith(admitted.body.run_id));
  assert.equal(f.uploads[0].principal, "service");
  assert.deepEqual(f.uploads[0].data, f.inputData);
});

test("runner admission: auth, strict JSON, schema validation, concurrent idempotency and persistence", async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal(
    (await f.request("get_script_schema", {}, { Authorization: "bad" })).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "get_script_schema",
        {},
        { Origin: "https://other.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "get_script_schema",
        '{"cua_script_id":"purchase","cua_script_id":"other"}',
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.submit("invalid", { name: 1 })).body.error.code,
    "INPUT_INVALID",
  );
  assert.equal(
    (await f.submit("extra", { name: "n", unknown: true })).body.error.code,
    "INPUT_INVALID",
  );
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => f.submit("same")),
  );
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal(new Set(responses.map((r) => r.body.run_id)).size, 1);
  assert.equal((await f.submit("same", { name: "different" })).status, 409);
  const runId = responses[0].body.run_id;
  assert.equal((await f.done(runId)).status, "succeeded");
  assert.equal(f.executions, 1);
  await f.close();
  await f.start();
  f.version = "2";
  assert.equal((await f.submit("same")).body.run_id, runId);
  assert.equal(f.executions, 1);
  assert.equal(
    (await f.request("get_cua_result", { run_id: "missing" })).status,
    404,
  );
});

test("runner serial queue, capacity and frozen-version failure", async (t) => {
  const f = await fixture(t);
  f.config.limits.max_queue_size = 1;
  f.delay = 150;
  await f.start();
  const a = await f.submit("a");
  while (!f.executions) await pause(5);
  const b = await f.submit("b");
  assert.equal(b.status, 202);
  assert.equal((await f.submit("c")).status, 429);
  f.main = "return {output:{order_id:'changed'},files:[]};";
  assert.equal((await f.done(a.body.run_id)).status, "succeeded");
  assert.equal((await f.done(b.body.run_id)).error.code, "INTEGRITY_MISMATCH");
  assert.equal(f.executions, 1);
  assert.equal(f.maxRunning, 1);
});

test("runner verifies business result and output schema separately", async (t) => {
  for (const [name, main, verify, error, business] of [
    [
      "verify",
      "return {output:{order_id:'ok'},files:[]}",
      "return false",
      "VERIFICATION_FAILED",
      false,
    ],
    [
      "output",
      "return {output:{bad:1},files:[]}",
      "return true",
      "OUTPUT_INVALID",
      true,
    ],
    [
      "non-json",
      "return {output:undefined,files:[]}",
      "return true",
      "OUTPUT_INVALID",
      null,
    ],
  ] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.main = main;
      f.verify = verify;
      await f.start();
      const a = await f.submit();
      const r = await f.done(a.body.run_id);
      assert.equal(r.error.code, error);
      assert.equal(r.business_success, business);
      assert.equal(r.cleanup, "succeeded");
      assert.equal(r.output, undefined);
    });
});

test("runner rejects corrupted input and output path traversal before upload", async (t) => {
  await t.test("input hash", async (t) => {
    const f = await fixture(t);
    f.inputSchema = {
      type: "object",
      properties: { bom: fileSchema },
      required: ["bom"],
    };
    await f.start();
    const a = await f.submit("bad-file", {
      bom: {
        file_id: "upload-1",
        sha256: "0".repeat(64),
        size_bytes: f.inputData.length,
      },
    });
    assert.equal((await f.done(a.body.run_id)).error.code, "FILE_INVALID");
    assert.equal(f.executions, 0);
  });
  await t.test("traversal", async (t) => {
    const f = await fixture(t);
    f.main =
      "return {output:{order_id:ctx.input.name},files:[{path:'../secret',mime_type:'text/plain'}]}";
    await f.start();
    const a = await f.submit();
    assert.equal((await f.done(a.body.run_id)).error.code, "OUTPUT_INVALID");
    assert.equal(f.uploads.length, 0);
  });
});

test("runner failed publication retains business success and does not replay", async (t) => {
  const f = await fixture(t);
  f.uploadStatus = 503;
  f.main =
    "await (await import('node:fs/promises')).writeFile(ctx.outputDirectory+'/report.txt','report');return {output:{order_id:ctx.input.name},files:[{path:'report.txt',mime_type:'text/plain'}]}";
  await f.start();
  const a = await f.submit("publish");
  const r = await f.done(a.body.run_id);
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "OUTPUT_PUBLISH_FAILED");
  assert.equal(r.business_success, true);
  assert.equal((await f.submit("publish")).body.run_id, a.body.run_id);
  assert.equal(f.executions, 1);
});

test("runner timeout cancels/cleans; ambiguous cleanup quarantines across restart", async (t) => {
  await t.test("timeout", async (t) => {
    const f = await fixture(t);
    f.config.limits.run_timeout_ms = 100;
    f.delay = 500;
    await f.start();
    const a = await f.submit();
    const r = await f.done(a.body.run_id);
    assert.equal(r.status, "timed_out");
    assert.equal(r.cleanup, "succeeded");
    assert.ok(f.calls.some((c) => c.name === "cua_close"));
  });
  await t.test("lost result", async (t) => {
    const f = await fixture(t);
    await f.start();
    f.lost = true;
    f.badCleanup = true;
    const a = await f.submit();
    const r = await f.done(a.body.run_id);
    assert.equal(r.status, "interrupted");
    assert.equal(r.cleanup, "failed");
    assert.equal((await f.submit()).status, 503);
    await f.close();
    await assert.rejects(f.start(), /quarantined/);
    assert.equal(f.executions, 1);
    f.lost = false;
    f.badCleanup = false;
    await f.start({ acknowledgeStopped: true });
    assert.equal(
      (await f.request("get_cua_result", { run_id: a.body.run_id })).body
        .status,
      "interrupted",
    );
  });
});

test("runner isolates principals, script permissions and file identity", async (t) => {
  const f = await fixture(t);
  await f.start({
    authenticate: async (req) => (req.headers["x-user"] as string) || "alice",
    authorizeScript: async (who) => who !== "blocked",
  });
  const a = await f.submit("owned");
  await f.done(a.body.run_id);
  assert.equal(
    (
      await f.request(
        "get_cua_result",
        { run_id: a.body.run_id },
        { "x-user": "bob" },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        "get_script_schema",
        { cua_script_id: "purchase" },
        { "x-user": "blocked" },
      )
    ).status,
    403,
  );
  const b = await f.request(
    "run_cua_script",
    { cua_script_id: "purchase", request_id: "owned", input: { name: "PO-1" } },
    { "x-user": "bob" },
  );
  assert.equal(b.status, 202);
  assert.notEqual(b.body.run_id, a.body.run_id);
  await f.done(b.body.run_id, { "x-user": "bob" });
});

test("runner schema date formats, local refs and ambiguous file annotations", async (t) => {
  await t.test("date", async (t) => {
    const f = await fixture(t);
    f.inputSchema = {
      type: "object",
      properties: { date: { type: "string", format: "date" } },
      required: ["date"],
    };
    await f.start();
    assert.equal(
      (await f.submit("date", { date: "2026-02-30" })).body.error.code,
      "INPUT_INVALID",
    );
  });
  await t.test("remote ref", async (t) => {
    const f = await fixture(t);
    f.inputSchema = { $ref: "https://untrusted.example/schema" };
    await f.start();
    assert.equal(
      (await f.request("get_script_schema", { cua_script_id: "purchase" })).body
        .error.code,
      "SCHEMA_INVALID",
    );
  });
  await t.test("ambiguous file", async (t) => {
    const f = await fixture(t);
    f.inputSchema = { anyOf: [fileSchema, { type: "string" }] };
    await f.start();
    assert.equal(
      (await f.request("get_script_schema", { cua_script_id: "purchase" })).body
        .error.code,
      "SCHEMA_INVALID",
    );
  });
});

test("runner store restart leaves interrupted work terminal without replay", async (t) => {
  const f = await fixture(t);
  await f.start();
  const a = await f.submit("recover");
  await f.done(a.body.run_id);
  await f.close();
  const store = new RunStore(f.config.state_directory);
  const run = store.get(a.body.run_id)!;
  run.result = {
    ...run.result,
    status: "running",
    output: undefined,
    files: undefined,
    error: undefined,
  };
  store.save(run);
  store.close();
  await assert.rejects(f.start(), /quarantined/);
  assert.equal(f.executions, 1);
  await f.start({ acknowledgeStopped: true });
  assert.equal(
    (await f.request("get_cua_result", { run_id: a.body.run_id })).body.status,
    "interrupted",
  );
});

test("runner preserves queued work across shutdown and holds an exclusive store lock", async (t) => {
  const f = await fixture(t);
  f.delay = 300;
  await f.start();
  assert.throws(() => new RunStore(f.config.state_directory), /already in use/);
  const a = await f.submit("active");
  while (!f.executions) await pause(5);
  const b = await f.submit("queued");
  assert.equal(b.status, 202);
  await f.close();
  f.delay = 0;
  await f.start();
  assert.equal((await f.done(a.body.run_id)).status, "interrupted");
  assert.equal((await f.done(b.body.run_id)).status, "succeeded");
  assert.equal(f.executions, 2);
});

test("runner handles human-input requirements without continuing or replaying", async (t) => {
  const f = await fixture(t);
  await f.start();
  f.userAction = true;
  const a = await f.submit();
  const r = await f.done(a.body.run_id);
  assert.equal(r.error.code, "USER_ACTION_REQUIRED");
  assert.equal(r.cleanup, "succeeded");
  assert.ok(f.calls.some((c) => c.name === "cua_cancel"));
  assert.equal(f.executions, 1);
});

test("runner enforces file quota and rejects symlinks", async (t) => {
  for (const [name, main] of [
    [
      "quota",
      "await (await import('node:fs/promises')).writeFile(ctx.outputDirectory+'/out.txt','x'.repeat(1025));return {output:{order_id:ctx.input.name},files:[{path:'out.txt',mime_type:'text/plain'}]};",
    ],
    [
      "symlink",
      "const fs=await import('node:fs/promises');await fs.writeFile(ctx.outputDirectory+'/real.txt','secret');await fs.symlink(ctx.outputDirectory+'/real.txt',ctx.outputDirectory+'/link.txt');return {output:{order_id:ctx.input.name},files:[{path:'link.txt',mime_type:'text/plain'}]};",
    ],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.main = main;
      await f.start();
      const a = await f.submit();
      assert.equal((await f.done(a.body.run_id)).error.code, "OUTPUT_INVALID");
      assert.equal(f.uploads.length, 0);
    });
});

test("runner resolves nested local file refs and supports repeated schema IDs", async (t) => {
  const f = await fixture(t);
  f.inputSchema = {
    $id: "https://example.com/purchase-input",
    type: "object",
    required: ["name", "docs"],
    properties: {
      name: { type: "string" },
      docs: { type: "array", items: { $ref: "#/$defs/file" } },
    },
    $defs: { file: fileSchema },
  };
  f.main =
    "const fs=await import('node:fs/promises');const text=await fs.readFile(ctx.files['/docs/0'],'utf8');return {output:{order_id:text},files:[]}";
  f.verify = "return result.output.order_id === 'bom-example'";
  await f.start();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.request("get_script_schema", { cua_script_id: "purchase" }))
        .status,
      200,
    );
  const a = await f.submit("refs", {
    name: "PO-1",
    docs: [
      {
        file_id: "upload-1",
        sha256: digest(f.inputData),
        size_bytes: f.inputData.length,
      },
    ],
  });
  assert.equal(a.status, 202, JSON.stringify(a.body));
  assert.equal((await f.done(a.body.run_id)).status, "succeeded");
});

test("runner retries resource cleanup without replaying successful work", async (t) => {
  const f = await fixture(t);
  const runner = await f.start();
  f.badCleanup = true;
  const a = await f.submit("cleanup");
  const result = await f.done(a.body.run_id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanup, "failed");
  assert.equal(runner.quarantined, true);
  const duplicate = await f.submit("cleanup");
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.run_id, a.body.run_id);
  assert.equal((await f.submit("cleanup", { name: "changed" })).status, 409);
  assert.equal((await f.submit("new-while-quarantined")).status, 503);
  f.badCleanup = false;
  await runner.retryCleanup();
  assert.equal(runner.quarantined, false);
  assert.equal((await f.done(a.body.run_id)).cleanup, "succeeded");
  assert.equal(f.executions, 1);
});

test("runner persists partial artifact receipts and frozen bytes on upload failure", async (t) => {
  const f = await fixture(t);
  f.uploadFailureAt = 2;
  f.main =
    "const fs=await import('node:fs/promises');await fs.writeFile(ctx.outputDirectory+'/a.txt','first');await fs.writeFile(ctx.outputDirectory+'/b.txt','second');return {output:{order_id:ctx.input.name},files:[{path:'a.txt',mime_type:'text/plain'},{path:'b.txt',mime_type:'text/plain'}]}";
  await f.start();
  const a = await f.submit("partial");
  const result = await f.done(a.body.run_id);
  assert.equal(result.error.code, "OUTPUT_PUBLISH_FAILED");
  assert.equal(result.business_success, true);
  assert.equal(result.files, undefined);
  await f.close();
  const store = new RunStore(f.config.state_directory);
  const run = store.get(a.body.run_id)!;
  store.close();
  assert.equal(run.receipts.length, 1);
  assert.equal(
    await readFile(
      join(
        f.config.work_directory,
        a.body.run_id,
        "artifacts",
        run.receipts[0].file_id,
      ),
      "utf8",
    ),
    "first",
  );
});

test("runner retention expires results and request keys together", async (t) => {
  const f = await fixture(t);
  await f.start();
  const a = await f.submit("expires");
  await f.done(a.body.run_id);
  await f.close();
  const store = new RunStore(f.config.state_directory);
  const run = store.get(a.body.run_id)!;
  assert.ok("finished_at" in run.result);
  run.result.finished_at = "2000-01-01T00:00:00Z";
  store.save(run);
  store.close();
  const runner = await f.start();
  await runner.retryCleanup();
  assert.equal(
    (await f.request("get_cua_result", { run_id: a.body.run_id })).status,
    404,
  );
  const b = await f.submit("expires");
  assert.notEqual(b.body.run_id, a.body.run_id);
  await f.done(b.body.run_id);
});

test("runner rejects FIFO output without waiting for a writer", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX named pipe fixture");
  const f = await fixture(t);
  f.main =
    "(await import('node:child_process')).execFileSync('mkfifo',[ctx.outputDirectory+'/pipe']);return {output:{order_id:ctx.input.name},files:[{path:'pipe',mime_type:'text/plain'}]}";
  await f.start();
  const a = await f.submit();
  const result = await f.done(a.body.run_id);
  assert.equal(result.error.code, "OUTPUT_INVALID");
  assert.equal(result.cleanup, "succeeded");
  assert.equal(f.uploads.length, 0);
});

test("runner rejects oversized HTTP input before admission", async (t) => {
  const f = await fixture(t);
  await f.start();
  const response = await f.request(
    "run_cua_script",
    JSON.stringify({ data: "x".repeat(f.config.limits.request_max_bytes) }),
  );
  assert.equal(response.status, 413);
  assert.equal(f.executions, 0);
});

test("runner refuses revoked queued versions and does not execute them", async (t) => {
  const f = await fixture(t);
  f.delay = 150;
  await f.start();
  const a = await f.submit("active");
  while (!f.executions) await pause(5);
  const b = await f.submit("revoke");
  f.sourceStatus = 410;
  await f.done(a.body.run_id);
  assert.equal(
    (await f.done(b.body.run_id)).error.code,
    "VERSION_NOT_PUBLISHED",
  );
  assert.equal(f.executions, 1);
});
