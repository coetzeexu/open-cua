import { test } from "node:test";
import assert from "node:assert/strict";
import { createCUA, CUAEngine } from "@cua/core";
import { SandboxBrowserProvider } from "@cua/browser-sandbox";
import { ChromiumBinding } from "@cua/browser-chromium";
import { operationError } from "@cua/contracts";
import {
  FakeBrowser,
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import { CUAService } from "@cua/service";

function setup() {
  let attempts = 0;
  let available = true;
  const connections: FakeBrowser[] = [];
  const provider = new SandboxBrowserProvider(
    { endpoint: "http://127.0.0.1:30152", connectTimeoutMs: 20 },
    async (endpoint, options) => {
      attempts++;
      assert.equal(endpoint, "http://127.0.0.1:30152/");
      assert.equal(options.mode, "attach");
      assert.equal(options.existingContextOnly, true);
      if (!available) throw Error("Browser is down");
      const connection = new FakeBrowser();
      connections.push(connection);
      return connection as unknown as ChromiumBinding;
    },
  );
  return {
    options: {
      browser: provider,
      capabilities: fakeCapabilities(),
      targetResolvers: [fakeResolver],
    },
    connections,
    attempts: () => attempts,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}

test("sandbox reconnects in the same CUA session and invalidates old handles and observations", async () => {
  const s = setup();
  const cua = createCUA(s.options);
  try {
    const old = await cua.connect();
    const tab = await old.tabs.create();
    await tab.ax.snapshot();
    const generation = cua.engine.generation;
    s.connections[0].connected = false;
    const browser = await cua.connect();
    assert.notEqual(browser.id, old.id);
    assert.equal(cua.engine.generation, generation + 1);
    assert.equal(s.attempts(), 2);
    await assert.rejects(old.tabs.list(), { code: "HANDLE_STALE" });
    await assert.rejects(tab.ax.snapshot(), { code: "HANDLE_STALE" });
    assert.equal((await browser.tabs.list()).length, 0);
    const fresh = await browser.tabs.create();
    await fresh.ax.snapshot();
    // Recovery must not call close() on the external browser or replay input.
    assert.equal(s.connections[0].pages[0].state, "ready");
    assert.equal(s.connections[0].pages[0].inputEvents.length, 0);
    assert.equal(s.connections[1].pages[0].inputEvents.length, 0);
  } finally {
    await cua.engine.close();
  }
});

test("browser not ready yields CONNECT_FAILED and a later connect can recover without closing the session", async () => {
  const s = setup();
  const engine = new CUAEngine(s.options);
  try {
    await engine.connect();
    s.connections[0].connected = false;
    s.setAvailable(false);
    await assert.rejects(engine.connect(), { code: "CONNECT_FAILED" });
    assert.equal(engine.describe().connected, false);
    s.setAvailable(true);
    await engine.connect();
    assert.equal(engine.describe().connected, true);
  } finally {
    await engine.close();
  }
});

test("concurrent connect calls share one recovery and healthy calls keep the existing connection", async () => {
  const s = setup();
  const engine = new CUAEngine(s.options);
  try {
    const first = await engine.connect();
    assert.equal(await engine.connect(), first);
    assert.equal(s.attempts(), 1);
    s.connections[0].connected = false;
    const [a, b, c] = await Promise.all([
      engine.connect(),
      engine.connect(),
      engine.connect(),
    ]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(s.attempts(), 2);
    assert.equal(engine.generation, 1);
  } finally {
    await engine.close();
  }
});

test("providers must opt into recovery; unrelated health errors do not replace the browser", async () => {
  const provider = new FakeBrowserProvider();
  const engine = new CUAEngine({
    browser: provider,
    capabilities: fakeCapabilities(),
    targetResolvers: [fakeResolver],
  });
  try {
    const connection = await engine.connect();
    provider.connection.connected = false;
    await assert.rejects(engine.connect(), { code: "BROWSER_DISCONNECTED" });
    assert.equal(provider.connection, connection);
  } finally {
    await engine.close();
  }

  const s = setup();
  const sandbox = new CUAEngine(s.options);
  try {
    const connection = await sandbox.connect();
    connection.health = async () => {
      throw operationError("POLICY_BLOCKED");
    };
    await assert.rejects(sandbox.connect(), { code: "POLICY_BLOCKED" });
    assert.equal(s.attempts(), 1);
    assert.equal(sandbox.generation, 0);
  } finally {
    await sandbox.close();
  }
});

test("recovery preserves the session-wide private workflow guard", async () => {
  const s = setup();
  const cua = createCUA(s.options);
  try {
    await cua.connect();
    cua.engine.enforceSecureFormProtection();
    s.connections[0].connected = false;
    const browser = await cua.connect();
    assert.equal(cua.engine.isSecureFormProtected(), true);
    await assert.rejects(browser.tabs.create(), {
      code: "SECURE_FORM_PROTECTED",
    });
  } finally {
    await cua.engine.close();
  }
});

test("disconnect after input dispatch remains unknown and recovery never replays it", async () => {
  const s = setup();
  const action = s.options.capabilities.action!;
  const bind = action.bind.bind(action);
  let inputs = 0;
  action.bind = async (context) => ({
    ...(await bind(context)),
    async perform(_kind, _target, _args, ctx) {
      ctx.dispatch();
      inputs++;
      s.connections[0].connected = false;
      throw operationError("BROWSER_DISCONNECTED", { phase: "dispatch" });
    },
  });
  const cua = createCUA(s.options);
  try {
    const tab = await (await cua.connect()).tabs.create();
    await assert.rejects(tab.locator("#submit").click(), {
      code: "BROWSER_DISCONNECTED",
      outcome: "unknown",
    });
    assert.equal(s.attempts(), 1);
    await cua.connect();
    assert.equal(s.attempts(), 2);
    assert.equal(inputs, 1);
  } finally {
    await cua.engine.close();
  }
});

test("MCP service worker receives the new generation and continues in the same execution", async () => {
  const s = setup();
  const service = new CUAService({
    profiles: { sandbox: () => s.options },
    executeWaitMs: 1000,
  });
  const { sessionId } = await service.createSession({ profile: "sandbox" });
  try {
    let result = await service.execute({
      sessionId,
      code: "var old=await cua.connect();var tab=await old.tabs.create();",
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    s.connections[0].connected = false;
    result = await service.execute({
      sessionId,
      code: "var browser=await cua.connect();var fresh=await browser.tabs.create();output.json(await fresh.info());try{await tab.info()}catch(e){output.text(e.code)}",
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.output.at(-1)?.text, "HANDLE_STALE");
    assert.equal(s.attempts(), 2);
  } finally {
    await service.close();
  }
});

test("Chromium health normalizes a disconnect during the CDP probe", async () => {
  let connected = true;
  const browser = {
    on() {},
    isConnected: () => connected,
    async newBrowserCDPSession() {
      connected = false;
      throw Error("Target browser has been closed");
    },
  };
  const context = { pages: () => [], on() {} };
  const binding = new ChromiumBinding(browser as any, context as any, "attach");
  await assert.rejects(binding.health(), { code: "BROWSER_DISCONNECTED" });
  await assert.rejects(binding.get("old-tab"), {
    code: "BROWSER_DISCONNECTED",
  });
});
