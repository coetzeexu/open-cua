import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentBayBrowserProvider } from "@cua/browser-agentbay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Opt-in only: creates one billable session and deletes it, even after failure.
test(
  "real AgentBay through stdio MCP with mock model messages",
  {
    skip: process.env.CUA_REAL_AGENTBAY !== "1",
    timeout: 240_000,
  },
  async () => {
    assert.ok(process.env.AGENTBAY_API_KEY, "AGENTBAY_API_KEY is required");
    assert.ok(process.env.AGENTBAY_IMAGE_ID, "AGENTBAY_IMAGE_ID is required");
    const lifecycleMode = process.env.AGENTBAY_LIFECYCLE_MODE ?? "managed";
    assert.ok(["managed", "server-default"].includes(lifecycleMode));
    const runId = `smoke-${randomUUID()}`;
    const labels = { cuaSession: runId };
    const verifier = new AgentBayBrowserProvider({
      apiKey: process.env.AGENTBAY_API_KEY,
    });
    // Check credentials before any create. Do not retry an uncertain create.
    assert.deepEqual(await verifier.lookup(labels), []);
    const directory = resolve("artifacts/agentbay", runId);
    await mkdir(directory, { recursive: true });
    const home = await mkdtemp("/tmp/cua-cloud-");
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify(
        {
          defaultProfile: "cloud",
          profiles: {
            cloud: {
              provider: "agentbay",
              agentbay: {
                mode: "create",
                lifecycleMode,
                imageId: process.env.AGENTBAY_IMAGE_ID,
                cuaSessionId: runId,
                idleReleaseTimeout: 10,
                maxRuntime: 30,
              },
            },
          },
          service: { executeWaitMs: 20000, cellTimeoutMs: 120000 },
        },
        null,
        2,
      ),
    );
    const client = new Client(
      { name: "mock-model-agentbay", version: "1" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("packages/cli/dist/index.js"),
        "serve",
        "--config",
        config,
      ],
      env: { ...(process.env as Record<string, string>), HOME: home },
      stderr: "pipe",
    });
    // Redact credential and URLs before retaining startup diagnostics.
    let diagnostics = "";
    transport.stderr?.on("data", (data) => {
      diagnostics += String(data)
        .replaceAll(process.env.AGENTBAY_API_KEY!, "[REDACTED]")
        .replace(/(?:https?|wss?):\/\/[^\s"\x27]+/g, "[URL REDACTED]");
    });
    const checks: string[] = [];
    const steps: { code: string; status: string; operationErrors: string[] }[] =
      [];
    let created: string[] = [];
    let cleanupVerified = false;
    const call = async (code: string, requestId?: string) => {
      let r: any = await client.callTool({
        name: "cua_exec",
        arguments: { code, requestId },
      });
      while (r.structuredContent?.status === "running") {
        r = await client.callTool({
          name: "cua_poll",
          arguments: { executionId: r.structuredContent.executionId },
        });
      }
      steps.push({
        code,
        status: r.structuredContent?.status ?? "missing",
        operationErrors: (r.structuredContent?.operations ?? [])
          .map((o: any) => o.error?.code)
          .filter(Boolean),
      });
      // Limit failure diagnostics to structured codes; endpoints can appear in exception messages.
      assert.equal(
        r.structuredContent?.status,
        "succeeded",
        JSON.stringify({
          status: r.structuredContent?.status,
          error: r.structuredContent?.error?.code,
          operations: r.structuredContent?.operations?.map((o: any) => ({
            status: o.status,
            code: o.error?.code,
          })),
        }),
      );
      return r;
    };
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 8);
      console.log("AgentBay MCP connected; creating dedicated cloud browser");
      const navigation = await call(
        'var browser=await cua.connect();var tab=await browser.tabs.create({url:"https://example.com"});output.text(await tab.evaluate(()=>document.title));',
      );
      assert.equal(navigation.content[0].text, "Example Domain");
      created = await verifier.lookup(labels);
      assert.equal(created.length, 1);
      checks.push("cloud create and public HTTPS navigation");
      console.log("Cloud browser connected; checking real DOM interactions");
      // Install an isolated fixture in the owned tab. Subsequent actions use AX and real browser input.
      await call(
        `await tab.evaluate(()=>{document.title="CUA AgentBay smoke";document.body.innerHTML='<main><h1>CUA AgentBay smoke</h1><label>Message <input aria-label="Message"></label><button>Submit</button><p role="status">Waiting</p></main>';document.querySelector('button').onclick=()=>{document.querySelector('[role=status]').textContent=document.querySelector('input').value;};});output.json(await tab.ax.snapshot());`,
      );
      const result = await call(
        'await tab.getByRole("textbox",{name:"Message"}).fill("mock model delivered to AgentBay");await tab.getByRole("button",{name:"Submit"}).click();output.json(await tab.ax.snapshot());',
        "mock-cloud-action-1",
      );
      assert.ok(
        result.content.some(
          (c: any) =>
            c.type === "text" &&
            c.text.includes("mock model delivered to AgentBay"),
        ),
      );
      checks.push("AX observe, textbox fill, button click, resulting AX text");
      const capture = await call(
        "output.image(await tab.screenshot.capture());",
      );
      const image = capture.content.find((c: any) => c.type === "image");
      assert.equal(image?.mimeType, "image/jpeg");
      assert.ok(image.data.length > 100);
      await writeFile(
        join(directory, "browser.jpg"),
        Buffer.from(image.data, "base64"),
      );
      checks.push("native MCP JPEG screenshot");
      await client.callTool({ name: "cua_reset", arguments: {} });
      const persisted = await call(
        'var browser=await cua.connect();var tabs=await browser.tabs.list();var tab=tabs[tabs.length-1];output.text(await tab.evaluate(()=>document.querySelector("[role=status]")?.textContent));',
      );
      assert.equal(
        persisted.content[0].text,
        "mock model delivered to AgentBay",
      );
      checks.push("worker reset preserves cloud browser state");
      const closed: any = await client.callTool({
        name: "cua_close",
        arguments: {},
      });
      assert.equal(closed.structuredContent.closed, true);
      assert.deepEqual(await verifier.lookup(labels), []);
      // A second release exercises the SDK's real not-found response.
      await verifier.release(created[0]);
      const journalDir = join(home, ".cua/state/instances");
      const records = (
        await Promise.all(
          (await readdir(journalDir))
            .filter((f) => f.endsWith(".jsonl"))
            .map(async (f) =>
              (await readFile(join(journalDir, f), "utf8"))
                .trim()
                .split("\n")
                .map((s) => JSON.parse(s)),
            ),
        )
      ).flat();
      assert.ok(
        records.some(
          (r) => r.event === "released" && r.resourceId === created[0],
        ),
      );
      checks.push(
        "cua_close deletes cloud session, label lookup empty, repeated release succeeds, journal released",
      );
      cleanupVerified = true;
      console.log("Cloud browser use passed; session deletion verified");
    } finally {
      if (!cleanupVerified && diagnostics)
        console.log(diagnostics.slice(-3000));
      await client.close();
      // Only this run's unique label may be cleaned up. Failures are not hidden.
      const leftovers = await verifier.lookup(labels);
      for (const id of leftovers) await verifier.release(id);
      const remaining = await verifier.lookup(labels);
      await writeFile(
        join(directory, "report.json"),
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            runId,
            imageId: process.env.AGENTBAY_IMAGE_ID,
            lifecycleMode,
            created,
            checks,
            steps,
            cleanupVerified,
            fallbackCleanupCount: leftovers.length,
            remaining,
          },
          null,
          2,
        ),
      );
      console.log(`Sanitized evidence: ${directory}`);
      assert.deepEqual(remaining, []);
    }
  },
);
