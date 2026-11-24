import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CUAService, PendingUserChannel } from "@cua/service";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
import { SecureFormProtectionStore } from "../packages/service/src/secure-form-protection.js";

test("resource protection survives recreation, including an interrupted empty marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-protection-test-"));
  try {
    const store = new SecureFormProtectionStore(directory);
    await store.prepare();
    assert.equal(store.has("resource-private-endpoint"), false);
    store.mark("resource-private-endpoint");
    store.mark("resource-private-endpoint");
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.match(names[0], /^[a-f0-9]{64}\.protected$/);
    const path = join(directory, names[0]);
    assert.equal(await readFile(path, "utf8"), "protected-v1\n");
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    await writeFile(path, "");
    const restored = new SecureFormProtectionStore(directory);
    await restored.prepare();
    assert.equal(restored.has("resource-private-endpoint"), true);
    assert.equal(restored.has("fresh-resource"), false);
    restored.mark("resource-private-endpoint");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted form protects same resource across close/recreate and a new Service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-protection-service-"));
  const channel = new PendingUserChannel();
  const resourceKey = "attached-private-resource";
  const create = () =>
    new CUAService({
      profiles: {
        fake: () => ({
          browser: Object.assign(new FakeBrowserProvider(), { resourceKey }),
          capabilities: fakeCapabilities(),
          targetResolvers: [fakeResolver],
        }),
      },
      userChannel: channel,
      secureFormProtectionDirectory: directory,
      executeWaitMs: 20,
    });
  const service = create();
  let restarted: CUAService | undefined;
  const settle = async (s: CUAService, sessionId: string, result: any) => {
    for (let i = 0; i < 100 && result.status === "running"; i++) {
      result = await s.getExecution({
        sessionId,
        executionId: result.executionId,
        cursor: result.cursor,
        waitMs: 100,
      });
      if (result.status === "running")
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.notEqual(result.status, "running");
    return result;
  };
  try {
    const { sessionId } = await service.createSession();
    await settle(
      service,
      sessionId,
      await service.execute({
        sessionId,
        code: 'var browser=await cua.connect();var tab=await browser.tabs.create({url:"https://private.test/form"});',
      }),
    );
    const execution = await service.execute({
      sessionId,
      code: 'output.json(await tab.secureForm.request({title:"Contact",fields:[{id:"name",label:"Name",control:"text",target:tab.locator("#name")}]}));',
    });
    let request = channel
      .listForSession(sessionId)
      .find((r) => r.type === "secure_form");
    for (let i = 0; i < 100 && !request; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      request = channel
        .listForSession(sessionId)
        .find((r) => r.type === "secure_form");
    }
    assert.equal(request?.type, "secure_form");
    if (request?.type !== "secure_form") throw Error("missing private request");
    service.answerSecureForm(sessionId, request.id, {
      action: "submit",
      schemaRevision: request.schemaRevision,
      submissionId: "first",
      values: { name: "PRIVATE_TEST_NAME" },
    });
    // The marker must be present before any async provider write can finish.
    assert.equal((await readdir(directory)).length, 1);
    await settle(service, sessionId, execution);
    assert.equal(
      service.secureFormState(sessionId, request.id).status,
      "filled",
    );
    await service.closeSession({ sessionId });
    const again = await service.createSession();
    let result = await settle(
      service,
      again.sessionId,
      await service.execute({
        sessionId: again.sessionId,
        code: 'var browser=await cua.connect();await browser.tabs.create({url:"https://private.test/"});',
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(JSON.stringify(result), /SECURE_FORM_PROTECTED/);
    await service.close();
    restarted = create();
    const fresh = await restarted.createSession();
    result = await settle(
      restarted,
      fresh.sessionId,
      await restarted.execute({
        sessionId: fresh.sessionId,
        code: 'var browser=await cua.connect();await browser.tabs.create({url:"https://private.test/"});',
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(JSON.stringify(result), /SECURE_FORM_PROTECTED/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_NAME/);
  } finally {
    await service.close();
    await restarted?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
