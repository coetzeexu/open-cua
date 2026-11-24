// Five-tool lifecycle example. Executes synthetic JavaScript only; no browser is opened.
// Run with Node 24.18.x from a checkout with dependencies installed:
// CUA_MCP_URL and CUA_MCP_TOKEN must be injected into the environment.
// node examples/harness-lifecycle.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function runLifecycle({ url, token, profile = "sandbox" }) {
  assert.ok(url && token, "Set CUA_MCP_URL and CUA_MCP_TOKEN");
  const client = new Client({ name: "cua-lifecycle-example", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  let sessionId;
  let activeExecutionId;
  const report = { executions: [], closed: false, mcpTerminated: false };
  const errors = [];

  async function call(name, args) {
    const reply = await client.callTool({ name, arguments: args });
    const result = reply.structuredContent;
    // Failed/timed-out executions also set isError; retain their execution evidence.
    if (!result || (reply.isError && !result.executionId)) {
      throw Object.assign(
        new Error(`${name}: ${result?.error?.code ?? "tool error"}`),
        {
          toolResult: result,
        },
      );
    }
    return result;
  }

  async function execute(code) {
    const requestId = randomUUID();
    // This demo keeps IDs in memory only; it is not a persistent Collector.
    const record = { requestId, code };
    report.executions.push(record);
    const result = await call("cua_exec", {
      sessionId,
      requestId,
      code,
      timeoutMs: 300000,
    });
    record.executionId = result.executionId;
    activeExecutionId =
      result.status === "running" ? result.executionId : undefined;
    return result;
  }

  async function pollToEnd(result) {
    const output = new Map(result.output.map((item) => [item.sequence, item]));
    while (result.status === "running") {
      result = await call("cua_poll", {
        sessionId,
        executionId: result.executionId,
        cursor: result.cursor,
        waitMs: 1000,
      });
      for (const item of result.output) output.set(item.sequence, item);
    }
    activeExecutionId = undefined;
    return { ...result, output: [...output.values()] };
  }

  try {
    await client.connect(transport);
    report.mcpSessionId = transport.sessionId;
    ({ sessionId } = await call("cua_session_create", { profile }));
    report.sessionId = sessionId;

    report.normal = await pollToEnd(
      await execute(
        'output.json({ batch: 1, rows: [{ id: "demo-1" }] });' +
          "await new Promise(resolve => setTimeout(resolve, 250));" +
          'output.json({ batch: 2, rows: [{ id: "demo-2" }] });',
      ),
    );
    assert.equal(report.normal.status, "succeeded");
    assert.equal(report.normal.output.length, 2);

    // Intentional code error: demonstrate structured failure handling.
    report.expectedFailure = await pollToEnd(
      await execute('throw new Error("intentional example failure");'),
    );
    assert.equal(report.expectedFailure.status, "failed");

    // Intentional pending cell: demonstrates cancel even with default executeWaitMs.
    const pending = await execute("await new Promise(() => {});");
    assert.equal(pending.status, "running");
    report.cancel = await call("cua_cancel", {
      sessionId,
      executionId: pending.executionId,
    });
    report.cancelled = await pollToEnd(
      await call("cua_poll", {
        sessionId,
        executionId: pending.executionId,
        cursor: 0,
        waitMs: 0,
      }),
    );
    assert.equal(report.cancelled.status, "cancelled");
  } catch (error) {
    // No automatic retry: transport failure does not prove an operation never ran.
    errors.push(error);
  } finally {
    // Each cleanup step is independent: failed cancel must not skip close.
    if (sessionId && activeExecutionId) {
      try {
        report.cleanupCancel = await call("cua_cancel", {
          sessionId,
          executionId: activeExecutionId,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (sessionId) {
      try {
        report.close = await call("cua_close", { sessionId });
        report.closed = report.close.closed === true;
        if (!report.closed) throw new Error("CUA cleanup incomplete");
      } catch (error) {
        errors.push(error);
      }
    }
    if (transport.sessionId) {
      try {
        await transport.terminateSession();
        report.mcpTerminated = true;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw Object.assign(
      new AggregateError(errors, "Lifecycle example incomplete"),
      { report },
    );
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await runLifecycle({
          url: process.env.CUA_MCP_URL,
          token: process.env.CUA_MCP_TOKEN,
          profile: process.env.CUA_PROFILE ?? "sandbox",
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    // Do not dump transport objects/headers: they may contain deployment secrets.
    console.error(
      JSON.stringify({ message: error.message, report: error.report }, null, 2),
    );
    process.exitCode = 1;
  }
}
