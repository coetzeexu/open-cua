import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  object,
  parseJSON,
  requireValue,
  RunnerFault,
  token,
} from "./common.js";
import type { RunnerConfig, ScriptContext, ScriptReturn } from "./index.js";
import type { ScriptBundle } from "./scripts.js";
import type { StoredRun } from "./store.js";

export interface McpConnection {
  readonly sessionId?: string;
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<any>;
  close(): Promise<void>;
}
export type McpConnector = (config: RunnerConfig) => Promise<McpConnection>;
export const connectMcp: McpConnector = async (config) => {
  const client = new Client({ name: "cua-runner", version: "0.7.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.mcp.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token(config.mcp.token_env)}` },
      redirect: "error",
    },
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        redirect: "error",
        signal: init?.signal
          ? AbortSignal.any([
              init.signal,
              AbortSignal.timeout(config.limits.io_timeout_ms),
            ])
          : AbortSignal.timeout(config.limits.io_timeout_ms),
      }),
  });
  try {
    await client.connect(transport, { timeout: config.limits.io_timeout_ms });
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const list = await client.listTools(
        { cursor },
        { timeout: config.limits.io_timeout_ms },
      );
      list.tools.forEach((t) => names.add(t.name));
      cursor = list.nextCursor;
    } while (cursor);
    for (const name of [
      "cua_session_create",
      "cua_exec",
      "cua_poll",
      "cua_cancel",
      "cua_close",
    ])
      requireValue(
        names.has(name),
        "MCP_UNAVAILABLE",
        `Required MCP tool missing: ${name}`,
        503,
      );
    return {
      get sessionId() {
        return transport.sessionId;
      },
      async call(name, args, signal) {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { signal, timeout: config.limits.io_timeout_ms },
        );
        requireValue(
          !result.isError && object(result.structuredContent),
          "MCP_UNAVAILABLE",
          "MCP tool failed or returned an invalid response",
          503,
        );
        return result.structuredContent;
      },
      async close() {
        try {
          await transport.terminateSession();
        } finally {
          await client.close();
        }
      },
    };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
};

function wrapper(
  bundle: ScriptBundle,
  ctx: ScriptContext,
  marker: string,
): string {
  return `await (async function(){
    const marker = ${JSON.stringify(marker)};
    const freeze = v => { if(v && typeof v === 'object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v; };
    const ctx = freeze(JSON.parse(${JSON.stringify(JSON.stringify(ctx))}));
    const json = (v, seen=new Set()) => {
      if(v===null || typeof v==='string' || typeof v==='boolean') return;
      if(typeof v==='number' && Number.isFinite(v)) return;
      if(typeof v!=='object' || seen.has(v)) throw new Error('RUNNER_OUTPUT_INVALID');
      if(!Array.isArray(v) && Object.getPrototypeOf(v)!==Object.prototype && Object.getPrototypeOf(v)!==null) throw new Error('RUNNER_OUTPUT_INVALID');
      seen.add(v);
      if(Array.isArray(v)){for(let i=0;i<v.length;i++){if(!(i in v)) throw new Error('RUNNER_OUTPUT_INVALID');json(v[i],seen);}}
      else {if(Reflect.ownKeys(v).some(k=>typeof k!=='string')) throw new Error('RUNNER_OUTPUT_INVALID');Object.values(v).forEach(x=>json(x,seen));}
      seen.delete(v);
    };
    try {
      const result = await (async function(ctx){${bundle.main}\n})(ctx);
      json(result);
      if(await (async function(ctx,result){${bundle.verify}\n})(ctx,freeze(result)) !== true) throw new Error('RUNNER_VERIFICATION_FAILED');
      output.json({runnerMarker:marker,result});
    } catch(e) {
      output.json({runnerMarker:marker,failure:e?.message==='RUNNER_VERIFICATION_FAILED'?'VERIFICATION_FAILED':e?.message==='RUNNER_OUTPUT_INVALID'?'OUTPUT_INVALID':'EXECUTION_FAILED'});
      throw e;
    }
  })();`;
}

