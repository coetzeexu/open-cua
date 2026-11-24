import { test } from "node:test";
import assert from "node:assert/strict";
import { createCUA, PendingUserChannel } from "@cua/core";
import { CUAService } from "@cua/service";
import {
  FakeBrowserProvider,
  FakeTab,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
const SECRET = "hunter2-very-secret";
const setup = (
  options: { channel?: PendingUserChannel; mode?: "require" | "allow" } = {},
) => {
  const provider = new FakeBrowserProvider();
  const notices: string[] = [];
  const waits: boolean[] = [];
  const cua = createCUA({
    browser: provider,
    capabilities: fakeCapabilities(),
    targetResolvers: [fakeResolver],
    userChannel: options.channel,
    credentials: { mode: options.mode },
    onUserNotice: (_s, w) => notices.push(w.message),
    onUserWait: (_s, waiting) => waits.push(waiting),
  });
  return { cua, provider, notices, waits };
};
const page = async (cua: ReturnType<typeof setup>["cua"]) => {
  const browser = await cua.connect();
  const tab = await browser.tabs.create({ url: "https://login.test/form" });
  return tab;
};
const lastRequestId = (notices: string[]) =>
  /cua (?:auth|resume) ([\w-]+)/.exec(notices.at(-1) ?? "")![1];
test("model fill into a password field is refused before dispatch; allow mode permits it", async () => {
  const { cua, provider } = setup();
  const tab = await page(cua);
  const fake = provider.connection.pages[0] as FakeTab;
  fake.sensitive.add("#pass");
  await assert.rejects(tab.locator("#pass").fill(SECRET), {
    code: "SECURE_INPUT_REQUIRED",
    nextAction: "use_secure_input",
  });
  assert.equal(fake.inputEvents.length, 0);
  await tab.locator("#user").fill("alice");
  assert.equal(fake.filled.get("#user"), "alice");
  fake.focused = "#pass";
  await assert.rejects(tab.actions.press(undefined, "a"), {
    code: "SECURE_INPUT_REQUIRED",
  });
  const open = setup({ mode: "allow" });
  const openTab = await page(open.cua);
  (open.provider.connection.pages[0] as FakeTab).sensitive.add("#pass");
  await openTab.locator("#pass").fill("typed");
  assert.equal(
    (open.provider.connection.pages[0] as FakeTab).filled.get("#pass"),
    "typed",
  );
});
test("secure input fills from the user channel, never returns values, then protects observation", async () => {
  const channel = new PendingUserChannel();
  const { cua, provider, notices, waits } = setup({ channel });
  const tab = await page(cua);
  const fake = provider.connection.pages[0] as FakeTab;
  fake.sensitive.add("#pass");
  const pending = tab.auth.request({
    fields: [
      {
        id: "user",
        label: "Email",
        type: "email",
        target: tab.locator("#user"),
      },
      {
        id: "pass",
        label: "Password",
        type: "password",
        target: tab.locator("#pass"),
      },
    ],
    submit: { target: tab.getByRole("button", { name: "Sign in" }) },
  });
  while (!notices.length) await new Promise((r) => setTimeout(r, 5));
  const id = lastRequestId(notices);
  assert.equal(fake.filled.size, 0, "nothing is typed before the user answers");
  const view = channel.inspect(id);
  assert.equal(view?.type, "credentials");
  assert.equal(view?.origin, "https://login.test");
  assert.equal(channel.submitCredentials(id, { user: "alice" }), false);
  assert.equal(
    channel.submitCredentials(id, { user: "alice", pass: SECRET }),
    true,
  );
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), [
    "nextAction",
    "requestId",
    "status",
  ]);
  assert.equal(result.status, "submitted");
  assert.doesNotMatch(
    JSON.stringify(result) + notices.join(),
    new RegExp(SECRET),
  );
  assert.equal(fake.filled.get("#pass"), SECRET);
  assert.deepEqual(waits, [true, false]);
  await assert.rejects(tab.dom.snapshot(), { code: "CREDENTIAL_PROTECTED" });
  await assert.rejects(
    tab.evaluate(() => 1),
    { code: "CREDENTIAL_PROTECTED" },
  );
  await assert.rejects(tab.devLogs(), { code: "CREDENTIAL_PROTECTED" });
  await tab.ax.snapshot();
  await tab.goto("https://login.test/home");
  await tab.dom.snapshot();
});
test("secure input rejects values, coordinates, invalid targets and missing channels without typing", async () => {
  const { cua, provider } = setup();
  const tab = await page(cua);
  await assert.rejects(
    tab.auth.request({
      fields: [{ id: "p", label: "P", target: tab.locator("#p") }],
    }),
    { code: "AUTH_UNAVAILABLE" },
  );
  const channel = new PendingUserChannel();
  const s = setup({ channel });
  const t = await page(s.cua);
  await assert.rejects(
    t.auth.request({
      fields: [
        { id: "p", label: "P", target: t.locator("#p"), value: "x" } as any,
      ],
    }),
    { code: "INVALID_ARGUMENT" },
  );
  const shot = {
    imageId: "i",
    sessionId: "s",
    generation: 0,
    tabId: t.id,
    epoch: 0,
    viewportRevision: 0,
  } as any;
  await assert.rejects(
    t.auth.request({
      fields: [{ id: "p", label: "P", target: t.point(shot, 1, 1) }],
    }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    t.auth.request({
      fields: [{ id: "p", label: "P", target: t.locator("#missing") }],
    }),
    { code: "AUTH_LOCATOR_INVALID" },
  );
  assert.equal(
    (s.provider.connection.pages[0] as FakeTab).inputEvents.length,
    0,
  );
  assert.equal(provider.connection.pages[0].inputEvents.length, 0);
});
test("page change while waiting, decline and expiry never type the credentials", async () => {
  const channel = new PendingUserChannel();
  const { cua, provider, notices } = setup({ channel });
  const tab = await page(cua);
  const fake = provider.connection.pages[0] as FakeTab;
  const request = () =>
    tab.auth.request({
      fields: [{ id: "pass", label: "Password", target: tab.locator("#pass") }],
    });
  let pending = request();
  while (!notices.length) await new Promise((r) => setTimeout(r, 5));
  fake.epoch++;
  channel.submitCredentials(lastRequestId(notices), { pass: SECRET });
  await assert.rejects(pending, { code: "AUTH_PAGE_CHANGED" });
  assert.equal(fake.filled.size, 0);
  pending = request();
  while (notices.length < 2) await new Promise((r) => setTimeout(r, 5));
  channel.decline(lastRequestId(notices));
  await assert.rejects(pending, { code: "AUTH_DECLINED", nextAction: "stop" });
  await assert.rejects(
    tab.auth.request({
      fields: [{ id: "pass", label: "Password", target: tab.locator("#pass") }],
      timeoutMs: 20,
    }),
    { code: "AUTH_EXPIRED" },
  );
  assert.equal(fake.filled.size, 0);
});
test("handoff blocks other operations, invalidates refs after resume and is unavailable without a channel", async () => {
  const channel = new PendingUserChannel();
  const { cua, provider, notices } = setup({ channel });
  const tab = await page(cua);
  const fake = provider.connection.pages[0] as FakeTab;
  const h = await tab.handoff.request({ reason: "captcha" });
  assert.equal(h.kind, "url");
  assert.doesNotMatch(JSON.stringify(h), /live\.test/);
  assert.equal(channel.inspect(h.handoffId)?.type, "handoff");
  assert.equal((await tab.info()).state, "handed_off");
  await assert.rejects(tab.locator("#x").click(), { code: "TAB_HANDED_OFF" });
  await assert.rejects(tab.ax.snapshot(), { code: "TAB_HANDED_OFF" });
  const epoch = fake.epoch;
  const waiting = tab.handoff.wait();
  assert.match(notices.at(-1)!, /cua resume/);
  channel.resume(h.handoffId);
  assert.equal((await waiting).status, "resumed");
  assert.ok(fake.epoch > epoch, "references are invalidated");
  await tab.ax.snapshot();
  const none = setup();
  const t = await page(none.cua);
  await assert.rejects(t.handoff.request(), { code: "CAPABILITY_UNAVAILABLE" });
  const headless = setup({ channel: new PendingUserChannel() });
  headless.provider.connection.handoffSupported = false;
  const h2 = await page(headless.cua);
  await assert.rejects(h2.handoff.request(), {
    code: "CAPABILITY_UNAVAILABLE",
  });
});
test("blocked reports accept only fixed reasons and record the hostname only", async () => {
  const reports: unknown[] = [];
  const provider = new FakeBrowserProvider();
  const cua = createCUA({
    browser: provider,
    capabilities: fakeCapabilities(),
    targetResolvers: [fakeResolver],
    onBlocked: (r) => reports.push(r),
  });
  const browser = await cua.connect();
  const tab = await browser.tabs.create({
    url: "https://shop.test/a?token=abc",
  });
  await assert.rejects(tab.reportBlocked({ reason: "403" as any }), {
    code: "INVALID_ARGUMENT",
  });
  const r = await tab.reportBlocked({ reason: "challenge_loop" });
  assert.deepEqual(r, { status: "reported", hostname: "shop.test" });
  assert.doesNotMatch(JSON.stringify(reports), /token/);
  assert.equal(cua.engine.describe().blocked.length, 1);
});
test("Service pauses the cell deadline and idle reaping while the user enters credentials", async () => {
  const channel = new PendingUserChannel();
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    userChannel: channel,
    cellTimeoutMs: 80,
    executeWaitMs: 20,
  });
  const { sessionId } = await service.createSession();
  try {
    const first = await service.execute({
      sessionId,
      code: 'var b=await cua.connect();var t=await b.tabs.create({url:"https://login.test"});var r=await t.auth.request({fields:[{id:"pass",label:"Password",target:t.locator("#pass")}]});output.json(r);',
    });
    assert.equal(first.status, "running");
    let id = "";
    for (let i = 0; i < 100 && !id; i++) {
      const r = await service.getExecution({
        sessionId,
        executionId: first.executionId,
        waitMs: 20,
      });
      const w = r.warnings.find((x) => x.code === "USER_ACTION_REQUIRED");
      if (w) id = /cua auth ([\w-]+)/.exec(w.message)![1];
    }
    assert.ok(id);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(service.status()[0].waitingForUser, true);
    assert.equal(channel.submitCredentials(id, { pass: SECRET }), true);
    let done = await service.getExecution({
      sessionId,
      executionId: first.executionId,
      waitMs: 50,
    });
    for (let i = 0; i < 40 && done.status === "running"; i++)
      done = await service.getExecution({
        sessionId,
        executionId: first.executionId,
        cursor: done.cursor,
        waitMs: 50,
      });
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.doesNotMatch(JSON.stringify(done), new RegExp(SECRET));
    assert.equal(provider.connection.pages[0].filled.get("#pass"), SECRET);
  } finally {
    await service.close();
  }
});
test("cancelling the cell abandons a pending credential request; a late answer is refused", async () => {
  const channel = new PendingUserChannel();
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    userChannel: channel,
    executeWaitMs: 20,
    terminationGraceMs: 100,
  });
  const { sessionId } = await service.createSession();
  try {
    const r = await service.execute({
      sessionId,
      code: 'var b=await cua.connect();var t=await b.tabs.create({url:"https://login.test"});await t.auth.request({fields:[{id:"pass",label:"Password",target:t.locator("#pass")}]});',
    });
    let id = "";
    for (let i = 0; i < 100 && !id; i++) {
      const p = await service.getExecution({
        sessionId,
        executionId: r.executionId,
        waitMs: 20,
      });
      const w = p.warnings.find((x) => x.code === "USER_ACTION_REQUIRED");
      if (w) id = /cua auth ([\w-]+)/.exec(w.message)![1];
    }
    const cancelled = await service.cancelExecution({
      sessionId,
      executionId: r.executionId,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(channel.submitCredentials(id, { pass: SECRET }), false);
    assert.equal(provider.connection.pages[0].filled.size, 0);
  } finally {
    await service.close();
  }
});

test("an active handoff keeps the session from idle reaping between cells", async () => {
  const channel = new PendingUserChannel();
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    userChannel: channel,
    idleMs: 300,
  });
  const { sessionId } = await service.createSession();
  try {
    const r = await service.execute({
      sessionId,
      code: 'var b=await cua.connect();var t=await b.tabs.create({url:"https://shop.test"});var h=await t.handoff.request({reason:"captcha"});output.json(h);',
    });
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    const id = JSON.parse(r.output[0].text!).handoffId;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      service.status().length,
      1,
      "session survives while a person works",
    );
    assert.equal(service.status()[0].waitingForUser, true);
    channel.resume(id);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      service.status().length,
      0,
      "idle reaping resumes after handoff",
    );
  } finally {
    await service.close();
  }
});
