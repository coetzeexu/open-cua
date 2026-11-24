import { test } from "node:test";
import assert from "node:assert/strict";
import { CUAService } from "@cua/service";
import { OperationCoordinator } from "@cua/core";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
async function setup() {
  const provider = new FakeBrowserProvider();
  const coordinator = new OperationCoordinator();
  const service = new CUAService({
    profiles: {
      test: () => ({
        browser: provider,
        capabilities: fakeCapabilities({ stepDelayMs: 25, steps: 3 }),
        targetResolvers: [fakeResolver],
        coordinator,
      }),
    },
    executeWaitMs: 5,
    terminationGraceMs: 30,
  });
  const { sessionId } = await service.createSession();
  const exec = async (code: string) => {
    let r = await service.execute({ sessionId, code });
    const output = [...r.output];
    while (r.status === "running") {
      r = await service.getExecution({
        sessionId,
        executionId: r.executionId,
        waitMs: 100,
        cursor: r.cursor,
      });
      output.push(...r.output);
    }
    return { ...r, output };
  };
  await exec(
    "var browser=await cua.connect();var tab=await browser.tabs.create();",
  );
  return { service, sessionId, provider, coordinator, exec };
}
test("human takeover gates model work immediately, interrupts execution and permits only human actions", async () => {
  const { service, sessionId, provider, exec } = await setup();
  try {
    const running = await service.execute({
      sessionId,
      code: 'for(var i=0;i<100;i++){await tab.getByRole("button").click();await new Promise(r=>setTimeout(r,20));}',
    });
    const take = service.interruptSession({ sessionId, takeControl: true });
    await assert.rejects(
      service.execute({
        sessionId,
        code: 'await tab.getByRole("button").click()',
      }),
      { code: "SESSION_BUSY" },
    );
    await take;
    assert.equal(service.status()[0].control, "human");
    const count = provider.connection.pages[0].inputEvents.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(provider.connection.pages[0].inputEvents.length, count);
    const ended = await service.getExecution({
      sessionId,
      executionId: running.executionId,
      waitMs: 0,
    });
    assert.equal(ended.status, "cancelled");
    let resolve!: () => void;
    const action = service.runHumanAction(
      sessionId,
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    await assert.rejects(service.resumeSession({ sessionId }), {
      code: "SESSION_BUSY",
    });
    resolve();
    await action;
    await service.resumeSession({ sessionId });
    assert.equal(service.status()[0].control, "agent");
    await assert.rejects(
      service.runHumanAction(sessionId, async () => {}),
      { code: "SESSION_BUSY" },
    );
    const fresh = await exec("output.text(typeof browser);");
    assert.equal(fresh.output[0].text, "undefined");
  } finally {
    await service.close();
  }
});
test("interruption stays paused, and human page protection survives return to model", async () => {
  const { service, sessionId, exec } = await setup();
  try {
    await service.interruptSession({ sessionId });
    assert.equal(service.status()[0].control, "paused");
    await assert.rejects(
      service.runHumanAction(sessionId, async () => {}),
      { code: "SESSION_BUSY" },
    );
    await service.interruptSession({ sessionId, takeControl: true });
    await service.resumeSession({ sessionId });
    const blocked = await exec(
      "var browser=await cua.connect();var tab=(await browser.tabs.list())[0];await tab.evaluate(()=>document.body.innerText);",
    );
    assert.ok(
      blocked.operations.some((o) => o.error?.code === "CREDENTIAL_PROTECTED"),
    );
    const afterNavigation = await exec(
      'await tab.goto("https://fresh.test");output.json(await tab.evaluate(()=>1));',
    );
    assert.equal(afterNavigation.status, "succeeded");
  } finally {
    await service.close();
  }
});
test("takeover cannot claim success while a browser operation is still in flight", async () => {
  const { service, sessionId, provider, coordinator } = await setup();
  let finish!: () => void;
  const scopeId = coordinator.openScope();
  const pending = coordinator.run(
    {
      scopeId,
      sessionId,
      generation: 0,
      kind: "test",
      tab: provider.connection.pages[0],
      timeoutMs: 2000,
      policy: async () => {},
    },
    async (ctx) => {
      ctx.dispatch();
      await new Promise<void>((r) => {
        finish = r;
      });
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      service.interruptSession({ sessionId, takeControl: true, settleMs: 10 }),
      { code: "SESSION_BUSY" },
    );
    assert.equal(service.status()[0].control, "paused");
    await assert.rejects(service.resumeSession({ sessionId }), {
      code: "SESSION_BUSY",
    });
    finish();
    await pending;
    await service.interruptSession({ sessionId, takeControl: true });
    assert.equal(service.status()[0].control, "human");
  } finally {
    finish?.();
    await pending;
    coordinator.closeScope(scopeId);
    await service.close();
  }
});
