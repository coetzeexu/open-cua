import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileHistoryStore } from "@cua/history";
import { RecipeStore, runRecipe } from "@cua/recipes";
import { traced } from "./recipe-provenance.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUAService } from "@cua/service";
import { MCPAdapter, mapResult } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import { analyzeRun, type RunHistory, type HistoryEvent } from "@cua/history";
import { reviewRecipe, type RecipeDraft } from "@cua/recipes";

test("text-only MCP host discovers default profile and polls using content; API mistakes explain correction without retry", async () => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    history: { enabled: false },
    executeWaitMs: 1,
    defaultProfile: "chosen",
    profiles: {
      chosen: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  const adapter = new MCPAdapter(service);
  const text = (r: any) =>
    JSON.parse(r.content.filter((x: any) => x.type === "text").at(-1).text);
  try {
    const created = text(await adapter.call("cua_session_create", {}));
    assert.equal(created.profile, "chosen");
    assert.match(created.apiReference.navigation, /tab.info/);
    const sessionId = created.sessionId;
    const exec = async (code: string) => {
      let r = text(await adapter.call("cua_exec", { sessionId, code }));
      assert.ok(r.executionId && r.runId && typeof r.cursor === "number");
      while (r.status === "running")
        r = text(
          await adapter.call("cua_poll", {
            sessionId,
            executionId: r.executionId,
            cursor: r.cursor,
            waitMs: 100,
          }),
        );
      return r;
    };
    assert.equal(
      (
        await exec(
          "var b=await cua.connect();var t=await b.tabs.create();await new Promise(r=>setTimeout(r,25));",
        )
      ).status,
      "succeeded",
    );
    for (const [code, hint] of [
      ["t.url", "tab.info"],
      ["await t.navigate('https://example.com')", "tab.goto"],
      ["await t.scroll(0,20)", "tab.actions.scroll"],
      ["t.locator('button').first()", "unique selector"],
      ["t.locator('button').boundingBox()", "dom.inspect"],
      ["t.locator('button').scrollIntoViewIfNeeded()", "actions.scroll"],
    ]) {
      const r = await exec(code);
      assert.equal(r.status, "failed");
      assert.ok(r.error.message.includes(hint), JSON.stringify(r));
      assert.equal(r.operations.length, 0, "usage hints never retry an action");
    }
    assert.equal(provider.connection.pages[0].inputEvents.length, 0);
    const status = text(
      mapResult({
        executionId: "e",
        status: "running",
        runId: "r",
        cursor: 3,
        operations: [],
        warnings: [
          {
            code: "USER_ACTION_REQUIRED",
            message: "continue privately",
            requestId: "private-request",
          },
        ],
      }),
    );
    assert.equal(status.warnings[0].requestId, "private-request");
  } finally {
    await adapter.close();
    await service.close();
  }
});

