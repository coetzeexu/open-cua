import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  SandboxBrowserProvider,
  validateSandboxOptions,
} from "@cua/browser-sandbox";
import { validateConfig } from "@cua/cli";
import { FakeBrowser } from "@cua/testing";
import type { OperationContext } from "@cua/contracts";

function env(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  process.env[name] = value;
}

const endpoint = "http://127.0.0.1:9333";
const scope = (controller: AbortController): OperationContext => ({
  signal: controller.signal,
  sessionId: "test",
  generation: 1,
  scopeId: "test",
  timeoutMs: 10000,
  check() {
    controller.signal.throwIfAborted();
  },
  dispatch() {},
  afterDispatch() {},
  async policy() {},
});

test("sandbox rejects external endpoints and malformed configuration without leaking values", () => {
  for (const value of [
    "https://external.test/secret",
    "file:///secret",
    "http://user:secret@localhost",
    "http://localhost/#secret",
    "invalid-secret",
  ]) {
    assert.throws(
      () => new SandboxBrowserProvider({ endpoint: value }),
      (e: any) => {
        assert.doesNotMatch(e.message, /secret/);
        return true;
      },
    );
  }
  assert.throws(
    () =>
      new SandboxBrowserProvider({ endpointEnv: "CUA_TEST_MISSING_ENDPOINT" }),
    /missing/,
  );
  assert.throws(
    () => validateSandboxOptions({ endpoint, endpointEnv: "CDP" }),
    /not both/,
  );
  for (const connectTimeoutMs of [0, -1, 120001, NaN, 1.5])
    assert.throws(
      () => validateSandboxOptions({ connectTimeoutMs }),
      /connectTimeoutMs/,
    );
  assert.throws(
    () =>
      validateConfig({
        profiles: {
          s: { provider: "sandbox", sandbox: { endpointEnv: "bad name" } },
        },
      }),
    /identifiers/,
  );
  validateConfig({
    profiles: { s: { provider: "sandbox", sandbox: { endpoint } } },
  });
});

test("sandbox snapshots endpoint environment for lease and attach, requires existing context, no implicit handoff", async (t) => {
  env(t, "CUA_TEST_CDP", endpoint);
  let opts: any;
  const browser = new FakeBrowser();
  const p = new SandboxBrowserProvider({ endpointEnv: "CUA_TEST_CDP" }, (async (
    url: string,
    options: any,
  ) => {
    assert.equal(url, endpoint + "/");
    opts = options;
    return browser;
  }) as any);
  env(t, "CUA_TEST_CDP", "http://127.0.0.1:9999");
  assert.equal(
    p.resourceKey,
    new SandboxBrowserProvider({ endpoint: "http://localhost:9333/" })
      .resourceKey,
  );
  assert.doesNotMatch(p.resourceKey, /9333/);
  assert.equal(await p.connect(), browser);
  assert.equal(opts.mode, "attach");
  assert.equal(opts.existingContextOnly, true);
  assert.equal(opts.handoff, undefined);
  assert.equal(opts.cloudOwned, undefined);
  assert.equal(opts.onClose, undefined);
});

test("sandbox retries only connection readiness and sanitizes failure", async () => {
  let attempts = 0;
  const browser = new FakeBrowser();
  const p = new SandboxBrowserProvider(
    { endpoint, connectTimeoutMs: 1000 },
    (async () => {
      if (++attempts === 1) throw Error("private connection URL");
      return browser;
    }) as any,
  );
  assert.equal(await p.connect(), browser);
  assert.equal(attempts, 2);
  const start = performance.now();
  await assert.rejects(
    new SandboxBrowserProvider(
      { endpoint, connectTimeoutMs: 20 },
      (async () => {
        throw Error("private connection URL");
      }) as any,
    ).connect(),
    (e: any) => {
      assert.equal(e.code, "CONNECT_FAILED");
      assert.doesNotMatch(e.message, /private connection/);
      return true;
    },
  );
  assert.ok(performance.now() - start < 1000);
});

test("sandbox cancellation interrupts readiness and closes a late connection", async () => {
  const c = new AbortController();
  let attempts = 0;
  const p = new SandboxBrowserProvider({ endpoint }, (async () => {
    attempts++;
    c.abort(Error("cancelled"));
    throw Error("private");
  }) as any);
  await assert.rejects(p.connect(scope(c)), /cancelled/);
  assert.equal(attempts, 1);
  const c2 = new AbortController();
  const browser = new FakeBrowser();
  let closed = false;
  browser.close = async () => {
    closed = true;
  };
  const late = new SandboxBrowserProvider({ endpoint }, (async () => {
    c2.abort(Error("cancelled"));
    return browser;
  }) as any);
  await assert.rejects(late.connect(scope(c2)), /cancelled/);
  assert.equal(closed, true);
});

test("sandbox optional HTTPS handoff is supplied only through human target", async (t) => {
  env(t, "CUA_TEST_HANDOFF", "https://desktop.test/?token=private");
  let opts: any;
  const p = new SandboxBrowserProvider(
    { endpoint, handoffUrlEnv: "CUA_TEST_HANDOFF" },
    (async (_: string, o: any) => {
      opts = o;
      return new FakeBrowser();
    }) as any,
  );
  await p.connect();
  assert.deepEqual(await opts.handoff(), {
    kind: "url",
    url: "https://desktop.test/?token=private",
  });
  assert.doesNotMatch(JSON.stringify(p.descriptor), /private/);
  env(t, "CUA_TEST_HANDOFF", "http://desktop.test/?secret");
  assert.throws(
    () =>
      new SandboxBrowserProvider({
        endpoint,
        handoffUrlEnv: "CUA_TEST_HANDOFF",
      }),
    /HTTPS/,
  );
});

test("CDP readiness deadline covers a stalled health check and disconnects", async (t) => {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(
    new URL("../packages/browser-chromium/package.json", import.meta.url),
  )("playwright");
  const { connectChromiumEndpoint } = await import("@cua/browser-chromium");
  const { EventEmitter } = await import("node:events");
  let disconnected = false;
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: () => new Promise(() => {}),
      detach: async () => {},
    }),
    close: async () => {
      disconnected = true;
    },
  });
  t.mock.method(chromium, "connectOverCDP", async () => browser);
  await assert.rejects(
    connectChromiumEndpoint(endpoint, {
      mode: "attach",
      existingContextOnly: true,
      timeoutMs: 25,
    }),
    /timed out/,
  );
  assert.equal(disconnected, true);
});
