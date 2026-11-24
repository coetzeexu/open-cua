import { traced } from "./recipe-provenance.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistoryStore } from "@cua/history";
import {
  RecipeStore,
  runRecipe,
  recipeParameters,
  requestAssistance,
  fulfillAssistance,
  type RecipeDraft,
} from "@cua/recipes";
import { CUAService } from "@cua/service";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import { MCPAdapter } from "@cua/mcp";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cua-history-test-"));
  const history = new FileHistoryStore({
    directory: join(directory, "history"),
  });
  const store = new RecipeStore({ directory: join(directory, "recipes") });
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    historyStore: history,
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  return {
    directory,
    history,
    store,
    provider,
    service,
    async close() {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function draft(sourceRunId: string, history: FileHistoryStore): RecipeDraft {
  return traced(
    {
      name: "demo",
      description: "Echo checked input",
      sourceRunId,
      parameters: { message: { type: "string", required: true } },
      preconditions: ["A browser profile is available"],
      script:
        "var browser = await cua.connect(); var tab = await browser.tabs.create(); output.text(params.message);",
      verify: 'return params.message === "expected";',
    },
    history,
  );
}
async function seed(f: ReturnType<typeof fixture>) {
  const session = await f.service.createSession({ goal: "A sample task" });
  const result = await f.service.execute({
    sessionId: session.sessionId,
    code: 'var browser=await cua.connect();var tab=await browser.tabs.create();await tab.getByRole("button",{name:"Save"}).click();output.text("done");',
    requestId: "record-once",
  });
  assert.equal(result.status, "succeeded");
  f.history.complete(session.runId, true);
  return { ...session, result };
}
test("execution history persists source, SDK calls, results and output after session close; duplicate requests do not execute or record twice", async () => {
  const f = fixture();
  try {
    const session = await seed(f);
    const first = f.history.read(session.runId);
    const source = first.events.find((e) => e.type === "execution.started")!
      .data.code;
    const duplicate = await f.service.execute({
      sessionId: session.sessionId,
      code: source,
      requestId: "record-once",
    });
    assert.equal(duplicate.executionId, session.result.executionId);
    assert.equal(
      f.history.read(session.runId).events.length,
      first.events.length,
    );
    assert.ok(
      first.events.some(
        (e) =>
          e.type === "sdk.started" &&
          e.data.method === "actions.click" &&
          JSON.stringify(e.data.args).includes("Save"),
      ),
    );
    assert.ok(
      first.events.some(
        (e) => e.type === "execution.output" && e.data.text === "done",
      ),
    );
    const dispatch = first.events.find(
      (e) =>
        e.type === "operation.changed" &&
        e.data.kind === "actions.click" &&
        e.data.phase === "dispatch",
    );
    assert.ok(dispatch);
    assert.ok(
      first.events.some(
        (e) =>
          e.type === "operation.changed" &&
          e.data.operationId === dispatch.data.operationId &&
          e.data.status === "succeeded",
      ),
    );
    await f.service.closeSession({ sessionId: session.sessionId });
    const reopened = new FileHistoryStore(f.history.config).read(session.runId);
    assert.equal(reopened.status, "succeeded");
    assert.equal(reopened.businessSuccess, true);
    assert.ok(reopened.events.find((e) => e.type === "session.closed"));
    // An interrupted temp file must never appear as an event.
    writeFileSync(join(f.history.directory, session.runId, "partial.tmp"), "{");
    assert.deepEqual(
      new FileHistoryStore(f.history.config).read(session.runId),
      reopened,
    );
  } finally {
    await f.close();
  }
});
test("MCP exposes the run association and accepts an explicit run across fresh sessions", async () => {
  const f = fixture();
  const adapter = new MCPAdapter(f.service);
  try {
    const first: any = await adapter.call("cua_session_create", {
      profile: "fake",
      runId: "task-shared",
      goal: "example",
    });
    assert.equal(first.structuredContent.runId, "task-shared");
    await adapter.call("cua_close", {
      sessionId: first.structuredContent.sessionId,
    });
    const next: any = await adapter.call("cua_session_create", {
      profile: "fake",
      runId: "task-shared",
    });
    assert.equal(next.structuredContent.runId, "task-shared");
    assert.equal(
      f.history
        .read("task-shared")
        .events.filter((e) => e.type === "session.created").length,
      2,
    );
  } finally {
    await adapter.close();
    await f.close();
  }
});
test("private transition scrubs prior bytes, artifacts and future source/output; traversal and upload default are rejected", async () => {
  const f = fixture();
  try {
    const s = await f.service.createSession();
    await f.service.execute({
      sessionId: s.sessionId,
      code: 'output.text("before-private-sentinel");',
    });
    f.history.artifact(
      s.runId,
      s.sessionId,
      Buffer.from("screenshot-sentinel"),
      "image/png",
    );
    await f.service.interruptSession({ sessionId: s.sessionId });
    await f.service.resumeSession({ sessionId: s.sessionId });
    await f.service.execute({
      sessionId: s.sessionId,
      code: 'output.text("after-private-sentinel");',
    });
    const path = join(f.history.directory, s.runId);
    const disk = readdirSync(path)
      .filter((v) => v.endsWith(".json"))
      .map((v) => readFileSync(join(path, v), "utf8"))
      .join("");
    assert.doesNotMatch(
      disk,
      /before-private-sentinel|after-private-sentinel|screenshot-sentinel/,
    );
    assert.ok(f.history.read(s.runId).events.some((e) => e.data.restricted));
    assert.throws(() => f.history.read("../escape"), /identifier/);
    assert.throws(() => f.history.delete(s.runId), /unclosed/);
    await assert.rejects(f.history.upload(s.runId), /disabled/);
  } finally {
    await f.close();
  }
});
test("write failure before dispatch executes nothing; terminal persistence failure is surfaced without claiming the action failed", async () => {
  const f = fixture();
  try {
    const s = await f.service.createSession();
    const append = f.history.append.bind(f.history);
    f.history.append = () => {
      throw Error("disk full");
    };
    await assert.rejects(
      f.service.execute({
        sessionId: s.sessionId,
        code: "var browser = await cua.connect();",
      }),
      { code: "HISTORY_WRITE_FAILED" },
    );
    assert.equal(f.provider.connection.pages.length, 0);
    f.history.append = (run, type, data, context) => {
      if (type === "execution.finished") throw Error("disk full");
      return append(run, type, data, context);
    };
    const r = await f.service.execute({
      sessionId: s.sessionId,
      code: 'output.text("did execute");',
    });
    assert.equal(r.status, "succeeded");
    assert.ok(r.warnings.some((w) => w.code === "HISTORY_WRITE_FAILED"));
    assert.equal(f.history.read(s.runId).status, "incomplete");
  } finally {
    await f.close();
  }
});

test("slow recorder I/O does not consume the cell deadline, while user code still times out", async () => {
  const f = fixture();
  try {
    const s = await f.service.createSession();
    const append = f.history.append.bind(f.history);
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    f.history.append = (run, type, data, context) => {
      if (type === "sdk.started" || type === "operation.changed")
        Atomics.wait(buffer, 0, 0, 25);
      return append(run, type, data, context);
    };
    const r = await f.service.execute({
      sessionId: s.sessionId,
      code: "var browser=await cua.connect(); var tab=await browser.tabs.create(); output.json(await tab.ax.snapshot());",
      timeoutMs: 150,
    });
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    let timeout = await f.service.execute({
      sessionId: s.sessionId,
      code: "await new Promise(() => {});",
      timeoutMs: 10,
    });
    while (timeout.status === "running")
      timeout = await f.service.getExecution({
        sessionId: s.sessionId,
        executionId: timeout.executionId,
      });
    assert.equal(timeout.status, "timed_out");
  } finally {
    await f.close();
  }
});
test("recipe parameters, explicit verification, immutable versions and activation evidence", async () => {
  const f = fixture();
  try {
    const s = await seed(f);
    await f.service.closeSession({ sessionId: s.sessionId });
    const recipe = f.store.save(draft(s.runId, f.history));
    assert.throws(() => recipeParameters(recipe, {}), /Missing/);
    assert.throws(() => recipeParameters(recipe, { message: 1 }), /Invalid/);
    assert.throws(
      () => recipeParameters(recipe, { message: "expected", extra: true }),
      /Unknown/,
    );
    assert.throws(
      () => f.store.activate(recipe.name, recipe.version),
      /local browser/,
    );
    const pass = await runRecipe({
      service: f.service,
      store: f.store,
      name: recipe.name,
      version: recipe.version,
      params: { message: "expected" },
      validate: true,
    });
    assert.equal(pass.passed, true);
    assert.equal(pass.environment, "fake");
    assert.equal(f.history.read(pass.runId).businessSuccess, true);
    assert.throws(
      () => f.store.activate(recipe.name, recipe.version),
      /local browser/,
    );
    const fail = await runRecipe({
      service: f.service,
      store: f.store,
      name: recipe.name,
      version: recipe.version,
      params: { message: "wrong" },
      validate: true,
    });
    assert.equal(fail.passed, false);
    assert.match(fail.result!.error!.message, /RECIPE_VERIFICATION_FAILED/);
    assert.equal(f.history.read(fail.runId).businessSuccess, false);
    const next = f.store.save({
      ...draft(s.runId, f.history),
      parentVersion: recipe.version,
      verify: "return true;",
    });
    assert.notEqual(next.version, recipe.version);
    assert.equal(
      f.store.read(recipe.name, recipe.version).verify,
      recipe.verify,
    );
    const malicious = f.store.read(recipe.name, next.version);
    writeFileSync(
      join(f.store.directory, recipe.name, next.version, "recipe.json"),
      JSON.stringify({ ...malicious, script: "throw Error('changed')" }),
    );
    assert.throws(() => f.store.read(recipe.name, next.version), /integrity/);
  } finally {
    await f.close();
  }
});
test("recipe polling advances output cursor and preserves earlier output", async () => {
  const f = fixture();
  try {
    const source = await seed(f);
    await f.service.closeSession({ sessionId: source.sessionId });
    const recipe = f.store.save(draft(source.runId, f.history));
    const execute = f.service.execute.bind(f.service);
    const poll = f.service.getExecution.bind(f.service);
    let expectedCursor: number | undefined;
    let polls = 0;
    // Model the first response arriving while the worker is still running,
    // with progress already delivered. A missing cursor used to busy-loop.
    f.service.execute = async (args) => {
      const done = await execute(args);
      expectedCursor = done.cursor;
      return { ...done, status: "running" };
    };
    f.service.getExecution = async (args) => {
      polls++;
      assert.equal(args.cursor, expectedCursor);
      return poll(args);
    };
    const result = await runRecipe({
      service: f.service, store: f.store,
      name: recipe.name, version: recipe.version,
      params: { message: "expected" }, validate: true,
    });
    assert.equal(polls, 1);
    assert.equal(result.passed, true);
    assert.equal(result.result!.output.filter(o => o.text === "expected").length, 1);
  } finally { await f.close(); }
});
test("manual/default and disabled modes never automatically invoke model; enabled assistance yields draft only and deduplicates", async () => {
  const f = fixture();
  try {
    const s = await seed(f);
    await f.service.closeSession({ sessionId: s.sessionId });
    let calls = 0;
    const model = async () => {
      calls++;
      return draft(s.runId, f.history);
    };
    const base = {
      store: f.store,
      history: f.history,
      runId: s.runId,
      kind: "distill" as const,
      model,
    };
    assert.equal(
      (await requestAssistance({ ...base, trigger: "auto" })).status,
      "disabled",
    );
    assert.equal(calls, 0);
    const pending = await requestAssistance({
      ...base,
      model: undefined,
      trigger: "manual",
    });
    assert.equal(pending.status, "model_required");
    const done: any = await requestAssistance({ ...base, trigger: "manual" });
    assert.equal(calls, 1);
    assert.equal(done.status, "draft_created");
    await requestAssistance({ ...base, trigger: "manual" });
    assert.equal(calls, 1);
    assert.throws(() => f.store.read(done.draft.name), /ENOENT/);
    const off = new RecipeStore({
      ...f.store.config,
      distill: { mode: "disabled" },
    });
    assert.equal(
      (await requestAssistance({ ...base, store: off, trigger: "manual" }))
        .status,
      "disabled",
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        fulfillAssistance(
          off,
          f.history,
          pending.id!,
          draft(s.runId, f.history),
        ),
      /disabled/,
    );
  } finally {
    await f.close();
  }
});
test("auto repair delegates once with failed history and parent; never runs or activates generated code", async () => {
  const f = fixture();
  try {
    const s = await seed(f);
    await f.service.closeSession({ sessionId: s.sessionId });
    const recipe = f.store.save(draft(s.runId, f.history));
    const fail = await runRecipe({
      service: f.service,
      store: f.store,
      name: recipe.name,
      version: recipe.version,
      params: { message: "wrong" },
      validate: true,
    });
    const store = new RecipeStore({
      ...f.store.config,
      repair: { mode: "auto" },
    });
    let count = 0;
    const r: any = await requestAssistance({
      store,
      history: f.history,
      kind: "repair",
      trigger: "auto",
      runId: fail.runId,
      recipe: { name: recipe.name, version: recipe.version },
      model: async (input) => {
        count++;
        assert.equal(input.history.status, "failed");
        return {
          ...draft(fail.runId, f.history),
          parentVersion: recipe.version,
          script: 'throw Error("must not run");',
        };
      },
    });
    assert.equal(count, 1);
    assert.equal(r.status, "draft_created");
    assert.equal(
      store.read(recipe.name, r.draft.version).parentVersion,
      recipe.version,
    );
    assert.deepEqual(store.validations(recipe.name, r.draft.version), []);
    assert.throws(() => store.read(recipe.name), /ENOENT/);
  } finally {
    await f.close();
  }
});

test("disabled recording leaves no history; truncated events retain execution status and incomplete runs cannot be confirmed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cua-history-limits-"));
  try {
    const disabled = new FileHistoryStore({
      directory: join(directory, "disabled"),
      enabled: false,
    });
    disabled.append("run", "execution.started", { code: "not persisted" });
    assert.deepEqual(disabled.list(), []);
    const history = new FileHistoryStore({
      directory: join(directory, "enabled"),
      maxEventBytes: 1024,
    });
    history.append(
      "run",
      "execution.started",
      { code: "start" },
      { executionId: "exec" },
    );
    assert.equal(history.read("run").status, "incomplete");
    assert.throws(() => history.complete("run", true), /successful/);
    history.append(
      "run",
      "execution.finished",
      { status: "succeeded", output: "x".repeat(2000) },
      { executionId: "exec" },
    );
    const run = history.read("run");
    assert.equal(run.status, "succeeded");
    assert.equal(run.events.at(-1)!.data.truncated, true);
    assert.equal(run.events.at(-1)!.data.restricted, undefined);
    history.complete("run", true);
    assert.equal(history.read("run").businessSuccess, true);
    history.append("run", "execution.started", {}, { executionId: "next" });
    history.append(
      "run",
      "execution.finished",
      { status: "succeeded" },
      { executionId: "next" },
    );
    assert.equal(
      history.read("run").businessSuccess,
      false,
      "A later execution needs a new business confirmation",
    );
    assert.throws(
      () =>
        new FileHistoryStore({
          upload: { enabled: true, endpoint: "http://example.test" },
        }),
      /HTTPS/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("auto distillation needs business confirmation; explicit parameter strings cannot escape the wrapper", async () => {
  const f = fixture();
  try {
    const s = await f.service.createSession();
    await f.service.execute({
      sessionId: s.sessionId,
      code: 'output.text("technical success only")',
    });
    await f.service.closeSession({ sessionId: s.sessionId });
    const store = new RecipeStore({
      ...f.store.config,
      distill: { mode: "auto" },
    });
    let modelCalls = 0;
    const request = {
      store,
      history: f.history,
      kind: "distill" as const,
      trigger: "auto" as const,
      runId: s.runId,
      model: async () => {
        modelCalls++;
        return draft(s.runId, f.history);
      },
    };
    await assert.rejects(requestAssistance(request), /business success/);
    assert.equal(modelCalls, 0);
    f.history.complete(s.runId, true);
    await requestAssistance(request);
    assert.equal(modelCalls, 1);
    const recipe = f.store.save(
      traced(
        {
          ...draft(s.runId, f.history),
          verify: 'return typeof params.message === "string";',
        },
        f.history,
      ),
    );
    const value = '\"); throw Error("parameter executed"); //';
    const run = await runRecipe({
      service: f.service,
      store: f.store,
      name: recipe.name,
      version: recipe.version,
      params: { message: value },
      validate: true,
    });
    assert.equal(run.passed, true);
    assert.ok(run.result?.output.some((o) => o.text === value));
    assert.equal(run.browserObserved, false);
    assert.throws(
      () => store.activate(recipe.name, recipe.version),
      /local browser/,
    );
    const premature = store.save(
      traced(
        {
          ...draft(s.runId, f.history),
          script: "return true;",
          verify:
            'if (typeof params.message !== "string") throw Error("invalid"); throw Error("verification must run");',
        },
        f.history,
      ),
    );
    const bypass = await runRecipe({
      service: f.service,
      store,
      name: premature.name,
      version: premature.version,
      params: { message: "expected" },
      validate: true,
    });
    assert.equal(bypass.passed, false);
    assert.equal(bypass.result?.status, "failed");
    assert.match(bypass.result!.error!.message, /RECIPE_VERIFICATION_SKIPPED/);
  } finally {
    await f.close();
  }
});

test("structured parameters validate every row before execution and isolate defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "cua-params-"));
  try {
    const store = new RecipeStore({ directory });
    const base: RecipeDraft = {
      name: "structured",
      sourceRunId: "source",
      description: "structured",
      preconditions: [],
      script: "void params.order;",
      verify: "return true;",
      parameters: {
        order: {
          type: "object",
          required: true,
          properties: {
            rows: {
              type: "array",
              required: true,
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  code: { type: "string", required: true },
                  quantity: { type: "number", required: true, minimum: 0.01 },
                  role: {
                    type: "string",
                    enum: ["main", "byproduct"],
                    default: "main",
                  },
                },
              },
            },
            dispatch: { type: "boolean", default: true },
          },
        },
        options: {
          type: "object",
          default: {},
          properties: { label: { type: "string", default: "test" } },
        },
      },
    };
    const r = store.save(base);
    const input = {
      order: {
        rows: [
          { code: "A", quantity: 2 },
          { code: "B", quantity: 3 },
        ],
      },
    };
    const resolved = recipeParameters(r, input) as any;
    assert.deepEqual(JSON.parse(JSON.stringify(resolved)), {
      order: {
        rows: [
          { code: "A", quantity: 2, role: "main" },
          { code: "B", quantity: 3, role: "main" },
        ],
        dispatch: true,
      },
      options: { label: "test" },
    });
    resolved.order.rows[0].code = "changed";
    resolved.options.label = "changed";
    assert.equal(input.order.rows[0].code, "A");
    assert.equal((recipeParameters(r, input).options as any).label, "test");
    for (const [rows, pattern] of [
      [[{ code: "A", quantity: "2" }], /params.order.rows\[0\].quantity/],
      [[{ code: "A", quantity: NaN }], /quantity/],
      [[{ code: "A", quantity: 0 }], /quantity/],
      [[{ quantity: 1 }], /Missing.*code/],
      [[{ code: "A", quantity: 1, extra: 1 }], /Unknown.*extra/],
      [[{ code: "A", quantity: 1, role: "wrong" }], /role/],
      [[], /array length/],
      [null, /array length/],
      [[null], /expected object/],
    ] as const)
      assert.throws(() => recipeParameters(r, { order: { rows } }), pattern);
    assert.throws(
      () =>
        recipeParameters(r, JSON.parse('{"order":{"rows":[],"__proto__":{}}}')),
      /Unknown/,
    );
    assert.throws(
      () =>
        store.save({
          ...base,
          parameters: {
            x: { type: "object", properties: { password: { type: "string" } } },
          },
        }),
      /private CUA/,
    );
    assert.throws(
      () =>
        store.save({
          ...base,
          parameters: {
            x: { type: "array", items: { type: "number" }, default: ["wrong"] },
          },
        }),
      /Invalid default/,
    );
    assert.throws(
      () =>
        store.save({ ...base, parameters: { x: { type: "array" } as any } }),
      /schema/,
    );
    assert.throws(
      () =>
        store.save({
          ...base,
          parameters: { x: { type: "string", minLength: 1 } as any },
        }),
      /Unknown schema/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