function recorded(): RunHistory {
  const event = (
    id: string,
    type: string,
    data: any,
    executionId = "cell-1",
    time = Number(id.replace(/\D/g, "")),
  ): HistoryEvent => ({ id, time, runId: "source", type, executionId, data });
  return {
    runId: "source",
    status: "succeeded",
    businessSuccess: true,
    events: [
      event("e1", "execution.started", {
        code: "await sleep(3000); await tab.click(); throw Error('detour')",
      }),
      event("e2", "operation.changed", {
        operationId: "op-click",
        kind: "actions.click",
        tabId: "tab-original",
        status: "succeeded",
        phase: "after_dispatch",
        outcome: "executed",
      }),
      event("e3", "execution.finished", {
        status: "failed",
        operations: [
          {
            operationId: "op-click",
            kind: "actions.click",
            tabId: "tab-original",
            status: "succeeded",
            phase: "after_dispatch",
            outcome: "executed",
          },
        ],
      }),
      event(
        "e4",
        "execution.started",
        { code: "output.json(await tab.dom.inspect());" },
        "cell-2",
      ),
      event(
        "e5",
        "sdk.finished",
        {
          status: "succeeded",
          method: "dom.inspect",
          tabId: "tab-original",
          value: { text: "receipt" },
        },
        "cell-2",
      ),
      event(
        "e6",
        "execution.finished",
        { status: "succeeded", operations: [] },
        "cell-2",
      ),
    ],
  };
}
function proposal(run: RunHistory): RecipeDraft {
  const a = analyzeRun(run);
  return {
    name: "test",
    description: "Fixture receipt",
    sourceRunId: run.runId,
    parameters: { date: { type: "string" } },
    preconditions: ["local fixture"],
    script: "var b=await cua.connect(); var tab=await b.tabs.create();",
    verify:
      "return (await tab.dom.inspect()).elements[0].text === params.date;",
    provenance: {
      sourceFingerprint: a.fingerprint,
      steps: a.executions.map((e) => ({
        sourceEventId: e.sourceEventId,
        disposition: "change",
        reason:
          "Preserve one click and verify receipt, omit unsupported method",
        evidenceEventIds: ["e5"],
      })),
      resolutions: [],
      assertions: [
        {
          description: "Receipt matches date",
          expression: ".text === params.date",
          evidenceEventIds: ["e5"],
        },
      ],
      parameterChecks: [
        { name: "date", expression: "params.date", evidenceEventIds: ["e5"] },
      ],
      waits: [
        {
          sourceEventId: "e1",
          strategy: "condition",
          reason: "wait for receipt",
        },
      ],
    },
  };
}
test("analysis preserves successful effects of failed cells, wait candidates and stable fingerprint without rewriting history", () => {
  const run = recorded(),
    before = JSON.stringify(run),
    a = analyzeRun(run);
  assert.equal(a.failedCellEffects[0].operationId, "op-click");
  assert.equal(a.metrics.failedExecutions, 1);
  assert.equal(a.metrics.fixedWaitLiteralMs, 3000);
  assert.equal(
    a.operations.length,
    1,
    "operation phase events are deduplicated",
  );
  const draft = proposal(run);
  assert.deepEqual(reviewRecipe(draft, run).blockers, []);
  draft.provenance!.steps[0].disposition = "drop";
  draft.provenance!.steps[0].evidenceEventIds = [];
  assert.ok(
    reviewRecipe(draft, run).blockers.some((b) =>
      b.startsWith("DROPPED_EFFECT"),
    ),
  );
  assert.equal(JSON.stringify(run), before);
  run.events.push({
    ...run.events[0],
    id: "administrative",
    type: "assistance.draft_created",
    data: {},
  });
  assert.equal(analyzeRun(run).fingerprint, a.fingerprint);
});
test("unknown effects need later same-tab observation, not a successful final cell or model claim", () => {
  const run = recorded();
  run.events[1].data.outcome = "unknown";
  run.events[2].data.operations[0].outcome = "unknown";
  const draft = proposal(run);
  assert.ok(
    reviewRecipe(draft, run).blockers.some((b) =>
      b.startsWith("UNRESOLVED_EFFECT"),
    ),
  );
  draft.provenance!.resolutions = [
    {
      operationId: "op-click",
      reason: "Receipt proves click completed; replay only once in fresh test",
      evidenceEventIds: ["e5"],
    },
  ];
  assert.deepEqual(reviewRecipe(draft, run).blockers, []);
  run.events[4].data.tabId = "different-tab";
  draft.provenance!.sourceFingerprint = analyzeRun(run).fingerprint;
  assert.ok(
    reviewRecipe(draft, run).blockers.some((b) =>
      b.startsWith("UNRESOLVED_EFFECT"),
    ),
  );
});
test("review rejects stale identifiers, lost assertions/parameter checks, missing provenance and incomplete evidence", () => {
  const run = recorded(),
    draft = proposal(run);
  assert.ok(
    reviewRecipe({ ...draft, provenance: undefined }, run).blockers.includes(
      "PROVENANCE_REQUIRED",
    ),
  );
  assert.ok(
    reviewRecipe(
      { ...draft, script: draft.script + ' output.text("tab-original");' },
      run,
    ).blockers.includes("HISTORICAL_HANDLE_LITERAL"),
  );
  assert.ok(
    reviewRecipe({ ...draft, verify: "return true;" }, run).blockers.includes(
      "BUSINESS_ASSERTION_EVIDENCE_REQUIRED",
    ),
  );
  const parent = structuredClone(draft);
  parent.provenance!.assertions[0].description = "Must export exactly once";
  assert.ok(
    reviewRecipe(draft, run, parent).blockers.some((b) =>
      b.startsWith("LOST_PARENT_ASSERTION"),
    ),
  );
  run.events[0].data.truncated = true;
  assert.ok(reviewRecipe(draft, run).blockers.includes("TRUNCATED_HISTORY"));
  run.events.pop();
  assert.ok(analyzeRun(run).blockers.includes("INCOMPLETE_HISTORY"));
});