export class McpExecutor {
  constructor(
    private config: RunnerConfig,
    private connection: McpConnection,
  ) {}
  async probe() {
    const marker = randomUUID();
    const path = join(this.config.work_directory, `.probe-${marker}`);
    await writeFile(path, marker, { mode: 0o600, flag: "wx" });
    let sessionId: string | undefined;
    const signal = AbortSignal.timeout(this.config.limits.io_timeout_ms);
    try {
      const session = await this.connection.call(
        "cua_session_create",
        { profile: this.config.mcp.profile },
        signal,
      );
      requireValue(
        typeof session.sessionId === "string",
        "MCP_UNAVAILABLE",
        "Invalid MCP session",
        503,
      );
      sessionId = session.sessionId;
      const result = await this.connection.call(
        "cua_exec",
        {
          sessionId,
          requestId: marker,
          code: `output.json({shared:await (await import('node:fs/promises')).readFile(${JSON.stringify(path)},'utf8')});`,
          timeoutMs: Math.min(300000, this.config.limits.io_timeout_ms),
        },
        signal,
      );
      let current = result;
      const output = [...(result.output ?? [])];
      while (current.status === "running") {
        signal.throwIfAborted();
        current = await this.connection.call(
          "cua_poll",
          {
            sessionId,
            executionId: result.executionId,
            cursor: current.cursor,
            waitMs: 100,
          },
          signal,
        );
        output.push(...(current.output ?? []));
      }
      requireValue(
        current.status === "succeeded" &&
          output.some(
            (o) =>
              o.type === "json" &&
              !o.truncated &&
              parseJSON(o.text).shared === marker,
          ),
        "MCP_UNAVAILABLE",
        "Runner and CUA must share the work directory",
        503,
      );
    } finally {
      await rm(path, { force: true });
      if (sessionId) {
        const closed = await this.connection.call(
          "cua_close",
          { sessionId },
          AbortSignal.timeout(this.config.limits.cleanup_timeout_ms),
        );
        requireValue(
          closed.closed === true,
          "MCP_UNAVAILABLE",
          "Probe session cleanup failed",
          503,
        );
      }
    }
  }
  async execute(
    run: StoredRun,
    ctx: ScriptContext,
    signal: AbortSignal,
    save: () => void,
  ): Promise<ScriptReturn> {
    // Persist intent before even session creation: a lost response may own a lease.
    run.dispatched = true;
    save();
    const session = await this.connection.call(
      "cua_session_create",
      {
        profile: this.config.mcp.profile,
        runId: run.accepted.run_id,
        goal: run.bundle.manifest.description,
      },
      signal,
    );
    requireValue(
      typeof session.sessionId === "string",
      "MCP_UNAVAILABLE",
      "Invalid MCP session",
      503,
    );
    run.sessionId = session.sessionId;
    run.transportSessionId = this.connection.sessionId;
    save();
    const marker = randomUUID();
    const timeoutMs = Math.max(
      1,
      Math.min(
        300000,
        run.bundle.manifest.timeout_ms,
        run.deadline - Date.now(),
      ),
    );
    let result = await this.connection.call(
      "cua_exec",
      {
        sessionId: run.sessionId,
        requestId: run.accepted.run_id,
        code: wrapper(run.bundle, ctx, marker),
        timeoutMs,
      },
      signal,
    );
    const output = new Map<number, any>();
    let size = 0;
    for (;;) {
      requireValue(
        typeof result.executionId === "string" &&
          ["running", "succeeded", "failed", "cancelled", "timed_out"].includes(
            result.status,
          ) &&
          Array.isArray(result.output),
        "EXECUTION_UNKNOWN",
        "Invalid execution response",
      );
      requireValue(
        !run.executionId || run.executionId === result.executionId,
        "EXECUTION_UNKNOWN",
        "Execution identity changed",
      );
      run.executionId = result.executionId;
      if (result.cursor !== undefined) {
        requireValue(
          Number.isSafeInteger(result.cursor) &&
            result.cursor >= (run.cursor ?? 0),
          "EXECUTION_UNKNOWN",
          "Invalid execution cursor",
        );
        run.cursor = result.cursor;
      }
      save();
      for (const item of result.output) {
        requireValue(
          Number.isSafeInteger(item.sequence),
          "OUTPUT_INVALID",
          "Output sequence missing",
        );
        if (output.has(item.sequence)) continue;
        size += Buffer.byteLength(JSON.stringify(item));
        requireValue(
          size <= this.config.limits.request_max_bytes,
          "OUTPUT_INVALID",
          "Execution output exceeds limit",
        );
        output.set(item.sequence, item);
      }
      if (result.warnings?.some((w: any) => w.code === "USER_ACTION_REQUIRED"))
        throw new RunnerFault(
          "USER_ACTION_REQUIRED",
          "Prepare browser authentication before running scripts",
        );
      if (result.status !== "running") break;
      signal.throwIfAborted();
      result = await this.connection.call(
        "cua_poll",
        {
          sessionId: run.sessionId,
          executionId: run.executionId,
          cursor: run.cursor,
          waitMs: Math.min(1000, this.config.limits.io_timeout_ms),
        },
        signal,
      );
    }
    const envelopes = [...output.values()].flatMap((item) => {
      if (
        item.type !== "json" ||
        item.truncated ||
        typeof item.text !== "string"
      )
        return [];
      try {
        const value = parseJSON(item.text);
        return value?.runnerMarker === marker ? [value] : [];
      } catch {
        return [];
      }
    });
    if (
      envelopes.length === 1 &&
      ["VERIFICATION_FAILED", "OUTPUT_INVALID", "EXECUTION_FAILED"].includes(
        envelopes[0].failure,
      )
    )
      throw new RunnerFault(
        envelopes[0].failure,
        "Script execution or verification failed",
      );
    if (result.status === "timed_out")
      throw new RunnerFault("DEADLINE_EXCEEDED", "Script execution timed out");
    requireValue(
      result.status === "succeeded",
      "EXECUTION_FAILED",
      "Script execution failed",
    );
    requireValue(
      envelopes.length === 1 && object(envelopes[0].result),
      "OUTPUT_INVALID",
      "Missing, ambiguous or truncated script result",
    );
    return envelopes[0].result;
  }
  async cleanup(run: StoredRun): Promise<boolean> {
    if (!run.dispatched) return true;
    if (!run.sessionId) return false;
    const signal = AbortSignal.timeout(this.config.limits.cleanup_timeout_ms);
    try {
      if (run.executionId)
        await this.connection
          .call(
            "cua_cancel",
            { sessionId: run.sessionId, executionId: run.executionId },
            signal,
          )
          .catch(() => {});
      return (
        (
          await this.connection.call(
            "cua_close",
            { sessionId: run.sessionId },
            signal,
          )
        ).closed === true
      );
    } catch {
      return false;
    }
  }
}
