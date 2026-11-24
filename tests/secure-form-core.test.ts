import { test } from "node:test";
import assert from "node:assert/strict";
import { createCUA, PendingUserChannel } from "@cua/core";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
  type FakeTab,
} from "@cua/testing";
import type { SecureFormDescriptor } from "@cua/contracts";

async function setup(
  options: {
    failAt?: number;
    onPerform?: () => void;
    onAccepted?: () => void;
  } = {},
) {
  const provider = new FakeBrowserProvider(),
    channel = new PendingUserChannel();
  const descriptors = new Map<string, SecureFormDescriptor>([
    [
      "#name",
      { nodeId: "name-node", control: "text", required: true, nonEmpty: false },
    ],
    [
      "#date",
      {
        nodeId: "date-node",
        control: "date",
        required: true,
        nonEmpty: false,
        min: "1900-01-01",
      },
    ],
    [
      "#country",
      {
        nodeId: "country-node",
        control: "select",
        required: true,
        nonEmpty: false,
        options: [
          { value: "PRIVATE_NATIVE_OPTION", label: "Private country option" },
        ],
      },
    ],
  ]);
  const capabilities = fakeCapabilities();
  const base = capabilities.action!.bind.bind(capabilities.action);
  let writes = 0;
  capabilities.action!.bind = async (context) => {
    const action = await base(context);
    return {
      ...action,
      describe: async (target, ctx) => ({
        ...(await action.describe!(target, ctx)),
        secureForm: structuredClone(
          descriptors.get((target.value as any).selector),
        ),
      }),
      deliverSecureForm: async (kind, target, value, ctx) => {
        writes++;
        options.onPerform?.();
        if (writes === options.failAt)
          throw Error("PRIVATE_PROVIDER_DIAGNOSTIC");
        return action.deliverSecureForm!(kind, target, value, ctx);
      },
    };
  };
  const cua = createCUA({
    browser: provider,
    capabilities,
    targetResolvers: [fakeResolver],
    userChannel: channel,
    onSecureFormAccepted: options.onAccepted,
  });
  const browser = await cua.connect(),
    tab = await browser.tabs.create({ url: "https://private.test/form" });
  const fake = provider.connection.pages[0] as FakeTab;
  const request = () =>
    tab.secureForm.request({
      title: "Passenger 1",
      timeoutMs: 1000,
      groups: [{ id: "p1", label: "Passenger 1" }],
      fields: [
        {
          id: "name",
          label: "Name",
          groupId: "p1",
          control: "text",
          target: tab.locator("#name"),
        },
        {
          id: "date",
          label: "Birth date",
          control: "date",
          target: tab.locator("#date"),
        },
        {
          id: "country",
          label: "Country",
          control: "select",
          target: tab.locator("#country"),
        },
      ],
    });
  const pending = async () => {
    for (let i = 0; i < 100; i++) {
      const r = channel
        .listForSession(cua.engine.sessionId)
        .find((r) => r.type === "secure_form");
      if (r?.type === "secure_form") return r;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw Error("request not pending");
  };
  const submit = async () => {
    const r = await pending();
    return channel.answerSecureForm(r.id, {
      action: "submit",
      schemaRevision: r.schemaRevision,
      submissionId: "submission-1",
      values: {
        name: "PRIVATE_NAME",
        date: "2000-01-02",
        country: r.fields[2].options![0].id,
      },
    });
  };
  return {
    cua,
    browser,
    tab,
    fake,
    channel,
    descriptors,
    request,
    pending,
    submit,
    writes: () => writes,
  };
}

test("generic form delivers text/date/select privately once and survives model reset", async () => {
  const s = await setup();
  const running = s.request();
  const pending = await s.pending();
  await assert.rejects(s.tab.info(), { code: "SECURE_FORM_PROTECTED" });
  const accepted = await s.submit();
  assert.equal(accepted.status, "accepted");
  const result = await running;
  assert.equal(result.status, "filled");
  assert.equal(result.nextAction, "human_review");
  assert.deepEqual(result.confirmedFieldIds, ["name", "date", "country"]);
  assert.equal(s.writes(), 3);
  assert.equal(s.fake.filled.get("#name"), "PRIVATE_NAME");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.ok(!("request" in result));
  const replay = s.channel.answerSecureForm(pending.id, {
    action: "submit",
    schemaRevision: pending.schemaRevision,
    submissionId: "different-id",
    values: { name: "REPLAY" },
  });
  assert.equal(replay.status, "filled");
  assert.equal(s.writes(), 3);
  for (const operation of [
    () => s.tab.ax.snapshot(),
    () => s.tab.info(),
    () => s.tab.dialogs.pending(),
    () => s.tab.goto("https://private.test/next"),
    () => s.browser.userTabs.list(),
    () => s.tab.evaluate("document.body.innerText"),
  ])
    await assert.rejects(operation(), { code: "SECURE_FORM_PROTECTED" });
  s.fake.epoch++;
  s.fake.documentEpoch++;
  s.cua.engine.reset();
  assert.equal(s.cua.engine.isSecureFormProtected(), true);
  const fresh = await s.cua.connect(),
    tabs = await fresh.tabs.list(),
    tab = await fresh.tabs.get(tabs[0].id);
  assert.equal((await tab.secureForm.status(pending.id))?.status, "filled");
  await assert.rejects(tab.ax.snapshot(), { code: "SECURE_FORM_PROTECTED" });
  await s.cua.engine.close();
});

test("invalid private values remain pending; changed node is stale with zero writes", async () => {
  const s = await setup();
  const running = s.request(),
    r = await s.pending();
  assert.throws(
    () =>
      s.channel.answerSecureForm(r.id, {
        action: "submit",
        schemaRevision: r.schemaRevision,
        submissionId: "bad",
        values: {
          name: "PRIVATE_NAME",
          date: "2023-02-30",
          country: r.fields[2].options![0].id,
        },
      }),
    /Invalid secure form/,
  );
  assert.equal(s.channel.secureFormState(r.id)?.status, "pending");
  assert.equal(s.writes(), 0);
  s.descriptors.get("#name")!.nodeId = "replacement-node";
  await s.submit();
  const result = await running;
  assert.equal(result.status, "stale");
  assert.equal(s.writes(), 0);
  await s.cua.engine.close();
});

test("partial delivery never replays and provider diagnostics do not reach operations", async () => {
  const s = await setup({ failAt: 2 });
  const running = s.request(),
    r = await s.pending();
  await s.submit();
  const result = await running;
  assert.equal(result.status, "partial_or_unknown");
  assert.deepEqual(result.confirmedFieldIds, ["name"]);
  assert.deepEqual(result.uncertainFieldIds, ["date"]);
  assert.equal(result.nextAction, "human_review");
  assert.ok(
    !JSON.stringify(
      s.cua.engine.coordinator.operations(result.scopeId),
    ).includes("PRIVATE_PROVIDER_DIAGNOSTIC"),
  );
  s.channel.answerSecureForm(r.id, {
    action: "submit",
    schemaRevision: r.schemaRevision,
    submissionId: "retry",
    values: {},
  });
  assert.equal(s.writes(), 2);
  await s.cua.engine.close();
});

test("decline and expiry never write; schema rejects values and unsupported actions", async () => {
  const s = await setup();
  const running = s.request(),
    r = await s.pending();
  s.channel.answerSecureForm(r.id, {
    action: "decline",
  });
  assert.equal((await running).status, "cancelled");
  assert.equal(s.writes(), 0);
  await assert.rejects(
    s.tab.secureForm.request({
      title: "Invalid",
      fields: [
        {
          id: "name",
          label: "Name",
          control: "text",
          target: s.tab.locator("#name"),
          value: "bad",
        },
      ],
    } as any),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    s.tab.secureForm.request({
      title: "Invalid",
      fields: [
        {
          id: "name",
          label: "Name",
          control: "text",
          target: s.tab.locator("#name"),
        },
      ],
      delivery: { mode: "fill_and_act" },
    } as any),
    { code: "INVALID_ARGUMENT" },
  );
  const expiry = s.tab.secureForm.request({
    title: "Expire",
    fields: [
      {
        id: "name",
        label: "Name",
        control: "text",
        target: s.tab.locator("#name"),
      },
    ],
    timeoutMs: 10,
  });
  assert.equal((await expiry).status, "expired");
  assert.equal(s.writes(), 0);
  await s.cua.engine.close();
});

test("cancellation during dispatch conservatively preserves unknown and stops remaining fields", async () => {
  let cancel = () => {};
  const s = await setup({ onPerform: () => cancel() });
  const running = s.request(),
    r = await s.pending();
  cancel = () => s.cua.engine.coordinator.closeScope(r.scopeId);
  await s.submit();
  const result = await running;
  assert.equal(result.status, "partial_or_unknown");
  assert.equal(s.writes(), 1);
  assert.deepEqual(result.confirmedFieldIds, []);
  assert.deepEqual(result.uncertainFieldIds, ["name"]);
  assert.equal(s.channel.secureFormState(r.id)?.status, "partial_or_unknown");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(s.writes(), 1);
  await s.cua.engine.close();
});

test("protection marker failure rejects before browser writes and remains protected", async () => {
  const s = await setup({
    onAccepted: () => {
      throw Error("PRIVATE_STORAGE_PATH");
    },
  });
  const running = s.request(),
    r = await s.pending();
  s.cua.engine.images.set("old-image", {
    metadata: {} as any,
    bytes: new Uint8Array([1]),
  });
  const state = s.channel.answerSecureForm(r.id, {
    action: "submit",
    schemaRevision: r.schemaRevision,
    submissionId: "once",
    values: {
      name: "PRIVATE_NAME",
      date: "2000-01-02",
      country: r.fields[2].options![0].id,
    },
  });
  assert.equal(s.cua.engine.isSecureFormProtected(), true);
  assert.equal(s.cua.engine.images.size, 0);
  assert.equal(state.status, "failed_before_write");
  assert.equal((await running).status, "failed_before_write");
  assert.equal(s.writes(), 0);
  assert.ok(!JSON.stringify(state).includes("PRIVATE_STORAGE_PATH"));
  await s.cua.engine.close();
});

test("only one private request may validate and collect within the session", async () => {
  const s = await setup();
  const first = s.request();
  await assert.rejects(s.request(), { code: "SECURE_FORM_PROTECTED" });
  const r = await s.pending();
  assert.equal(s.channel.listForSession(s.cua.engine.sessionId).length, 1);
  s.channel.answerSecureForm(r.id, { action: "decline" });
  assert.equal((await first).status, "cancelled");
  assert.equal(s.writes(), 0);
  await s.cua.engine.close();
});

test("page autofill after card creation cannot silently overwrite a previously empty field", async () => {
  const s = await setup();
  const running = s.request();
  await s.pending();
  s.descriptors.get("#name")!.nonEmpty = true;
  await s.submit();
  assert.equal((await running).status, "stale");
  assert.equal(s.writes(), 0);
  await s.cua.engine.close();
});
