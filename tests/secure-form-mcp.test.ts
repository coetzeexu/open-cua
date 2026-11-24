import { test } from "node:test";
import assert from "node:assert/strict";
import type { CUAService } from "@cua/service";
import { SecureFormApps } from "../packages/mcp/src/secure-form.js";

function fixture() {
  let live = true;
  let status = "pending";
  let writes = 0;
  let fail = false;
  const submitted = new Set<string>();
  const request = {
    id: "form-1",
    sessionId: "session-1",
    origin: "https://example.test",
    title: "Passenger 1",
    schemaRevision: "revision-1",
    expiresAt: Date.now() + 60000,
    fields: [
      {
        id: "passport",
        label: "Passport",
        control: "text",
        masked: true,
        required: true,
      },
    ],
  };
  const service = {
    status: () =>
      live
        ? [{ sessionId: "session-1", executionId: "execution-original" }]
        : [],
    secureFormState(sessionId: string, requestId: string) {
      if (!live || sessionId !== "session-1" || requestId !== "form-1")
        return undefined;
      return {
        status,
        requestId,
        operationId: "operation-1",
        executionId: "execution-original",
        nextAction: status === "partial_or_unknown" ? "human_review" : "wait",
        ...(status === "pending" ? { request } : {}),
      };
    },
    answerSecureForm(_sessionId: string, _requestId: string, answer: any) {
      if (fail) throw Error("upstream included VERY_PRIVATE_VALUE");
      if (answer.action === "decline") {
        status = "cancelled";
        return;
      }
      if (submitted.has(answer.submissionId)) return;
      if (status !== "pending" || answer.schemaRevision !== "revision-1")
        throw Error("invalid");
      submitted.add(answer.submissionId);
      writes++;
      status = "accepted";
    },
  } as unknown as CUAService;
  const apps = new SecureFormApps(service, (id) => live && id === "session-1");
  return {
    apps,
    request,
    service,
    writes: () => writes,
    setStatus: (s: string) => {
      status = s;
    },
    stop: () => {
      live = false;
    },
    fail: () => {
      fail = true;
    },
  };
}
const open = async (f: ReturnType<typeof fixture>) => {
  const result: any = await f.apps.call("cua_secure_form", {
    sessionId: "session-1",
    requestId: "form-1",
  });
  assert.equal(result.isError, undefined);
  return {
    result,
    access: {
      sessionId: "session-1",
      requestId: "form-1",
      token: result._meta.cua.token,
    },
  };
};

test("secure form grants are request scoped, rotated and revoked on close", async () => {
  const f = fixture();
  const first = await open(f);
  assert.equal(
    f.apps.tools().filter((t) => t._meta.ui.visibility?.includes("app")).length,
    2,
  );
  assert.ok(
    !JSON.stringify([
      first.result.content,
      first.result.structuredContent,
    ]).includes(first.access.token),
  );
  assert.ok(
    !JSON.stringify([
      first.result.content,
      first.result.structuredContent,
    ]).includes("Passport"),
  );
  for (const patch of [
    { requestId: "other" },
    { sessionId: "other" },
    { token: "0".repeat(64) },
  ]) {
    assert.equal(
      (
        await f.apps.call("cua_ui_secure_form_state", {
          ...first.access,
          ...patch,
        })
      ).isError,
      true,
    );
  }
  const second = await open(f);
  assert.equal(
    (await f.apps.call("cua_ui_secure_form_state", first.access)).isError,
    true,
  );
  assert.equal(
    (await f.apps.call("cua_ui_secure_form_state", second.access)).isError,
    undefined,
  );
  assert.equal(
    (await f.apps.call("cua_ui_frame", second.access)).isError,
    true,
  );
  f.apps.close();
  assert.equal(
    (await f.apps.call("cua_ui_secure_form_state", second.access)).isError,
    true,
  );
  assert.equal(
    (
      await f.apps.call("cua_secure_form", {
        sessionId: "session-1",
        requestId: "form-1",
      })
    ).isError,
    true,
  );
});

test("secure form receipt waits for execution and contains no values or private authority", async () => {
  const f = fixture();
  const { access } = await open(f);
  const answer = {
    ...access,
    action: "submit",
    schemaRevision: "revision-1",
    submissionId: "submission-1",
    values: { passport: "VERY_PRIVATE_VALUE" },
  };
  const accepted: any = await f.apps.call("cua_ui_secure_form_answer", answer);
  assert.equal(accepted._meta.cua.status, "accepted");
  assert.equal(accepted._meta.cua.continuation, undefined);
  assert.doesNotMatch(JSON.stringify(accepted), /VERY_PRIVATE_VALUE/);
  await f.apps.call("cua_ui_secure_form_answer", answer);
  assert.equal(f.writes(), 1);
  f.setStatus("filled");
  const reopened = await open(f);
  assert.equal(reopened.result._meta.cua.request, undefined);
  const done: any = await f.apps.call(
    "cua_ui_secure_form_state",
    reopened.access,
  );
  assert.equal(done._meta.cua.status, "filled");
  assert.match(
    done._meta.cua.continuation.content[0].text,
    /execution-original/,
  );
  assert.doesNotMatch(
    JSON.stringify(done._meta.cua.continuation),
    /VERY_PRIVATE_VALUE|Passport/,
  );
  assert.ok(
    !JSON.stringify(done._meta.cua.continuation).includes(
      reopened.access.token,
    ),
  );
  f.setStatus("partial_or_unknown");
  const uncertain: any = await f.apps.call(
    "cua_ui_secure_form_state",
    reopened.access,
  );
  assert.match(uncertain._meta.cua.continuation.content[0].text, /需要检查/);
  assert.equal(uncertain._meta.cua.nextAction, "human_review");
  assert.equal(f.writes(), 1);
  f.apps.close();
});

test("secure form rejects malformed private answers without leaking underlying errors", async () => {
  const f = fixture();
  const { access } = await open(f);
  for (const args of [
    { ...access, action: "submit", values: { passport: "VERY_PRIVATE_VALUE" } },
    {
      ...access,
      action: "decline",
      values: { passport: "VERY_PRIVATE_VALUE" },
    },
    {
      ...access,
      action: "submit",
      schemaRevision: "revision-1",
      submissionId: "s",
      values: { passport: 42 },
    },
    {
      ...access,
      action: "submit",
      schemaRevision: "revision-1",
      submissionId: "s",
      values: {},
      target: "forged",
    },
  ]) {
    const result = await f.apps.call("cua_ui_secure_form_answer", args);
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /VERY_PRIVATE_VALUE/);
  }
  assert.equal(f.writes(), 0);
  f.fail();
  const result = await f.apps.call("cua_ui_secure_form_answer", {
    ...access,
    action: "decline",
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /VERY_PRIVATE_VALUE|upstream/);
  f.stop();
  assert.equal(
    (await f.apps.call("cua_ui_secure_form_state", access)).isError,
    true,
  );
  f.apps.close();
});
