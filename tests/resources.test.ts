import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal, replay } from "@cua/service";
import {
  AgentBayBrowserProvider,
  type AgentBayClient,
  type CloudSession,
} from "@cua/browser-agentbay";
import { FakeBrowser } from "@cua/testing";
import type { ResourceRecord } from "@cua/contracts";
const cloud = () => {
  const events: string[] = [];
  const session: CloudSession = {
    sessionId: "cloud-1",
    browser: {
      async initializeAsync() {
        events.push("initialize");
        return true;
      },
      async getEndpointUrl() {
        return "http://secret-endpoint";
      },
    },
    async keepAlive() {
      events.push("keepAlive");
      return { success: true };
    },
  };
  const client: AgentBayClient = {
    async create(params) {
      events.push("create");
      assert.equal(params.lifecyclePolicy?.idleReleaseTimeout, 10);
      return { success: true, session };
    },
    async get() {
      return { success: true, session };
    },
    async delete() {
      events.push("delete");
      return { success: true };
    },
    async list() {
      return { success: true, sessionIds: [{ sessionId: session.sessionId }] };
    },
  };
  return { events, client, session };
};
test("AgentBay create order, keepalive and owned cleanup use injected client only", async () => {
  const { events, client } = cloud();
  const records: ResourceRecord[] = [];
  const provider = new AgentBayBrowserProvider({
    client,
    keepAliveMs: 10,
    journal: {
      async append(r) {
        records.push(r);
        events.push(r.event);
      },
    },
    connect: async (_endpoint, options) => {
      events.push("connect");
      const browser = new FakeBrowser();
      const close = browser.close.bind(browser);
      browser.close = async () => {
        await close();
        await options.onClose?.();
      };
      return browser;
    },
  });
  const b = await provider.connect();
  assert.deepEqual(events.slice(0, 5), [
    "intent",
    "create",
    "created",
    "initialize",
    "connect",
  ]);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(events.includes("keepAlive"));
  await b.close();
  assert.equal(events.at(-1), "released");
  assert.ok(events.includes("delete"));
  assert.doesNotMatch(JSON.stringify(records), /secret-endpoint/);
});
test("AgentBay attach never initializes, renews, or deletes caller resource", async () => {
  const { events, client } = cloud();
  const provider = new AgentBayBrowserProvider({
    client,
    mode: "attach",
    sessionId: "cloud-1",
    keepAliveMs: 5,
    connect: async (_endpoint, options) => {
      const browser = new FakeBrowser();
      browser.close = async () => {
        await options.onClose?.();
      };
      return browser;
    },
  });
  const b = await provider.connect();
  await new Promise((r) => setTimeout(r, 15));
  await b.close();
  assert.deepEqual(events, []);
});
test("AgentBay SDK attach discovers CDP without the Browser initialized flag", async () => {
  const { events, client, session } = cloud();
  session.browser.getEndpointUrl = async () => {
    throw Error("Browser is not initialized");
  };
  client.getAPIKey = () => "test-api-key";
  client.getClient = () => ({
    async getCdpLink(request) {
      assert.equal(request.sessionId, "cloud-1");
      assert.equal(request.authorization, "Bearer test-api-key");
      events.push("getCdpLink");
      return {
        body: { success: true, data: { url: "http://secret-endpoint" } },
      } as any;
    },
  });
  const provider = new AgentBayBrowserProvider({
    client,
    mode: "attach",
    sessionId: "cloud-1",
    connect: async (endpoint, options) => {
      assert.equal(endpoint, "http://secret-endpoint");
      assert.equal(options.mode, "attach");
      const browser = new FakeBrowser();
      browser.close = async () => {
        await options.onClose?.();
      };
      return browser;
    },
  });
  await (await provider.connect()).close();
  assert.deepEqual(events, ["getCdpLink"]);
  client.getClient = () => ({
    async getCdpLink() {
      return {
        body: { success: false, message: "private upstream error" },
      } as any;
    },
  });
  await assert.rejects(provider.connect(), (error: any) => {
    assert.equal(error.code, "CONNECT_FAILED");
    assert.doesNotMatch(error.message, /private upstream error/);
    return true;
  });
});
test("AgentBay unknown creation is never retried and keeps the intent", async () => {
  const { client } = cloud();
  let calls = 0;
  client.create = async () => {
    calls++;
    throw Error("connection lost");
  };
  const records: ResourceRecord[] = [];
  const p = new AgentBayBrowserProvider({
    client,
    journal: {
      async append(r) {
        records.push(r);
      },
    },
  });
  await assert.rejects(p.connect(), { code: "AGENTBAY_CREATE_UNKNOWN" });
  assert.equal(calls, 1);
  assert.equal(records.length, 1);
});
test("AgentBay partial initialization failure deletes only newly owned resource", async () => {
  const { client, session, events } = cloud();
  session.browser.initializeAsync = async () => false;
  await assert.rejects(new AgentBayBrowserProvider({ client }).connect(), {
    code: "CONNECT_FAILED",
  });
  assert.ok(events.includes("delete"));
});
test("journal recovers intent-only resource, torn tail, and retries failed recoverer progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-journal-test-"));
  const dead = new FileJournal({ directory, instanceId: "dead" });
  const record: ResourceRecord = {
    event: "intent",
    kind: "agentbay",
    key: "k",
    owned: true,
    labels: { cuaInstance: "dead" },
  };
  await dead.append(record);
  await writeFile(dead.path, "{torn", { flag: "a" });
  const recovery = new FileJournal({ directory, instanceId: "recovery" });
  await recovery.startInstance();
  let fail = true;
  const deleted: string[] = [];
  const handlers = {
    lookup: async () => ["one", "two"],
    release: async (r: ResourceRecord) => {
      if (r.resourceId === "two" && fail) throw Error("temporary");
      deleted.push(r.resourceId!);
    },
  };
  try {
    const first = await recovery.recover(handlers);
    assert.equal(first.failed.length, 1);
    assert.deepEqual(deleted, ["one"]);
    fail = false;
    const second = await recovery.recover(handlers);
    assert.equal(second.recovered.length, 1);
    assert.deepEqual(deleted, ["one", "two"]);
    assert.equal(
      (await readdir(directory)).filter((x) => x.includes("recovering")).length,
      0,
    );
  } finally {
    await recovery.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("only one live recoverer claims a journal; third instance resumes dead recoverer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-journal-race-"));
  const dead = new FileJournal({ directory, instanceId: "a" });
  await dead.append({
    event: "intent",
    key: "x",
    kind: "agentbay",
    owned: true,
  });
  const b = new FileJournal({ directory, instanceId: "b" }),
    c = new FileJournal({ directory, instanceId: "c" });
  await b.startInstance();
  await c.startInstance();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let lookups = 0;
  const handlers = {
    lookup: async () => {
      lookups++;
      await gate;
      throw Error("recovery interruption");
    },
    release: async () => {},
  };
  try {
    const first = b.recover(handlers);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await c.recover(handlers), { recovered: [], failed: [] });
    release();
    await first;
    assert.equal(lookups, 3);
    await b.close();
    const result = await c.recover({
      lookup: async () => ["owned"],
      release: async () => {},
    });
    assert.equal(result.recovered.length, 1);
  } finally {
    await b.close();
    await c.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("journal replay ignores only unfinished tail, never complete malformed records", () => {
  assert.deepEqual(replay('{"event":"intent"}\n{half'), [{ event: "intent" }]);
  assert.throws(() => replay("{bad}\n"));
});

test("AgentBay explicit server-default mode omits overrides and still owns cleanup", async () => {
  const { client, session, events } = cloud();
  let calls = 0;
  client.create = async (params) => {
    calls++;
    assert.equal("lifecyclePolicy" in params, false);
    assert.equal("idleReleaseTimeout" in params, false);
    assert.ok(params.labels?.cuaSession);
    return { success: true, session };
  };
  const provider = new AgentBayBrowserProvider({
    client,
    lifecycleMode: "server-default",
    connect: async (_endpoint, options) => {
      const browser = new FakeBrowser();
      browser.close = async () => {
        await options.onClose?.();
      };
      return browser;
    },
  });
  const browser = await provider.connect();
  await browser.close();
  assert.equal(calls, 1);
  assert.ok(events.includes("delete"));
});

test("AgentBay lifecycle rejection explains configuration without retry or secret leakage", async () => {
  const { client } = cloud();
  let calls = 0;
  client.create = async () => {
    calls++;
    return {
      success: false,
      errorMessage:
        "Failed to create session: InvalidParameter.maxRuntime(value=30, max=-1): code: 400 secret-value",
    };
  };
  await assert.rejects(
    new AgentBayBrowserProvider({ client }).connect(),
    (e: any) => {
      assert.equal(e.code, "CONNECT_FAILED");
      assert.match(e.message, /server-default/);
      assert.doesNotMatch(e.message, /secret-value/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("AgentBay empty hot pool reports capacity without replaying create or raw provider data", async () => {
  const { client } = cloud();
  let calls = 0;
  client.create = async () => {
    calls++;
    return {
      success: false,
      errorMessage:
        "SessionHandleError: No available instance in hot pool, poolId: private-pool",
    };
  };
  await assert.rejects(
    new AgentBayBrowserProvider({ client }).connect(),
    (e: any) => {
      assert.equal(e.code, "AGENTBAY_CREATE_UNKNOWN");
      assert.match(e.message, /pool capacity/);
      assert.doesNotMatch(e.message, /private-pool/);
      return true;
    },
  );
  assert.equal(calls, 1);
});
