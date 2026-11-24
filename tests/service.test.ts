import { test } from "node:test";
import assert from "node:assert/strict";
import { CUAService } from "@cua/service";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
const setup = async (options: Record<string, unknown> = {}) => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities({ stepDelayMs: 30, steps: 3 }),
        targetResolvers: [fakeResolver],
      }),
    },
    executeWaitMs: 1000,
    terminationGraceMs: 100,
    ...options,
  });
  const { sessionId } = await service.createSession();
  return {
    service,
    sessionId,
    provider,
    exec: (code: string, extra: Record<string, unknown> = {}) =>
      service.execute({ sessionId, code, ...extra }),
  };
};
test("worker persists variables, drains forgotten await, deduplicates, resets and closes browser", async () => {
  const { service, sessionId, provider, exec } = await setup();
  try {
    let r = await exec(
      "var browser=await cua.connect();var tab=await browser.tabs.create();var n=1;",
    );
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    r = await exec('tab.getByRole("button").click();n++;output.json(n);', {
      requestId: "once",
    });
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    assert.equal(provider.connection.pages[0].inputEvents.length, 3);
    assert.equal(r.output[0].text, "2");
    const dup = await exec(
      'tab.getByRole("button").click();n++;output.json(n);',
      { requestId: "once" },
    );
    assert.equal(dup.executionId, r.executionId);
    assert.equal(provider.connection.pages[0].inputEvents.length, 3);
    await assert.rejects(exec("n++;", { requestId: "once" }), {
      code: "REQUEST_ID_CONFLICT",
    });
    await service.resetSession({ sessionId });
    r = await exec(
      "var browser=await cua.connect();var tab=(await browser.tabs.list())[0];output.text(typeof n);",
    );
    assert.equal(r.status, "succeeded");
    assert.equal(r.output[0].text, "undefined");
    assert.equal(provider.connection.pages.length, 1);
  } finally {
    await service.close();
  }
  assert.equal(provider.connection.connected, false);
});
for (const trigger of ["cancel", "timeout"])
  test(`${trigger}: catch/finally on another tab gets SCOPE_CLOSED and dispatches no input`, async () => {
    const { service, sessionId, provider, exec } = await setup({
      executeWaitMs: 5,
    });
    try {
      let r = await exec(
        "var browser=await cua.connect();var a=await browser.tabs.create();var b=await browser.tabs.create();",
      );
      if (r.status === "running")
        r = await service.getExecution({
          sessionId,
          executionId: r.executionId,
        });
      assert.equal(r.status, "succeeded");
      r = await exec(
        'var codes=[];try { await a.getByRole("button").click(); } catch(e){try{await b.getByRole("button").click()}catch(e){codes.push(e.code)}} finally {try{await b.getByRole("button").click()}catch(e){codes.push(e.code)}}',
        { timeoutMs: trigger === "timeout" ? 15 : 1000 },
      );
      r =
        trigger === "cancel"
          ? await service.cancelExecution({
              sessionId,
              executionId: r.executionId,
            })
          : await service.getExecution({
              sessionId,
              executionId: r.executionId,
            });
      assert.equal(
        r.status,
        trigger === "cancel" ? "cancelled" : "timed_out",
        JSON.stringify(r),
      );
      assert.equal(r.stateImpact, "none");
      assert.equal(provider.connection.pages[1].inputEvents.length, 0);
      r = await exec("output.json(codes)");
      if (r.status === "running")
        r = await service.getExecution({
          sessionId,
          executionId: r.executionId,
        });
      assert.deepEqual(JSON.parse(r.output[0].text!), [
        "SCOPE_CLOSED",
        "SCOPE_CLOSED",
      ]);
    } finally {
      await service.close();
    }
  });
