import { test } from "node:test";
import assert from "node:assert/strict";
import { CUAService } from "@cua/service";
import { MCPAdapter } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";
test("mock model messages traverse MCP adapter, service IPC and fake browser", async () => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  const adapter = new MCPAdapter(service);
  try {
    assert.equal(adapter.tools().length, 8);
    let response = await adapter.call("cua_exec", {
      code: "var browser=await cua.connect();var tab=await browser.tabs.create();output.json(await tab.ax.snapshot());",
    });
    assert.equal(
      (response.structuredContent as any).status,
      "succeeded",
      JSON.stringify(response),
    );
    const first = JSON.parse(response.content[0].text);
    assert.equal(first.isDiff, false);
    response = await adapter.call("cua_exec", {
      code: 'await tab.getByRole("button").click();output.json(await tab.ax.snapshot());',
    });
    const second = JSON.parse(response.content[0].text);
    assert.equal(second.baseObservationId, first.observationId);
    assert.equal(provider.connection.pages[0].inputEvents.length, 1);
    assert.equal(
      (await adapter.call("cua_exec", { code: "1", wrong: true })).isError,
      true,
    );
    await adapter.call("cua_reset");
    response = await adapter.call("cua_exec", {
      code: "var browser=await cua.connect();var tab=(await browser.tabs.list())[0];output.json(await tab.ax.snapshot());",
    });
    assert.equal(JSON.parse(response.content[0].text).isDiff, false);
  } finally {
    await adapter.close();
    await service.close();
  }
  assert.equal(provider.connection.connected, false);
});
test("AX baseline advances only for original, untruncated snapshot output from succeeded cells", async () => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  const { sessionId } = await service.createSession();
  const exec = (code: string) => service.execute({ sessionId, code });
  try {
    await exec(
      "var browser=await cua.connect();var tab=await browser.tabs.create();var s=await tab.ax.snapshot();",
    );
    let r = await exec("output.json(await tab.ax.snapshot());");
    const baseline = JSON.parse(r.output[0].text!);
    assert.equal(baseline.isDiff, false);
    await exec('output.json(await tab.ax.snapshot());throw Error("failed");');
    r = await exec("output.json(await tab.ax.snapshot());");
    assert.equal(
      JSON.parse(r.output[0].text!).baseObservationId,
      baseline.observationId,
    );
    await exec(
      "var unreported=await tab.ax.snapshot();output.text(JSON.stringify(unreported));",
    );
    r = await exec(
      "output.json(await tab.ax.snapshot({since:unreported.observationId}));",
    );
    assert.equal(
      JSON.parse(r.output[0].text!).baseObservationId !==
        baseline.observationId,
      true,
    );
  } finally {
    await service.close();
  }
});

test("mutating an original AX object prevents delivery baseline advancement", async () => {
  const provider = new FakeBrowserProvider();
  const service = new CUAService({
    profiles: {
      fake: () => ({
        browser: provider,
        capabilities: fakeCapabilities(),
        targetResolvers: [fakeResolver],
      }),
    },
  });
  const { sessionId } = await service.createSession();
  try {
    let result = await service.execute({
      sessionId,
      code: 'var b=await cua.connect();var t=await b.tabs.create();var s=await t.ax.snapshot();s.title="changed";output.json(s);',
    });
    assert.equal(result.status, "succeeded");
    result = await service.execute({
      sessionId,
      code: "output.json(await t.ax.snapshot());",
    });
    assert.equal(JSON.parse(result.output[0].text!).isDiff, false);
  } finally {
    await service.close();
  }
});
