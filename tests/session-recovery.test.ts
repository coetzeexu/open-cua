import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUAService, ConfirmationServer } from "@cua/service";
import { MCPAdapter } from "@cua/mcp";
import { sessionCloseCommand } from "@cua/cli";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";

function setup() {
  const provider = Object.assign(new FakeBrowserProvider(), {
    resourceKey: "private-endpoint-must-not-leak",
  });
  const service = new CUAService({
    maxSessions: 1,
    profiles: {
      sandbox: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    executeWaitMs: 0,
    terminationGraceMs: 20,
  });
  return {
    service,
    first: new MCPAdapter(service),
    second: new MCPAdapter(service),
  };
}

test("foreign lease is diagnosable without creating a session or granting ownership", async () => {
  const { service, first, second } = setup();
  try {
    let r = await second.call("cua_session_status");
    assert.equal((r.structuredContent as any).leased, false);
    assert.equal(service.status().length, 0);
    const owner = await first.call("cua_describe");
    const id = (owner.structuredContent as any).sessionId;
    r = await second.call("cua_describe");
    const error = (r.structuredContent as any).error;
    assert.equal(error.code, "SESSION_BUSY");
    assert.equal(error.retryable, false);
    assert.equal(error.nextAction, "request_user");
    assert.equal(error.diagnostics.owner.sessionId, id);
    assert.match(error.diagnostics.recovery, /session-close/);
    assert.doesNotMatch(JSON.stringify(r), /private-endpoint-must-not-leak/);
    r = await second.call("cua_session_status");
    assert.equal((r.structuredContent as any).owner.sessionId, id);
    assert.equal(service.status().length, 1);
    assert.equal(
      (await second.call("cua_close", { sessionId: id })).isError,
      true,
    );
    await service.releaseSession({ sessionId: id });
    r = await second.call("cua_describe");
    assert.equal(r.isError, false);
    assert.notEqual((r.structuredContent as any).sessionId, id);
    // Releasing a stale owning adapter must not release the new owner's lease.
    await first.close();
    assert.equal(service.leaseStatus().leased, true);
  } finally {
    await first.close();
    await second.close();
    await service.close();
  }
});

test("local operator command refuses active/human sessions and can release an idle lease", async () => {
  const { service, first, second } = setup();
  const directory = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "cua-recover-"),
  );
  const server = new ConfirmationServer({
    instanceId: "recovery",
    directory,
    policies: () => [],
    status: () => service.status(),
    releaseSession: (input) => service.releaseSession(input),
  });
  await server.start();
  try {
    const { sessionId } = await service.createSession();
    const running = await service.execute({
      sessionId,
      code: "await new Promise(() => {});",
    });
    assert.equal(running.status, "running");
    await assert.rejects(
      sessionCloseCommand(sessionId, false, directory),
      /active or waiting/,
    );
    assert.equal(service.leaseStatus().leased, true);
    await service.cancelExecution({
      sessionId,
      executionId: running.executionId,
    });
    await service.interruptSession({ sessionId, takeControl: true });
    await assert.rejects(
      sessionCloseCommand(sessionId, false, directory),
      /active or waiting/,
    );
    assert.equal(
      (await sessionCloseCommand(sessionId, true, directory)).closed,
      true,
    );
    assert.equal(service.leaseStatus().leased, false);
    const r = await first.call("cua_describe");
    const id = (r.structuredContent as any).sessionId;
    assert.equal(
      (await sessionCloseCommand(id, false, directory)).closed,
      true,
    );
    // The old adapter can recover its implicit session after operator cleanup.
    const recovered = await first.call("cua_describe");
    assert.equal(recovered.isError, false);
    assert.notEqual((recovered.structuredContent as any).sessionId, id);
    await assert.rejects(
      sessionCloseCommand("missing", false, directory),
      /not found/,
    );
  } finally {
    await server.close();
    await first.close();
    await second.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent operator cleanup shares one close and revokes execution authority immediately", async () => {
  const { service, first, second } = setup();
  try {
    const { sessionId } = await service.createSession();
    const one = service.releaseSession({ sessionId });
    const two = service.closeSession({ sessionId });
    await assert.rejects(
      service.execute({ sessionId, code: "throw Error('must not execute')" }),
      { code: "RESULT_EXPIRED" },
    );
    assert.deepEqual(await Promise.all([one, two]), [
      { sessionId, closed: true },
      { sessionId, closed: true },
    ]);
    const fresh = await service.createSession();
    await service.closeSession({ sessionId });
    assert.equal(service.leaseStatus().owner?.sessionId, fresh.sessionId);
  } finally {
    await first.close();
    await second.close();
    await service.close();
  }
});
