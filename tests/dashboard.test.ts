import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { FileHistoryStore, atomicJSON, type RunHistory } from "@cua/history";
import { RecipeStore, runRecipe } from "@cua/recipes";
import {
  startDashboard,
  runTrace,
  executionStats,
  summarizeRun,
} from "@cua/dashboard";
import { CUAService } from "@cua/service";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error("Expected state was not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cua-dashboard-test-"));
  const history = new FileHistoryStore({
    directory: join(directory, "history"),
  });
  const recipes = new RecipeStore({ directory: join(directory, "recipes") });
  const recipe = recipes.save({
    name: "echo",
    description: "Test fixture only",
    sourceRunId: "source",
    parameters: {
      message: { type: "string", required: true },
      count: { type: "number", default: 2 },
      flag: { type: "boolean", default: false },
    },
    preconditions: [],
    script:
      "var b=await cua.connect(); var t=await b.tabs.create(); output.json(params);",
    verify:
      'return params.message === "expected" && params.count === 2 && params.flag === false;',
  });
  // Seed an activated fixture directly; this does NOT create or claim real browser validation.
  atomicJSON(join(recipes.directory, recipe.name, "active.json"), {
    version: recipe.version,
    hash: recipe.hash,
  });
  return {
    directory,
    history,
    recipes,
    recipe,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
async function client(app: Awaited<ReturnType<typeof startDashboard>>) {
  const page = await fetch(app.url);
  const html = await page.text();
  const token = html.match(/name="cua-token" content="([^"]+)"/)![1];
  assert.match(
    page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  assert.notEqual(token, "__SESSION_TOKEN__");
  return (path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(app.url + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-cua-token": token,
        "content-type": "application/json",
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

test("dashboard executes pinned recipes through the real runner, keeps history correlation and never retries failed verification", async () => {
  const f = fixture();
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    historyStore: f.history,
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  let executions = 0;
  const app = await startDashboard({
    ...f,
    profiles: [{ name: "fake", provider: "fake" }],
    defaultProfile: "fake",
    port: 0,
    async execute(input) {
      executions++;
      return runRecipe({ service, store: f.recipes, ...input });
    },
  });
  try {
    const request = await client(app);
    assert.equal((await fetch(app.url + "/api/state")).status, 403);
    assert.equal(
      (await request("/api/state", undefined, { origin: "https://other.test" }))
        .status,
      403,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        get(app.url, { headers: { host: "other.test" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      }),
      403,
    );
    const base = {
      name: f.recipe.name,
      version: f.recipe.version,
      profile: "fake",
      params: { message: "expected" },
      requestId: "first",
    };
    assert.equal(
      (await request("/api/runs", { ...base, version: "old" })).status,
      409,
    );
    assert.equal(
      (await request("/api/runs", { ...base, params: { message: 1 } })).status,
      400,
    );
    assert.equal(
      (
        await request("/api/runs", {
          ...base,
          params: { message: "expected", extra: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/runs", { ...base, profile: "unknown" })).status,
      400,
    );
    const first = await request("/api/runs", base);
    assert.equal(first.status, 202);
    const job = await first.json();
    assert.equal((await request("/api/runs", base)).status, 200);
    assert.equal(
      (await request("/api/runs", { ...base, params: { message: "changed" } }))
        .status,
      409,
    );
    await until(
      async () =>
        (await (await request("/api/state")).json()).jobs[0].status ===
        "succeeded",
    );
    const trace = await (await request(`/api/runs/${job.runId}`)).json();
    assert.equal(trace.runId, job.runId);
    assert.equal(trace.status, "succeeded");
    assert.equal(trace.mode, "run");
    assert.equal(trace.name, f.recipe.name);
    assert.deepEqual(trace.params, {
      message: "expected",
      count: 2,
      flag: false,
    });
    assert.ok(trace.spans.some((s: any) => s.kind === "sdk"));
    assert.ok(trace.events.some((e: any) => e.type === "session.closed"));
    const failed = await (
      await request("/api/runs", {
        ...base,
        requestId: "failed",
        params: { message: "wrong" },
      })
    ).json();
    await until(
      async () =>
        (await (await request("/api/state")).json()).jobs.find(
          (j: any) => j.id === "failed",
        ).status === "failed",
    );
    const failure = await (await request(`/api/runs/${failed.runId}`)).json();
    assert.equal(failure.status, "failed");
    assert.match(failure.error.message, /RECIPE_VERIFICATION_FAILED/);
    assert.equal(executions, 2);
    const state = await (await request("/api/state")).json();
    assert.equal(state.stats.total, 2);
    assert.equal(state.stats.successRate, 0.5);
    assert.equal(state.recipes[0].stats.total, 2);
    const detail = await (
      await request(`/api/recipes/echo?version=${f.recipe.version}`)
    ).json();
    assert.equal(detail.script, f.recipe.script);
  } finally {
    await app.close();
    await service.close();
    f.cleanup();
  }
});

test("dashboard serializes jobs and rejects an activation change while queued", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const called: string[] = [];
  const app = await startDashboard({
    ...f,
    profiles: [{ name: "fake", provider: "fake" }],
    defaultProfile: "fake",
    port: 0,
    async execute(input) {
      called.push(input.runId);
      await gate;
      return { passed: true };
    },
  });
  try {
    const request = await client(app);
    const base = {
      name: "echo",
      version: f.recipe.version,
      params: { message: "expected" },
    };
    const first = await (
      await request("/api/runs", { ...base, requestId: "one" })
    ).json();
    const second = await (
      await request("/api/runs", { ...base, requestId: "two" })
    ).json();
    const state = await (await request("/api/state")).json();
    assert.deepEqual(
      state.jobs.map((j: any) => j.status),
      ["running", "queued"],
    );
    assert.deepEqual(called, [first.runId]);
    const next = f.recipes.save({
      ...f.recipe,
      parentVersion: f.recipe.version,
      description: "new version",
    });
    atomicJSON(join(f.recipes.directory, "echo", "active.json"), {
      version: next.version,
      hash: next.hash,
    });
    release();
    await until(
      async () =>
        (await (await request("/api/state")).json()).jobs[1].status ===
        "failed",
    );
    const final = await (await request("/api/state")).json();
    assert.match(final.jobs[1].error, /激活版本已变化/);
    assert.equal(final.jobs[1].runId, second.runId);
    assert.equal(called.length, 1);
  } finally {
    release();
    await app.close();
    f.cleanup();
  }
});

test("dashboard serves referenced screenshots only, including SDK captures, and observes private-session scrubbing", async () => {
  const f = fixture();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nzwAAAAASUVORK5CYII=",
    "base64",
  );
  const evidence = f.history.artifact("source", "session", png, "image/png");
  const capture = f.history.append(
    "source",
    "sdk.finished",
    { method: "screenshot.capture", status: "succeeded", evidence },
    { sessionId: "session", callId: "capture" },
  )!;
  const outside = join(f.directory, "outside.png");
  writeFileSync(outside, png);
  const invalid = f.history.append("source", "failure.evidence", {
    evidence: { path: "../../outside.png", mimeType: "image/png" },
  })!;
  symlinkSync(outside, join(f.history.directory, "source", "link.png"));
  const link = f.history.append("source", "failure.evidence", {
    evidence: { path: "link.png", mimeType: "image/png" },
  })!;
  const app = await startDashboard({
    ...f,
    profiles: [],
    defaultProfile: "fake",
    port: 0,
    execute: async () => ({ passed: true }),
  });
  try {
    const request = await client(app);
    const image = await request(`/api/runs/source/artifacts/${capture.id}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal(
      (await request(`/api/runs/source/artifacts/${invalid.id}`)).status,
      403,
    );
    assert.equal(
      (await request(`/api/runs/source/artifacts/${link.id}`)).status,
      403,
    );
    f.history.restrictSession("source", "session");
    assert.equal(
      (await request(`/api/runs/source/artifacts/${capture.id}`)).status,
      404,
    );
    const trace = await (await request("/api/runs/source")).json();
    assert.ok(!trace.artifacts.some((a: any) => a.eventId === capture.id));
  } finally {
    await app.close();
    f.cleanup();
  }
});

test("trace groups repeated operation phases under the SDK span and separates validation from ordinary statistics", () => {
  const events: any[] = [];
  const add = (time: number, type: string, data: any, context = {}) =>
    events.push({
      id: String(events.length),
      runId: "run",
      time,
      type,
      data,
      ...context,
    });
  add(1000, "recipe.started", {
    name: "echo",
    version: "v1",
    validation: false,
  });
  add(
    1001,
    "execution.started",
    { code: "await tab.waitForFunction(...)" },
    { executionId: "exec" },
  );
  add(
    1010,
    "sdk.started",
    { method: "waitForFunction" },
    { executionId: "exec", callId: "call" },
  );
  for (let i = 0; i < 950; i++)
    add(
      1011 + i,
      "operation.changed",
      { operationId: "op", phase: "resolve", kind: "wait", status: "running" },
      { executionId: "exec", callId: "call" },
    );
  add(
    2000,
    "sdk.finished",
    { status: "failed", error: { code: "EVALUATE_ABANDONED" } },
    { executionId: "exec", callId: "call" },
  );
  add(
    2001,
    "execution.finished",
    {
      status: "failed",
      durationMs: 1000,
      operations: [],
      error: { code: "EVALUATE_ABANDONED" },
    },
    { executionId: "exec" },
  );
  const run: RunHistory = {
    runId: "run",
    events,
    status: "failed",
    businessSuccess: false,
  };
  const trace = runTrace(run);
  assert.equal(trace.spans.length, 2);
  assert.equal(trace.spans[1].parentId, "exec");
  assert.equal(trace.spans[1].eventIds.length, 952);
  assert.equal(trace.spans[1].end - trace.spans[1].start, 990);
  const ordinary = summarizeRun(run);
  const stats = executionStats([
    ordinary,
    { ...ordinary, status: "succeeded", businessSuccess: true },
    { ...ordinary, mode: "validation", status: "succeeded" },
    { ...ordinary, mode: "exploration" },
    { ...ordinary, status: "unverified" },
    { ...ordinary, status: "incomplete" },
  ]);
  assert.equal(stats.total, 4);
  assert.equal(stats.completed, 3);
  assert.equal(stats.validations, 1);
  assert.equal(stats.successRate, 1 / 3);
  const unfinished = runTrace({
    ...run,
    status: "incomplete",
    events: events.slice(0, 3),
  });
  assert.equal(
    unfinished.spans[0].end,
    1010,
    "an abandoned history must not grow until the present day",
  );
});

test("dashboard CLI requires an explicit storage config and does not initialize a browser runtime while browsing history", async () => {
  const { dashboardCommand } = await import("../packages/cli/src/dashboard.js");
  const f = fixture();
  let created = 0;
  const runtime = async () => {
    created++;
    throw Error("Runtime must stay lazy");
  };
  try {
    const load = async () => ({
      profiles: { local: { provider: "local" as const } },
      defaultProfile: "local",
      history: f.history.config,
      recipes: f.recipes.config,
    });
    await assert.rejects(dashboardCommand([], load, runtime), /--config/);
    const app = await dashboardCommand(
      ["--config", "fixture.json", "--port", "0"],
      load,
      runtime,
    );
    try {
      const request = await client(app);
      assert.equal((await request("/api/state")).status, 200);
      assert.equal(created, 0);
    } finally {
      await app.close();
    }
  } finally {
    f.cleanup();
  }
});

test("legacy trace joins uniquely enclosed operations but preserves repeated and ambiguous SDK calls", () => {
  const events: any[] = [];
  const add = (time: number, type: string, data: any, context: any = {}) =>
    events.push({
      id: String(events.length),
      time,
      type,
      data,
      sessionId: "session",
      executionId: "exec",
      runId: "legacy",
      ...context,
    });
  add(0, "execution.started", {});
  for (const [offset, suffix] of [
    [10, "first"],
    [30, "second"],
  ] as const) {
    add(offset, "sdk.started", { method: "connect" }, { callId: suffix });
    add(offset + 1, "operation.changed", {
      operationId: `op-${suffix}`,
      kind: "connect",
      phase: "dispatch",
    });
    add(offset + 5, "operation.changed", {
      operationId: `op-${suffix}`,
      kind: "connect",
      phase: "after_dispatch",
      status: "succeeded",
    });
    add(
      offset + 6,
      "sdk.finished",
      { method: "connect", status: "succeeded" },
      { callId: suffix },
    );
  }
  add(50, "sdk.started", { method: "tabs.create" }, { callId: "parallel-1" });
  add(51, "sdk.started", { method: "tabs.create" }, { callId: "parallel-2" });
  add(52, "operation.changed", {
    operationId: "ambiguous",
    kind: "tabs.create",
    status: "succeeded",
  });
  add(58, "sdk.finished", { status: "succeeded" }, { callId: "parallel-1" });
  add(59, "sdk.finished", { status: "succeeded" }, { callId: "parallel-2" });
  add(60, "execution.finished", { status: "succeeded" });
  const run: RunHistory = {
    runId: "legacy",
    events,
    status: "succeeded",
    businessSuccess: false,
  };
  const trace = runTrace(run);
  const connections = trace.spans.filter((s) => s.label === "connect");
  assert.equal(
    connections.length,
    2,
    "two real SDK invocations must not collapse into one",
  );
  assert.deepEqual(
    connections.map((s) => s.inferredOperationIds),
    [["op-first"], ["op-second"]],
  );
  assert.ok(connections.every((s) => s.eventIds.length === 4));
  assert.equal(trace.spans.filter((s) => s.label === "tabs.create").length, 2);
  assert.equal(
    trace.spans.find((s) => s.id === "ambiguous")?.label,
    "底层操作 · tabs.create",
  );
  assert.equal(
    trace.events.length,
    events.length,
    "raw evidence is never removed",
  );
  const foreign = structuredClone(run);
  foreign.events.find((e) => e.data.operationId === "op-first")!.sessionId =
    "another-session";
  assert.ok(
    runTrace(foreign).spans.some((s) => s.id === "op-first"),
    "do not associate another session's operation",
  );
});

test("Service records exact SDK call IDs for concurrent operation traces", async () => {
  const f = fixture();
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    historyStore: f.history,
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  try {
    const session = await service.createSession();
    const result = await service.execute({
      sessionId: session.sessionId,
      code: "var b=await cua.connect(); var tabs=await Promise.all([b.tabs.create(),b.tabs.create()]);",
    });
    assert.equal(result.status, "succeeded");
    const run = f.history.read(session.runId);
    const operations = run.events.filter((e) => e.type === "operation.changed");
    assert.ok(operations.length);
    for (const event of operations) {
      assert.ok(event.callId);
      const start = run.events.find(
        (e) => e.type === "sdk.started" && e.callId === event.callId,
      );
      assert.ok(start);
      assert.equal(start.data.method, event.data.kind);
    }
    const creates = operations.filter((e) => e.data.kind === "tabs.create");
    assert.equal(new Set(creates.map((e) => e.callId)).size, 2);
    const trace = runTrace(run);
    assert.equal(
      trace.spans.filter((s) => s.label === "tabs.create").length,
      2,
    );
    assert.ok(
      !trace.spans.some(
        (s) => s.kind === "operation" || s.inferredOperationIds,
      ),
    );
  } finally {
    await service.close();
    f.cleanup();
  }
});

test("dashboard run body limit is configurable while default and over-limit requests remain rejected", async () => {
  for (const maxRunBodyBytes of [undefined, 131072]) {
    const f = fixture();
    let calls = 0;
    const app = await startDashboard({
      ...f,
      profiles: [{ name: "fake", provider: "fake" }],
      defaultProfile: "fake",
      port: 0,
      maxRunBodyBytes,
      execute: async () => {
        calls++;
        return { passed: true };
      },
    });
    try {
      const request = await client(app);
      const response = await request("/api/runs", {
        name: "echo",
        version: f.recipe.version,
        profile: "fake",
        requestId: "large",
        params: { message: "x".repeat(70000) },
      });
      assert.equal(response.status, maxRunBodyBytes ? 202 : 413);
      if (maxRunBodyBytes) await until(() => calls === 1);
      else assert.equal(calls, 0);
      const over = await request("/api/runs", {
        name: "echo",
        version: f.recipe.version,
        profile: "fake",
        requestId: "over",
        params: { message: "x".repeat(140000) },
      });
      assert.equal(over.status, 413);
      assert.equal(calls, maxRunBodyBytes ? 1 : 0);
    } finally {
      await app.close();
      f.cleanup();
    }
  }
});

test("dashboard rejects invalid run body limits before listening", async () => {
  const f = fixture();
  try {
    for (const maxRunBodyBytes of [0, -1, 1.5, NaN, Infinity, 16777217])
      await assert.rejects(
        startDashboard({
          ...f,
          profiles: [],
          defaultProfile: "fake",
          port: 0,
          maxRunBodyBytes,
          execute: async () => ({ passed: true }),
        }),
        /maxRunBodyBytes/,
      );
  } finally {
    f.cleanup();
  }
});
