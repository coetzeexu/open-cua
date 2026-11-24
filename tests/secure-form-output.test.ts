import { test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CUAService } from "@cua/service";
import { PendingUserChannel } from "@cua/core";
import { operationError } from "@cua/contracts";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";

const secret = "synthetic-sensitive-recovery-marker";
async function setup() {
  const provider = new FakeBrowserProvider();
  const channel = new PendingUserChannel();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    userChannel: channel,
    executeWaitMs: 1000,
  });
  const { sessionId } = await service.createSession();
  const session = (service as any).sessions.get(sessionId);
  const exec = (code: string) => service.execute({ sessionId, code });
  return { service, channel, sessionId, session, exec };
}
async function seed(
  channel: PendingUserChannel,
  sessionId: string,
  id = "request-safe",
) {
  await channel.collectSecureForm(
    {
      type: "secure_form",
      id,
      sessionId,
      tabId: "tab-safe",
      scopeId: "scope-safe",
      schemaRevision: "revision-safe",
      title: secret,
      origin: `https://example.test/${secret}`,
      groups: [],
      fields: [
        {
          id: "name",
          control: "text",
          label: secret,
          masked: false,
          required: true,
          nonEmpty: false,
        },
      ],
      delivery: { mode: "fill" },
      expiresAt: Date.now() + 60_000,
    },
    AbortSignal.abort(),
  );
  channel.updateSecureForm(id, {
    status: "filled",
    confirmedFieldIds: ["name"],
    nextAction: "human_review",
  });
}

test("private service output gate removes cached raw text/images and redacts errors on late poll", async () => {
  const { service, channel, sessionId, session, exec } = await setup();
  try {
    const prior = await exec(`output.text(${JSON.stringify(secret)});`);
    assert.ok(JSON.stringify(prior).includes(secret));
    const cached = session.results.get(prior.executionId);
    const path = join(session.directory, `${secret}.jpg`);
    await writeFile(path, new Uint8Array([1, 2, 3]));
    cached.result.output.push({
      sequence: 1,
      type: "image",
      path,
      imageId: secret,
      data: secret,
    });
    cached.result.warnings.push({ code: secret, message: secret });
    cached.result.operations.push({
      operationId: "91a304b2-3b18-4544-a86f-557421e5d53c",
      kind: "actions.fill",
      tabId: secret,
      status: "failed",
      phase: "dispatch",
      outcome: "unknown",
      error: operationError("ACTION_OUTCOME_UNKNOWN", {
        message: secret,
        diagnostics: { url: secret },
      }).toJSON(),
      extra: secret,
    });
    await seed(channel, sessionId);
    session.engine.enforceSecureFormProtection();
    const late = await service.getExecution({
      sessionId,
      executionId: prior.executionId,
      waitMs: 0,
    });
    assert.equal(late.status, "succeeded");
    assert.equal(late.aggregateOutcome, "some_unknown");
    assert.deepEqual(late.output, []);
    assert.equal(late.operations[0].kind, "actions.fill");
    assert.equal(late.operations[0].error?.code, "ACTION_OUTCOME_UNKNOWN");
    assert.equal(late.operations[0].error?.nextAction, "request_user");
    assert.ok(!JSON.stringify(late).includes(secret));
    assert.ok(!JSON.stringify(cached.result.output).includes(secret));
    assert.equal(late.warnings[0].code, "SECURE_FORM_PROTECTED");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(access(path));
    const next = await exec(
      `output.text(${JSON.stringify(secret)});output.json({private:${JSON.stringify(secret)}});throw Error(${JSON.stringify(secret)});`,
    );
    assert.equal(next.status, "failed");
    assert.equal(next.error?.code, "USER_CODE_ERROR");
    assert.deepEqual(next.output, []);
    assert.ok(!JSON.stringify(next).includes(secret));
    await (service as any).onMessage(session, {
      type: "warning",
      warning: { code: secret, message: secret },
    });
    assert.ok(!JSON.stringify(session.warnings).includes(secret));
    const retry = await service.getExecution({
      sessionId,
      executionId: next.executionId,
      waitMs: 0,
    });
    assert.ok(!JSON.stringify(retry).includes(secret));
  } finally {
    await service.close();
  }
});

test("private output replaces worker receipt with same-session authoritative public state", async () => {
  const { service, channel, sessionId, session, exec } = await setup();
  try {
    await seed(channel, sessionId);
    await seed(channel, "other-session", "other-request");
    const cached = await exec(
      `output.json({requestId:"request-safe",status:"forged",extra:${JSON.stringify(secret)}});`,
    );
    session.engine.enforceSecureFormProtection();
    const late = await service.getExecution({
      sessionId,
      executionId: cached.executionId,
      waitMs: 0,
    });
    assert.equal(late.output.length, 1);
    assert.equal(JSON.parse(late.output[0].text!).status, "filled");
    assert.ok(!JSON.stringify(late).includes(secret));
    const current = await exec(
      `output.json({requestId:"request-safe",status:"forged",values:{name:${JSON.stringify(secret)}}});output.json({requestId:"other-request"});output.json({requestId:"unknown"});output.text(${JSON.stringify(secret)});`,
    );
    assert.equal(current.output.length, 1);
    const state = JSON.parse(current.output[0].text!);
    assert.equal(state.requestId, "request-safe");
    assert.equal(state.status, "filled");
    assert.equal(state.nextAction, "human_review");
    assert.equal(state.request, undefined);
    assert.equal(state.values, undefined);
    assert.equal(state.extra, undefined);
    assert.ok(!JSON.stringify(current).includes(secret));
    const consumed = await service.getExecution({
      sessionId,
      executionId: current.executionId,
      cursor: current.cursor,
      waitMs: 0,
    });
    assert.deepEqual(consumed.output, []);
  } finally {
    await service.close();
  }
});

test("private describe never returns blocked history or health diagnostics, including mid-probe protection", async () => {
  const { service, sessionId, session } = await setup();
  try {
    session.engine.blocked.push({
      hostname: secret,
      reason: secret,
      time: Date.now(),
    });
    let probes = 0;
    session.engine.health = async () => {
      probes++;
      session.engine.enforceSecureFormProtection();
      return {
        browser: "unhealthy",
        error: { message: secret, diagnostics: { url: secret } },
      };
    };
    const first = await service.describe({ sessionId });
    assert.equal(probes, 1);
    assert.ok(!JSON.stringify(first).includes(secret));
    assert.ok("secureFormProtected" in first && first.secureFormProtected);
    const second = await service.describe({ sessionId });
    assert.equal(probes, 1);
    assert.deepEqual(second.health, {
      browser: "restricted",
      cdp: "restricted",
    });
    assert.equal("blocked" in second, false);
  } finally {
    await service.close();
  }
});