test("ordinary infinite module restarts worker, session remains busy until termination completes", async () => {
  const { service, sessionId, exec } = await setup({ executeWaitMs: 1 });
  try {
    let r = await exec("var before=1;await new Promise(()=>{});", {
      timeoutMs: 20,
    });
    await assert.rejects(exec("1"), { code: "SESSION_BUSY" });
    r = await service.getExecution({ sessionId, executionId: r.executionId });
    assert.equal(r.status, "timed_out");
    assert.equal(r.stateImpact, "repl_restarted");
    assert.equal(r.error?.code, "WORKER_UNRESPONSIVE");
    r = await exec("output.text(typeof before)");
    if (r.status === "running")
      r = await service.getExecution({ sessionId, executionId: r.executionId });
    assert.equal(r.output[0].text, "undefined");
  } finally {
    await service.close();
  }
});
test("late timer SDK calls warn; injected callback exceptions are cell errors without restart", async () => {
  const { service, sessionId, exec } = await setup();
  try {
    let r = await exec(
      "var browser=await cua.connect();setTimeout(()=>browser.tabs.create().catch(()=>{}),30);",
    );
    assert.equal(r.status, "succeeded");
    await new Promise((r) => setTimeout(r, 60));
    r = await exec('output.text("next")');
    assert.ok(r.warnings.some((w) => w.code === "SCOPE_CLOSED"));
    r = await exec(
      'setTimeout(()=>{throw Error("timer fail")},1);await new Promise(r=>setTimeout(r,20));',
    );
    assert.equal(r.status, "failed");
    assert.equal(r.stateImpact, "none");
    assert.match(r.error!.message, /timer fail/);
  } finally {
    await service.close();
  }
});
test("unhandled user promise is attributed without killing the worker", async () => {
  const { service, exec } = await setup();
  try {
    const r = await exec(
      'Promise.reject(Error("owned rejection"));await new Promise(r=>setTimeout(r,20));',
    );
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "USER_CODE_ERROR");
    assert.equal(r.stateImpact, "none");
    assert.equal((await exec('output.text("alive")')).status, "succeeded");
  } finally {
    await service.close();
  }
});
test("output limits and result expiry preserve dedup tombstone", async () => {
  const { service, sessionId, exec } = await setup({
    maxTextChars: 5,
    maxResults: 1,
  });
  try {
    const r = await exec('output.text("abcdefghij")', { requestId: "old" });
    assert.equal(r.output[0].text, "abcde");
    assert.equal(r.output[0].truncated, true);
    await exec('output.text("new")');
    await assert.rejects(
      exec('output.text("abcdefghij")', { requestId: "old" }),
      { code: "RESULT_EXPIRED" },
    );
  } finally {
    await service.close();
  }
});

test("native timer uncaught exception rebuilds worker and preserves browser", async () => {
  const { service, sessionId, provider, exec } = await setup();
  try {
    await exec("var b=await cua.connect();var t=await b.tabs.create();");
    const r = await exec(
      'var timers=await import("node:timers");timers.setTimeout(()=>{throw Error("native fault")},5);await new Promise(r=>setTimeout(r,30));',
    );
    assert.equal(r.error?.code, "WORKER_FAULT", JSON.stringify(r));
    assert.equal(r.stateImpact, "repl_restarted");
    assert.equal(provider.connection.connected, true);
    assert.equal(
      (
        await exec(
          "var b=await cua.connect();output.text((await b.tabs.list()).length)",
        )
      ).output[0].text,
      "1",
    );
  } finally {
    await service.close();
  }
});
test("unawaited failing SDK operation becomes USER_CODE_ERROR and retains all operations", async () => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities({ fail: true }),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  const { sessionId } = await service.createSession();
  try {
    const r = await service.execute({
      sessionId,
      code: 'var b=await cua.connect();var t=await b.tabs.create();t.getByRole("button").click();',
    });
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "USER_CODE_ERROR");
    assert.equal(r.error?.nextAction, "observe");
    assert.equal(r.aggregateOutcome, "some_unknown");
    assert.equal(r.operations.length, 3);
  } finally {
    await service.close();
  }
});
test("long poll wakes for new output and cursor avoids duplicate text", async () => {
  const { service, sessionId, exec } = await setup({ executeWaitMs: 1 });
  try {
    const r = await exec(
      'await new Promise(r=>setTimeout(r,30));output.text("first");await new Promise(r=>setTimeout(r,100));output.text("last")',
    );
    const first = await service.getExecution({
      sessionId,
      executionId: r.executionId,
      cursor: r.cursor,
    });
    assert.equal(first.status, "running");
    assert.equal(first.output[0].text, "first");
    const last = await service.getExecution({
      sessionId,
      executionId: r.executionId,
      cursor: first.cursor,
    });
    assert.equal(last.output[0].text, "last");
  } finally {
    await service.close();
  }
});

test("explicit close can reconnect in the same cell and old browser handles are stale", async () => {
  const { service, exec } = await setup();
  try {
    const result = await exec(
      "var old=await cua.connect();await old.close();var fresh=await cua.connect();var tab=await fresh.tabs.create();try{await old.tabs.list()}catch(error){output.text(error.code)}",
    );
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.output[0].text, "HANDLE_STALE");
  } finally {
    await service.close();
  }
});
