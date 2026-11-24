import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationCoordinator } from "@cua/core";
import { FakeTab } from "@cua/testing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setup = () => {
  const c = new OperationCoordinator({ hardExtraMs: 20 });
  const scopeId = c.openScope();
  return {
    c,
    scopeId,
    opts: {
      scopeId,
      sessionId: "s",
      generation: 1,
      kind: "click",
      timeoutMs: 500,
      policy: async () => {},
    },
  };
};
test("closing scope prevents queued operations and catch/finally work on another tab", async () => {
  const { c, scopeId, opts } = setup();
  const a = new FakeTab(),
    b = new FakeTab();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let dispatched = 0;
  const first = c.run({ ...opts, tab: a }, async (ctx) => {
    ctx.dispatch();
    dispatched++;
    await gate;
  });
  const second = c.run({ ...opts, tab: a }, async (ctx) => {
    ctx.dispatch();
    dispatched++;
  });
  const check = async () =>
    assert.rejects(
      c.run({ ...opts, tab: b }, async (ctx) => {
        ctx.dispatch();
        dispatched++;
      }),
      { code: "SCOPE_CLOSED" },
    );
  const captured = first.catch(check).finally(check);
  const queued = assert.rejects(second, { code: "OPERATION_CANCELLED" });
  await sleep(10);
  c.closeScope(scopeId);
  await Promise.all([captured, queued]);
  assert.equal(dispatched, 1);
  release();
});
test("SDK controlled steps stop after scope closure", async () => {
  const { c, scopeId, opts } = setup();
  let steps = 0;
  const p = c.run({ ...opts, tab: new FakeTab() }, async (ctx) => {
    for (let i = 0; i < 3; i++) {
      ctx.dispatch();
      steps++;
      await sleep(15);
    }
  });
  const rejected = assert.rejects(p);
  await sleep(5);
  c.closeScope(scopeId);
  await rejected;
  await sleep(30);
  assert.equal(steps, 1);
});
test("a running tail holds its tab lock for the following cell", async () => {
  const { c, scopeId, opts } = setup();
  const tab = new FakeTab();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let next = false;
  const p = c.run({ ...opts, tab }, async (ctx) => {
    ctx.dispatch();
    await gate;
  });
  const rejected = assert.rejects(p);
  await sleep(5);
  c.closeScope(scopeId);
  await rejected;
  const p2 = c.run({ ...opts, scopeId: c.openScope(), tab }, async () => {
    next = true;
  });
  await sleep(10);
  assert.equal(next, false);
  release();
  await p2;
  assert.equal(next, true);
});
test("dialog channel interrupts operation without releasing its tail", async () => {
  const { c, opts } = setup();
  const tab = new FakeTab();
  let release!: () => void;
  const p = c.run({ ...opts, tab }, async (ctx) => {
    ctx.dispatch();
    await new Promise<void>((r) => (release = r));
  });
  const rejected = assert.rejects(p, { code: "INTERRUPTED_BY_DIALOG" });
  await sleep(5);
  tab.openDialog();
  await rejected;
  await assert.rejects(
    c.run({ ...opts, tab }, async () => {}),
    { code: "DIALOG_PENDING" },
  );
  await tab.respondDialog(tab.dialog()!.id);
  release();
});

test("hard-deadline quarantine releases waiting callers without dispatching their input", async () => {
  const c = new OperationCoordinator({ hardExtraMs: 5 });
  const tab = new FakeTab();
  const scopeId = c.openScope();
  const opts = {
    scopeId,
    sessionId: "s",
    generation: 0,
    kind: "click",
    tab,
    timeoutMs: 5,
    policy: async () => {},
  };
  const first = c.run(opts, async (ctx) => {
    ctx.dispatch();
    await new Promise(() => {});
  });
  const firstRejected = assert.rejects(first, { code: "OPERATION_TIMEOUT" });
  let dispatches = 0;
  const queued = c.run(opts, async (ctx) => {
    ctx.dispatch();
    dispatches++;
  });
  const secondRejected = assert.rejects(queued, { code: "TAB_QUARANTINED" });
  await new Promise((r) => setTimeout(r, 30));
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(dispatches, 0);
  c.closeScope(scopeId);
});