test("unresolved source blocks direct CLI import and validation before a browser session; legacy validations cannot activate", async () => {
  const root = mkdtempSync(join(tmpdir(), "cua-quality-gate-"));
  const history = new FileHistoryStore({ directory: join(root, "history") });
  const store = new RecipeStore({ directory: join(root, "recipes") });
  let providerCreated = 0;
  const service = new CUAService({
    historyStore: history,
    profiles: {
      fake: () => {
        providerCreated++;
        return {
          browser: new FakeBrowserProvider(),
          capabilities: fakeCapabilities(),
          targetResolvers: [fakeResolver],
        };
      },
    },
  });
  try {
    const source = recorded();
    source.events[1].data.outcome = "unknown";
    source.events[2].data.operations[0].outcome = "unknown";
    // Keep the later cell technically successful but remove its observation evidence.
    source.events = source.events.filter((e) => e.type !== "sdk.finished");
    for (const e of source.events)
      history.append(source.runId, e.type, e.data, {
        executionId: e.executionId,
      });
    history.complete(source.runId, true);
    const draft = traced(proposal(recorded()), history);
    const saved = store.save(draft);
    await assert.rejects(
      runRecipe({
        service,
        store,
        name: saved.name,
        version: saved.version,
        validate: true,
        params: { date: "today" },
      }),
      /UNRESOLVED_EFFECT/,
    );
    assert.equal(providerCreated, 0);
    assert.equal(service.status().length, 0);
    store.recordValidation(saved, {
      runId: "old-validation",
      environment: "local-browser",
      passed: true,
      browserObserved: true,
    });
    assert.throws(
      () => store.activate(saved.name, saved.version),
      /provenance review/,
    );
    const config = join(root, "config.json"),
      file = join(root, "draft.json");
    writeFileSync(
      config,
      JSON.stringify({
        history: history.config,
        recipes: store.config,
        profiles: { local: { provider: "local" } },
      }),
    );
    writeFileSync(file, JSON.stringify(draft));
    const before = store.list()[0].versions.length;
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        resolve("packages/cli/dist/index.js"),
        "recipe",
        "import",
        file,
        "--config",
        config,
      ]),
      /UNRESOLVED_EFFECT/,
    );
    assert.equal(
      store.list()[0].versions.length,
      before,
      "direct import cannot bypass review",
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized read evidence is unusable but does not block unrelated complete evidence", () => {
  const run = recorded();
  run.events.splice(4, 0, {
    id: "read-start",
    time: 4,
    runId: run.runId,
    type: "sdk.started",
    executionId: "cell-2",
    callId: "large-read",
    data: { method: "ax.snapshot" },
  });
  run.events.splice(5, 0, {
    id: "read-end",
    time: 5,
    runId: run.runId,
    type: "sdk.finished",
    executionId: "cell-2",
    callId: "large-read",
    data: { status: "succeeded", truncated: true, originalBytes: 900000 },
  });
  const a = analyzeRun(run);
  assert.equal(a.missingEvidence[0].critical, false);
  assert.deepEqual(a.blockers, []);
  const draft = proposal(run);
  assert.deepEqual(reviewRecipe(draft, run).blockers, []);
  draft.provenance!.assertions[0].evidenceEventIds = ["read-end"];
  assert.ok(
    reviewRecipe(draft, run).blockers.includes(
      "BUSINESS_ASSERTION_EVIDENCE_REQUIRED",
    ),
  );
  run.events[4].data.method = "actions.click";
  assert.ok(analyzeRun(run).blockers.includes("TRUNCATED_HISTORY"));
});

test("direct draft review retains the business-success gate", () => {
  const run = recorded();
  run.businessSuccess = false;
  assert.ok(
    reviewRecipe(proposal(run), run).blockers.includes(
      "SOURCE_BUSINESS_SUCCESS_REQUIRED",
    ),
  );
});
