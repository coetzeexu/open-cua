import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const until = async (check: () => boolean) => {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw Error("UI did not reach expected state");
    await new Promise((r) => setTimeout(r, 10));
  }
};
test("dashboard UI navigates script versions and traces, filters evidence, and submits typed active-version parameters", async () => {
  const window = new Window({
    url: "http://127.0.0.1:30152",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  const stats = {
    total: 1,
    completed: 1,
    passed: 0,
    failed: 1,
    unverified: 0,
    successRate: 0,
    averageMs: 1000,
    validations: 1,
  };
  const recipe = {
    name: "demo",
    version: "active-version",
    hash: "hash",
    description: "Example <script>untrusted()</script>",
    created: 1000,
    sourceRunId: "source",
    preconditions: ["Available fixture"],
    parameters: {
      message: { type: "string", required: true },
      count: { type: "number", required: true },
      flag: { type: "boolean", default: false },
      order: {
        type: "object",
        required: true,
        properties: { rows: { type: "array", items: { type: "number" } } },
      },
    },
    script: 'output.text("<img src=x onerror=bad()>");',
    verify: "return params.count === 3;",
    validations: [],
  };
  const summary = {
    runId: "failed-run",
    name: "demo",
    version: recipe.version,
    start: 1000,
    end: 2000,
    eventCount: 4,
    status: "failed",
    mode: "run",
    metrics: { durationMs: 1000, operations: 1, failedExecutions: 1 },
    params: {
      message: "previous",
      count: 3,
      flag: false,
      order: { rows: [1, 2] },
    },
  };
  const trace = {
    ...summary,
    durationMs: 1000,
    spans: [
      {
        id: "exec",
        kind: "execution",
        label: "Execution 1",
        start: 1000,
        end: 2000,
        status: "failed",
        eventIds: ["a", "d"],
      },
      {
        id: "call",
        parentId: "exec",
        kind: "sdk",
        label: "waitForFunction",
        start: 1100,
        end: 1900,
        status: "failed",
        eventIds: ["b", "c"],
      },
    ],
    events: [
      {
        id: "a",
        time: 1000,
        type: "execution.started",
        data: { code: recipe.script },
      },
      {
        id: "b",
        time: 1100,
        type: "sdk.started",
        data: { method: "waitForFunction", args: { timeoutMs: 1000 } },
      },
      {
        id: "c",
        time: 1900,
        type: "sdk.finished",
        data: { status: "failed", error: { code: "EVALUATE_ABANDONED" } },
      },
      {
        id: "d",
        time: 2000,
        type: "execution.finished",
        data: { status: "failed" },
      },
    ],
    error: { code: "EVALUATE_ABANDONED", message: "wait failed" },
    outputs: [
      {
        text: JSON.stringify({
          products: [
            {
              title: "dress",
              company: "supplier",
              price: 20,
              offerUrl: "https://example.test",
            },
          ],
        }),
      },
    ],
    artifacts: [{ eventId: "shot", time: 1900 }],
    analysis: { blockers: [], warnings: [] },
  };
  const snapshot = {
    recipes: [
      {
        ...recipe,
        active: recipe.version,
        sources: ["source"],
        versions: [
          {
            version: recipe.version,
            created: 1000,
            hash: "hash",
            validations: [],
          },
          {
            version: "old-version",
            created: 500,
            hash: "oldhash",
            validations: [],
          },
        ],
        stats,
      },
    ],
    runs: [summary, {
      ...summary, runId: "successful-run", status: "succeeded",
      businessSuccess: true, profile: "logged-in",
    }],
    stats,
    jobs: [] as any[],
    warnings: [],
    profiles: [{ name: "local", provider: "local" }, { name: "logged-in", provider: "local" }],
    defaultProfile: "local",
    historyEnabled: true,
    configLabel: "fixture.json",
  };
  const posts: any[] = [];
  (window as any).fetch = async (path: string, options: any = {}) => {
    assert.equal(options.headers["x-cua-token"], "test-token");
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      posts.push(body);
      snapshot.jobs = [
        {
          id: body.requestId,
          runId: "new-run",
          name: "demo",
          version: recipe.version,
          status: "queued",
        },
      ];
      return new Response(JSON.stringify(snapshot.jobs[0]), { status: 202 });
    }
    if (path === "/api/state") return new Response(JSON.stringify(snapshot));
    if (path.startsWith("/api/recipes/"))
      return new Response(
        JSON.stringify({
          ...recipe,
          version: path.includes("old-version")
            ? "old-version"
            : recipe.version,
        }),
      );
    if (path.endsWith("/artifacts/shot"))
      return new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/png" },
      });
    if (path === "/api/runs/new-run")
      return new Response(JSON.stringify({ error: "记录尚未创建" }), {
        status: 404,
      });
    if (path === "/api/runs/failed-run")
      return new Response(JSON.stringify(trace));
    throw Error("Unexpected request " + path);
  };
  (window.URL as any).createObjectURL = () => "blob:fixture";
  (window.URL as any).revokeObjectURL = () => {};
  const doc = window.document;
  const click = (selector: string) => {
    const el = doc.querySelector(selector) as any;
    assert.ok(el, selector);
    el.click();
  };
  try {
    doc.write(
      readFileSync("packages/dashboard/dist/index.html", "utf8")
        .replace("__SESSION_TOKEN__", "test-token")
        .replace(/<script[^>]*><\/script>/g, ""),
    );
    window.eval(readFileSync("packages/dashboard/dist/app.js", "utf8"));
    await until(() => !!doc.querySelector("[data-recipe=demo]"));
    assert.ok(
      doc.getElementById("catalog")!.textContent.includes(recipe.description),
    );
    assert.equal(doc.querySelectorAll("#catalog script").length, 0);
    click("[data-recipe=demo]");
    await until(() => !!doc.querySelector("[data-span=call]"));
    click("[data-span=call]");
    assert.ok(
      doc
        .getElementById("detail-drawer")!
        .textContent.includes("EVALUATE_ABANDONED"),
    );
    assert.ok(
      doc.getElementById("detail-drawer")!.textContent.includes("timeoutMs"),
    );
    click("[data-collapse=exec]");
    assert.equal(doc.querySelector("[data-span=call]"), null);
    click("[data-collapse=exec]");
    assert.ok(doc.querySelector("[data-span=call]"));
    click("[data-trace-tab=events]");
    const search = doc.getElementById("event-search") as any;
    search.value = "ABANDONED";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(doc.querySelectorAll("#event-list details").length, 1);
    click("[data-trace-tab=evidence]");
    click("[data-artifact=shot]");
    await until(() => !!doc.querySelector("#artifact-shot img"));
    click("[data-tab=code]");
    assert.equal((doc.getElementById("code-panel") as any).hidden, false);
    assert.ok(
      doc.getElementById("code-panel")!.textContent.includes(recipe.script),
    );
    assert.equal(doc.querySelectorAll("#code-panel img").length, 0);
    const version = doc.getElementById("version-select") as any;
    version.value = "old-version";
    version.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() =>
      doc.getElementById("code-panel")!.textContent.includes("old-vers"),
    );
    click("[data-action=run]");
    await until(() => !!doc.getElementById("param-0"));
    assert.ok(
      doc.getElementById("run-form-content")!.textContent.includes("active-v"),
    );
    assert.equal((doc.getElementById("run-profile") as any).value, "logged-in");
    assert.equal((doc.getElementById("param-0") as any).value, "previous");
    assert.equal(doc.getElementById("param-3")!.tagName, "TEXTAREA");
    assert.deepEqual(JSON.parse((doc.getElementById("param-3") as any).value), {
      rows: [1, 2],
    });
    (doc.getElementById("param-3") as any).value = "{";
    doc
      .getElementById("run-form")!
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    assert.equal(posts.length, 0);
    assert.match(doc.getElementById("form-error")!.textContent, /JSON/);
    (doc.getElementById("param-3") as any).value = '{"rows":[3,4,5]}';
    (doc.getElementById("param-0") as any).value = "edited";
    (doc.getElementById("param-1") as any).value = "5";
    (doc.getElementById("param-2") as any).value = "true";
    doc
      .getElementById("run-form")!
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await until(() => posts.length === 1 && !!doc.querySelector(".job-strip"));
    assert.equal(posts[0].version, recipe.version);
    assert.deepEqual(posts[0].params, {
      message: "edited",
      count: 5,
      flag: true,
      order: { rows: [3, 4, 5] },
    });
    assert.equal(posts[0].profile, "logged-in");
    assert.ok(posts[0].requestId);
    assert.ok(doc.getElementById("notice")!.textContent.includes("任务已提交"));
  } catch (e) {
    console.error("UI assertion", e);
    throw e;
  } finally {
    await window.happyDOM.close();
  }
});
