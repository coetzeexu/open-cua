import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultPolicyProvider,
  CUAService,
  ConfirmationServer,
  socketRequest,
} from "@cua/service";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
test("policy local exemptions, deny precedence, single-use and expiry", async () => {
  const p = new DefaultPolicyProvider({
    deny: ["https://blocked.test"],
    confirmFirstVisit: true,
    confirmationTtlMs: 10,
  });
  const context = { sessionId: "s", kind: "goto" };
  for (const url of [
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "file:///tmp/a",
  ])
    await p.check(url, context);
  await assert.rejects(p.check("https://blocked.test", context), {
    code: "POLICY_BLOCKED",
  });
  let id = "";
  await assert.rejects(p.check("https://allowed.test", context), (e: any) => {
    id = e.diagnostics.confirmationId;
    return e.code === "POLICY_CONFIRMATION_REQUIRED";
  });
  assert.equal(p.decide(id, true), true);
  assert.equal(p.decide(id, true), false);
  await p.check("https://allowed.test", context);
  await assert.rejects(p.check("https://new.test", context), (e: any) => {
    id = e.diagnostics.confirmationId;
    return true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.decide(id, true), false);
});
test("Unix confirmation channel has private permissions and consumes IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-socket-"));
  const policy = new DefaultPolicyProvider({ confirmFirstVisit: true });
  const server = new ConfirmationServer({
    directory,
    instanceId: "test",
    policies: () => [policy],
    status: () => [],
  });
  await server.start();
  try {
    assert.equal((await stat(server.socketPath)).mode & 0o777, 0o600);
    let id = "";
    await assert.rejects(
      policy.check("https://example.test", { sessionId: "s", kind: "click" }),
      (e: any) => {
        id = e.diagnostics.confirmationId;
        return true;
      },
    );
    const found = await socketRequest(server.socketPath, {
      method: "inspect",
      id,
    });
    assert.equal(found.confirmation.origin, "https://example.test");
    assert.equal(
      (await socketRequest(server.socketPath, { method: "approve", id })).ok,
      true,
    );
    assert.equal(
      (await socketRequest(server.socketPath, { method: "approve", id })).ok,
      false,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("elicitation pauses the cell deadline and dispatches only after approval", async () => {
  const provider = new FakeBrowserProvider();
  const policy = new DefaultPolicyProvider({ confirmFirstVisit: true });
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        policy,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    cellTimeoutMs: 80,
  });
  let requested = 0;
  service.setElicitor(async (c) => {
    requested++;
    assert.equal(c.origin, "https://approval.test");
    assert.equal(provider.connection.pages.length, 0);
    await new Promise((r) => setTimeout(r, 130));
    return true;
  });
  const { sessionId } = await service.createSession();
  try {
    const r = await service.execute({
      sessionId,
      code: 'var browser=await cua.connect();var tab=await browser.tabs.create({url:"https://approval.test"});output.text("approved")',
    });
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    assert.equal(requested, 1);
    assert.equal(provider.connection.pages.length, 1);
  } finally {
    await service.close();
  }
});
test("Service leases attached browser identity and enforces concurrent session limits", async () => {
  const provider = Object.assign(new FakeBrowserProvider(), {
    resourceKey: "test-browser",
  });
  const service = new CUAService({
    maxSessions: 2,
    profiles: {
      a: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  try {
    const a = await service.createSession();
    await assert.rejects(service.createSession(), { code: "SESSION_BUSY" });
    await service.closeSession(a);
    await service.createSession();
  } finally {
    await service.close();
  }
});
