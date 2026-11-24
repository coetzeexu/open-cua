import { test } from "node:test";
import assert from "node:assert/strict";
import { CUAService } from "@cua/service";
import { waitPreviewExecution } from "@cua/preview";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
test("preview polling consumes cursors and lets execution complete after early output", async () => {
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: new FakeBrowserProvider(),
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
    executeWaitMs: 0,
  });
  try {
    const { sessionId } = await service.createSession();
    const initial = await service.execute({
      sessionId,
      code: 'output.text("early");await new Promise(r=>setTimeout(r,50));output.text("late");',
    });
    const done = await waitPreviewExecution(service, sessionId, initial);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(
      done.output.map((o) => o.text),
      ["early", "late"],
    );
  } finally {
    await service.close();
  }
});
