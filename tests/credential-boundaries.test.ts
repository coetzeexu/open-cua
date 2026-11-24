import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCUA, PendingUserChannel } from "@cua/core";
import { ChromiumTab } from "@cua/browser-chromium";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import type { Capabilities, TargetResolver, FrameInfo } from "@cua/contracts";

const SECRET = "boundary-test-secret";
async function setup(
  capabilities: Capabilities = fakeCapabilities(),
  resolver: TargetResolver = fakeResolver,
) {
  const provider = new FakeBrowserProvider();
  const channel = new PendingUserChannel();
  const notices: string[] = [];
  const cua = createCUA({
    browser: provider,
    capabilities,
    targetResolvers: [resolver],
    userChannel: channel,
    onUserNotice: (_scope, warning) => notices.push(warning.message),
  });
  const browser = await cua.connect();
  const tab = await browser.tabs.create({ url: "https://login.test/form" });
  provider.connection.pages[0].sensitive.add("#pass");
  return { cua, tab, channel, notices, fake: provider.connection.pages[0] };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function pendingId(s: Fixture) {
  for (let n = 0; n < 100; n++) {
    const match = /cua auth ([\w-]+)/.exec(
      s.notices.find((x) => x.includes("cua auth")) ?? "",
    );
    if (match) return match[1];
    await new Promise((r) => setTimeout(r, 1));
  }
  throw Error("Credential prompt did not appear");
}
async function authenticate(s: Fixture, frameId?: string) {
  const pending = s.tab.auth.request({
    fields: [
      {
        id: "p",
        label: "Password",
        type: "password",
        target: s.tab.locator("#pass", { frameId }),
      },
    ],
  });
  assert.equal(
    s.channel.submitCredentials(await pendingId(s), { p: SECRET }),
    true,
  );
  await pending;
}

test("auth stops later fields and submit after a navigation between steps", async (t) => {
  for (const mode of [
    "top-cross-origin",
    "top-same-origin",
    "child",
    "before-submit",
  ]) {
    await t.test(mode, async () => {
      const capabilities = fakeCapabilities();
      const bind = capabilities.action!.bind.bind(capabilities.action);
      let s!: Fixture;
      let childEpoch = 0;
      let fills = 0;
      capabilities.action!.bind = async (binding) => {
        const action = await bind(binding),
          perform = action.perform.bind(action);
        return {
          ...action,
          perform: async (kind, target, args, ctx) => {
            await perform(kind, target, args, ctx);
            if (
              kind !== "fill" ||
              ++fills !== (mode === "before-submit" ? 2 : 1)
            )
              return;
            if (mode === "child") childEpoch++;
            else {
              s.fake.url =
                mode === "top-cross-origin"
                  ? "https://other.test/form"
                  : "https://login.test/new";
              s.fake.epoch++;
              s.fake.documentEpoch++;
            }
          },
        };
      };
      s = await setup(capabilities);
      if (mode === "child")
        s.fake.frames = async (): Promise<FrameInfo[]> => [
          { id: s.fake.id, url: s.fake.url, epoch: s.fake.documentEpoch },
          {
            id: "child",
            parentId: s.fake.id,
            url: "https://login.test/frame",
            epoch: childEpoch,
          },
        ];
      try {
        const target = (selector: string) =>
          s.tab.locator(selector, {
            frameId: mode === "child" ? "child" : undefined,
          });
        const pending = s.tab.auth.request({
          fields: [
            { id: "u", label: "User", target: target("#user") },
            { id: "p", label: "Password", target: target("#pass") },
          ],
          submit: { target: target("#submit") },
        });
        const rejection = assert.rejects(pending, (error: any) => {
          assert.equal(error.code, "AUTH_SUBMISSION_FAILED");
          assert.equal(error.outcome, "unknown");
          assert.doesNotMatch(JSON.stringify(error), /boundary-test-secret/);
          return true;
        });
        s.channel.submitCredentials(await pendingId(s), {
          u: "alice",
          p: SECRET,
        });
        await rejection;
        assert.deepEqual(
          s.fake.inputEvents,
          mode === "before-submit" ? ["fill", "fill"] : ["fill"],
        );
        if (mode !== "before-submit")
          assert.equal(s.fake.filled.has("#pass"), false);
      } finally {
        await s.cua.engine.close();
      }
    });
  }
});

test("auth rechecks after resolution and during provider actionability checks", async (t) => {
  for (const stage of ["resolve", "actionability"])
    await t.test(stage, async () => {
      let s!: Fixture,
        resolves = 0;
      const navigate = () => {
        s.fake.url = "https://other.test";
        s.fake.epoch++;
        s.fake.documentEpoch++;
      };
      const resolver: TargetResolver = {
        ...fakeResolver,
        resolve: async (...args) => {
          if (++resolves === 2 && stage === "resolve") navigate();
          return fakeResolver.resolve(...args);
        },
      };
      const capabilities = fakeCapabilities(),
        bind = capabilities.action!.bind.bind(capabilities.action);
      capabilities.action!.bind = async (binding) => {
        const action = await bind(binding),
          perform = action.perform.bind(action);
        return {
          ...action,
          perform: async (kind, target, args, ctx) => {
            if (stage === "actionability") {
              navigate();
              await ctx.policy(s.fake.url);
            }
            return perform(kind, target, args, ctx);
          },
        };
      };
      s = await setup(capabilities, resolver);
      try {
        await assert.rejects(authenticate(s), {
          code: "AUTH_SUBMISSION_FAILED",
        });
        assert.deepEqual(s.fake.inputEvents, []);
      } finally {
        await s.cua.engine.close();
      }
    });
});

test("protected iframe blocks scripts in parent and sibling frames until that document leaves", async () => {
  const s = await setup();
  let childEpoch = 0;
  s.fake.frames = async (): Promise<FrameInfo[]> => [
    { id: s.fake.id, url: s.fake.url, epoch: s.fake.documentEpoch },
    {
      id: "child",
      parentId: s.fake.id,
      url: "https://login.test/frame",
      epoch: childEpoch,
    },
    {
      id: "sibling",
      parentId: s.fake.id,
      url: "https://login.test/other",
      epoch: 0,
    },
  ];
  try {
    await authenticate(s, "child");
    for (const frameId of [undefined, "child", "sibling"]) {
      await assert.rejects(
        s.tab.evaluate(() => 1, undefined, { frameId }),
        { code: "CREDENTIAL_PROTECTED" },
      );
      await assert.rejects(
        s.tab.waitForFunction(() => true, { frameId }),
        { code: "CREDENTIAL_PROTECTED" },
      );
    }
    await s.tab.ax.snapshot();
    childEpoch++;
    await s.tab.evaluate(() => 1);
  } finally {
    await s.cua.engine.close();
  }
});

test("handoff resume, cancellation and expiry preserve credentials on the same document", async (t) => {
  for (const status of ["resumed", "cancelled", "expired"])
    await t.test(status, async () => {
      const s = await setup();
      try {
        await authenticate(s);
        const frameEpoch = (await s.fake.frames())[0].epoch;
        const tabEpoch = s.fake.epoch;
        const h = await s.tab.handoff.request({
          timeoutMs: status === "expired" ? 30 : 1000,
        });
        if (status === "resumed") s.channel.resume(h.handoffId);
        if (status === "cancelled") s.channel.decline(h.handoffId);
        if (status === "expired") await new Promise((r) => setTimeout(r, 45));
        assert.equal((await s.tab.handoff.wait()).status, status);
        assert.ok(s.fake.epoch > tabEpoch);
        assert.equal((await s.fake.frames())[0].epoch, frameEpoch);
        assert.equal(s.fake.filled.get("#pass"), SECRET);
        await assert.rejects(
          s.tab.evaluate(() => 1),
          { code: "CREDENTIAL_PROTECTED" },
        );
        await assert.rejects(s.tab.screenshot.capture(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await s.tab.goto("https://login.test/home");
        await s.tab.evaluate(() => 1);
      } finally {
        await s.cua.engine.close();
      }
    });
});

test("queued click and auth validation cannot run after handoff begins", async () => {
  const s = await setup();
  try {
    const [handoff, click, auth] = await Promise.allSettled([
      s.tab.handoff.request(),
      s.tab.locator("#x").click(),
      s.tab.auth.request({
        fields: [
          { id: "p", label: "Password", target: s.tab.locator("#pass") },
        ],
      }),
    ]);
    assert.equal(handoff.status, "fulfilled");
    for (const result of [click, auth]) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected")
        assert.equal(result.reason.code, "TAB_HANDED_OFF");
    }
    assert.deepEqual(s.fake.inputEvents, []);
    assert.equal(s.channel.pending().credentials, 0);
    if (handoff.status === "fulfilled")
      s.channel.resume(handoff.value.handoffId);
  } finally {
    await s.cua.engine.close();
  }
});

test("credentials answered during handoff cannot enter the submit lane", async () => {
  const s = await setup();
  try {
    const pending = s.tab.auth.request({
      fields: [{ id: "p", label: "Password", target: s.tab.locator("#pass") }],
    });
    const rejection = assert.rejects(pending, { code: "TAB_HANDED_OFF" });
    const id = await pendingId(s);
    const h = await s.tab.handoff.request();
    s.channel.submitCredentials(id, { p: SECRET });
    await rejection;
    assert.deepEqual(s.fake.inputEvents, []);
    s.channel.resume(h.handoffId);
  } finally {
    await s.cua.engine.close();
  }
});

test("Chromium reference invalidation preserves frame document epochs", async () => {
  const frame = {
    url: () => "https://login.test",
    parentFrame: () => null,
    evaluate: async () => undefined,
  };
  const page = Object.assign(new EventEmitter(), {
    frames: () => [frame],
    mainFrame: () => frame,
  });
  const tab = new ChromiumTab(page as any, {} as any, "created");
  let loaderId = "document-1";
  tab.frameCDP = async (record) => {
    record.protocolFrameId = "main";
    return {
      send: async () => ({ frameTree: { frame: { id: "main", loaderId } } }),
    } as any;
  };
  const before = (await tab.frames())[0];
  tab.invalidate();
  assert.ok(tab.epoch > 0);
  assert.equal((await tab.frames())[0].epoch, before.epoch);
  page.emit("framenavigated", frame);
  assert.equal((await tab.frames())[0].epoch, before.epoch);
  loaderId = "document-2";
  page.emit("framenavigated", frame);
  assert.ok((await tab.frames())[0].epoch > before.epoch);
  loaderId = "";
  await assert.rejects(tab.frames(), { code: "CAPABILITY_UNAVAILABLE" });
});

test("AX protection follows human documents through reset and child-frame navigation", async () => {
  const capabilities = fakeCapabilities();
  const requested: boolean[] = [];
  const bind = capabilities.ax!.bind.bind(capabilities.ax);
  capabilities.ax!.bind = async (context) => {
    const ax = await bind(context);
    return {
      snapshot: async (ctx, options) => {
        requested.push(options?.redactEditableValues ?? false);
        return ax.snapshot(ctx, options);
      },
    };
  };
  const s = await setup(capabilities);
  let parentEpoch = 0,
    childEpoch = 0;
  s.fake.frames = async () => [
    { id: s.fake.id, url: s.fake.url, epoch: parentEpoch },
    { id: "child", parentId: s.fake.id, url: s.fake.url, epoch: childEpoch },
  ];
  try {
    await s.tab.ax.snapshot();
    await s.cua.engine.protectHumanPages();
    let tab = await (await s.cua.connect()).tabs.get(s.tab.id);
    await tab.ax.snapshot();
    s.cua.engine.reset();
    tab = await (await s.cua.connect()).tabs.get(s.tab.id);
    await tab.ax.snapshot();
    childEpoch++;
    await tab.ax.snapshot();
    parentEpoch++;
    await tab.ax.snapshot();
    assert.deepEqual(requested, [false, true, true, true, false]);
  } finally {
    await s.cua.engine.close();
  }
});

test("handoff protects fresh human input on resume, cancellation and expiry without prior auth", async (t) => {
  for (const status of ["resumed", "cancelled", "expired"])
    await t.test(status, async () => {
      const s = await setup();
      try {
        const h = await s.tab.handoff.request({
          timeoutMs: status === "expired" ? 30 : 1000,
        });
        // The person navigates during handoff, then types in the new document.
        s.fake.documentEpoch++;
        s.fake.filled.set("#pass", SECRET);
        if (status === "resumed") s.channel.resume(h.handoffId);
        if (status === "cancelled") s.channel.decline(h.handoffId);
        assert.equal((await s.tab.handoff.wait()).status, status);
        await assert.rejects(
          s.tab.evaluate(() => 1),
          { code: "CREDENTIAL_PROTECTED" },
        );
        await assert.rejects(s.tab.dom.snapshot(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await assert.rejects(s.tab.screenshot.capture(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await s.tab.goto("https://login.test/home");
        await s.tab.evaluate(() => 1);
      } finally {
        await s.cua.engine.close();
      }
    });
});

test("secure input refuses unverified destinations before collecting secrets", async (t) => {
  for (const mode of [
    "password-textbox",
    "otp-textbox",
    "get-form",
    "foreign-action",
    "unknown-form",
    "submit-other-frame",
  ]) {
    await t.test(mode, async () => {
      const caps = fakeCapabilities();
      const bind = caps.action!.bind.bind(caps.action);
      caps.action!.bind = async (binding) => {
        const action = await bind(binding);
        return {
          ...action,
          describe: async (target, ctx) => {
            const d = await action.describe!(target, ctx);
            if (mode.endsWith("textbox")) d.sensitive = false;
            if (mode === "get-form")
              d.authForm = {
                method: "get",
                action: "https://login.test/search",
              };
            if (mode === "foreign-action")
              d.authForm = {
                method: "post",
                action: "https://other.test/login",
              };
            if (mode === "unknown-form") d.authForm = undefined;
            return d;
          },
        };
      };
      const s = await setup(caps);
      if (mode === "submit-other-frame")
        s.fake.frames = async () => [
          { id: s.fake.id, url: s.fake.url, epoch: 0 },
          { id: "other", parentId: s.fake.id, url: s.fake.url, epoch: 0 },
        ];
      try {
        await assert.rejects(
          s.tab.auth.request({
            fields: [
              {
                id: "p",
                label: "Secret",
                type: mode === "otp-textbox" ? "otp" : "password",
                target: s.tab.locator("#pass"),
              },
            ],
            submit: {
              target: s.tab.locator("#submit", {
                frameId: mode === "submit-other-frame" ? "other" : undefined,
              }),
            },
          }),
          { code: "AUTH_LOCATOR_INVALID" },
        );
        assert.equal(s.channel.pending().credentials, 0);
        assert.equal(s.notices.length, 0);
        assert.deepEqual(s.fake.inputEvents, []);
      } finally {
        await s.cua.engine.close();
      }
    });
  }
});

test("secure input rechecks field classification and form method after the user replies", async (t) => {
  for (const mode of ["type", "form"])
    await t.test(mode, async () => {
      let changed = false;
      const caps = fakeCapabilities(),
        bind = caps.action!.bind.bind(caps.action);
      caps.action!.bind = async (binding) => {
        const action = await bind(binding);
        return {
          ...action,
          describe: async (target, ctx) => ({
            ...(await action.describe!(target, ctx)),
            sensitive: !(changed && mode === "type"),
            authForm: {
              method: changed && mode === "form" ? "get" : "post",
              action: "https://login.test/login",
            },
          }),
        };
      };
      const s = await setup(caps);
      try {
        const pending = s.tab.auth.request({
          fields: [
            {
              id: "p",
              label: "Password",
              type: "password",
              target: s.tab.locator("#pass"),
            },
          ],
        });
        const rejection = assert.rejects(pending, {
          code: "AUTH_SUBMISSION_FAILED",
        });
        const id = await pendingId(s);
        changed = true;
        s.channel.submitCredentials(id, { p: SECRET });
        await rejection;
        assert.deepEqual(s.fake.inputEvents, []);
        assert.equal(s.fake.filled.has("#pass"), false);
      } finally {
        await s.cua.engine.close();
      }
    });
});
