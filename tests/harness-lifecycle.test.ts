import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CUAService } from "@cua/service";
import { startHttpGateway } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
// @ts-expect-error User-facing example is plain JavaScript.
import { runLifecycle } from "../examples/harness-lifecycle.mjs";

async function setup() {
  const provider = Object.assign(new FakeBrowserProvider(), {
    resourceKey: "lifecycle-test",
  });
  let connections = 0;
  provider.connect = async () => {
    connections++;
    throw Error("Must not open a browser");
  };
  const service = new CUAService({
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
  const token = randomBytes(32).toString("hex");
  const gateway = await startHttpGateway(service, { token, port: 0 });
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    service,
    gateway,
    connections: () => connections,
    options: { url: `http://127.0.0.1:${address.port}/mcp`, token },
    async close() {
      await gateway.close();
      await service.close();
    },
  };
}

test("lifecycle example collects output, handles code failure, cancels and releases via real HTTP MCP", async () => {
  const fixture = await setup();
  try {
    const r = await runLifecycle(fixture.options);
    assert.deepEqual(
      r.normal.output.map((o: any) => JSON.parse(o.text).batch),
      [1, 2],
    );
    assert.equal(r.expectedFailure.error.code, "USER_CODE_ERROR");
    assert.equal(r.cancelled.status, "cancelled");
    assert.equal(r.closed, true);
    assert.equal(r.mcpTerminated, true);
    assert.equal(fixture.service.leaseStatus().leased, false);
    assert.equal(fixture.gateway.connectionCount(), 0);
    assert.equal(fixture.connections(), 0);
    assert.ok(!JSON.stringify(r).includes(fixture.options.token));
  } finally {
    await fixture.close();
  }
});

test("failure after an execution starts still closes session when executionId is unavailable", async () => {
  const fixture = await setup();
  const execute = fixture.service.execute.bind(fixture.service);
  fixture.service.execute = async (args) => {
    await execute(args);
    throw Error("Injected failure after acceptance");
  };
  try {
    await assert.rejects(runLifecycle(fixture.options), (error: any) => {
      assert.equal(error.report.executions.length, 1);
      assert.equal(error.report.executions[0].executionId, undefined);
      assert.equal(error.report.closed, true);
      assert.equal(error.report.mcpTerminated, true);
      return true;
    });
    assert.equal(fixture.service.status().length, 0);
    assert.equal(fixture.service.leaseStatus().leased, false);
  } finally {
    await fixture.close();
  }
});

test("closed:false is reported as failure even if terminating MCP subsequently cleans up", async () => {
  const fixture = await setup();
  const close = fixture.service.closeSession.bind(fixture.service);
  let first = true;
  fixture.service.closeSession = async (args) => {
    if (first) {
      first = false;
      return { sessionId: args.sessionId, closed: false };
    }
    return close(args);
  };
  try {
    await assert.rejects(runLifecycle(fixture.options), (error: any) => {
      assert.equal(error.report.closed, false);
      assert.equal(error.report.mcpTerminated, true);
      return true;
    });
    assert.equal(fixture.service.status().length, 0);
  } finally {
    await fixture.close();
  }
});
