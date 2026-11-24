import { createServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  canonical,
  fields,
  hash,
  id,
  object,
  parseJSON,
  requireValue,
  RunnerFault,
  token,
} from "./common.js";
import { Scripts } from "./scripts.js";
import { Files } from "./files.js";
import {
  connectMcp,
  McpExecutor,
  type McpConnector,
  type McpConnection,
} from "./mcp.js";
import { RunStore, terminal, type StoredRun } from "./store.js";
import type {
  RunnerConfig,
  RunScriptRequest,
  ScriptSchemaRequest,
  RunResult,
  RunAccepted,
} from "./index.js";

export interface RunnerOptions {
  /** Omit for a single principal named service authenticated by listen.token_env. */
  authenticate?: (request: IncomingMessage) => Promise<string | undefined>;
  authorizeScript?: (principal: string, scriptId: string) => Promise<boolean>;
  /** Test/host integration seam; production defaults to the real HTTP MCP client. */
  connect?: McpConnector;
  /** Operator attests old CUA sessions/actions have been independently stopped. */
  acknowledgeStopped?: boolean;
}
export function validateRunnerConfig(config: RunnerConfig): RunnerConfig {
  requireValue(
    object(config),
    "INVALID_REQUEST",
    "Runner config must be an object",
    400,
  );
  for (const key of [
    "listen",
    "mcp",
    "script_source",
    "input_files",
    "output_files",
    "limits",
  ] as const)
    requireValue(
      object(config[key]),
      "INVALID_REQUEST",
      `Missing config: ${key}`,
      400,
    );
  requireValue(
    typeof config.listen.host === "string" &&
      config.listen.host.length > 0 &&
      Number.isInteger(config.listen.port) &&
      config.listen.port >= 0 &&
      config.listen.port <= 65535,
    "INVALID_REQUEST",
    "Invalid listen address",
    400,
  );
  for (const url of [
    config.mcp.url,
    config.script_source.base_url,
    config.input_files.base_url,
    config.output_files.base_url,
  ]) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RunnerFault("INVALID_REQUEST", "Invalid service URL", 400);
    }
    requireValue(
      ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      "INVALID_REQUEST",
      "Service URLs must be HTTP(S) without embedded credentials/query",
      400,
    );
    requireValue(
      parsed.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname),
      "INVALID_REQUEST",
      "Non-loopback services require HTTPS",
      400,
    );
  }
  requireValue(
    id(config.mcp.profile) &&
      ["default", "ax", "dom"].includes(config.mcp.observation_mode),
    "INVALID_REQUEST",
    "Invalid MCP profile/mode",
    400,
  );
  for (const path of [config.state_directory, config.work_directory])
    requireValue(
      typeof path === "string" && isAbsolute(path),
      "INVALID_REQUEST",
      "Runner directories must be absolute",
      400,
    );
  for (const key of [
    "max_queue_size",
    "request_max_bytes",
    "max_script_bytes",
    "max_files_per_run",
    "max_run_file_bytes",
    "run_timeout_ms",
    "io_timeout_ms",
    "cleanup_timeout_ms",
    "retention_days",
  ] as const)
    requireValue(
      Number.isSafeInteger(config.limits[key]) &&
        config.limits[key] > 0 &&
        config.limits[key] <= 2147483647,
      "INVALID_REQUEST",
      `Invalid limit: ${key}`,
      400,
    );
  for (const source of [config.input_files, config.output_files])
    requireValue(
      Number.isSafeInteger(source.max_bytes) && source.max_bytes > 0,
      "INVALID_REQUEST",
      "Invalid file limit",
      400,
    );
  requireValue(
    typeof config.listen.token_env === "string" &&
      typeof config.mcp.token_env === "string",
    "INVALID_REQUEST",
    "Credential environment names are required",
    400,
  );
  requireValue(
    (token(config.listen.token_env)?.length ?? 0) >= 32,
    "INVALID_REQUEST",
    "Runner API token must be at least 32 characters",
    400,
  );
  token(config.mcp.token_env);
  token(config.script_source.token_env);
  token(config.input_files.token_env);
  token(config.output_files.token_env);
  return structuredClone(config);
}

export async function startRunner(
  rawConfig: RunnerConfig,
  options: RunnerOptions = {},
) {
  const config = validateRunnerConfig(rawConfig);
  await mkdir(config.work_directory, { recursive: true, mode: 0o700 });
  config.work_directory = await realpath(config.work_directory);
  const store = new RunStore(config.state_directory);
  let connection: McpConnection | undefined;
  try {
    store.recover();
    if (options.acknowledgeStopped) {
      // Only queued records remain nonterminal after recovery.
      store.acknowledgeStopped();
    }
    requireValue(
      !store.quarantined,
      "MCP_UNAVAILABLE",
      "Runner is quarantined. Stop old CUA work, then explicitly acknowledge recovery",
      503,
    );
    connection = await (options.connect ?? connectMcp)(config);
    const executor = new McpExecutor(config, connection);
    try {
      await executor.probe();
    } catch (e) {
      store.quarantine();
      throw e;
    }
    const scripts = new Scripts(config);
    const files = new Files(config, scripts);
    let accepting = true;
    let active: AbortController | undefined;
    let work: Promise<void> | undefined;
    let admissions = Promise.resolve();
    const cleanupBlocked = new Set<string>();
    let fatalStoreFailure = false;
    const update = (run: StoredRun) => {
      run.result.updated_at = new Date().toISOString();
      store.save(run);
    };
    const phase = (
      run: StoredRun,
      status: "preparing" | "running" | "publishing",
    ) => {
      run.result = { ...run.result, status } as RunResult;
      update(run);
    };
    const perform = async (run: StoredRun) => {
      let completed: { output: any; files: any[] } | undefined;
      let fault: RunnerFault | undefined;
      active = new AbortController();
      const remaining = run.deadline - Date.now();
      const timer = setTimeout(() => active?.abort(), Math.max(1, remaining));
      try {
        requireValue(
          remaining > 0,
          "DEADLINE_EXCEEDED",
          "Run expired in queue",
        );
        phase(run, "preparing");
        const current = await scripts.load(run.accepted, active.signal);
        store.checkVersion(current);
        requireValue(
          current.fingerprint === run.bundle.fingerprint,
          "INTEGRITY_MISMATCH",
          "Queued version changed",
          409,
        );
        const ctx = await files.prepare(
          run.accepted.run_id,
          run.principal,
          run.bundle,
          run.request.input,
          active.signal,
        );
        active.signal.throwIfAborted();
        phase(run, "running");
        const result = await executor.execute(run, ctx, active.signal, () =>
          update(run),
        );
        run.result.business_success = true;
        requireValue(
          Object.keys(result).length === 2 &&
            Object.hasOwn(result, "output") &&
            Object.hasOwn(result, "files"),
          "OUTPUT_INVALID",
          "Invalid script result structure",
        );
        requireValue(
          scripts.compile(run.bundle.manifest.output_schema)(result.output),
          "OUTPUT_INVALID",
          "Output does not match script schema",
        );
        phase(run, "publishing");
        const inputRefs = scripts.files(
          run.bundle.manifest.input_schema,
          run.request.input,
        );
        const artifacts = await files.publish(
          run.accepted.run_id,
          run.principal,
          result,
          active.signal,
          (artifact) => {
            run.receipts.push(artifact);
            update(run);
          },
          {
            count: inputRefs.length,
            bytes: inputRefs.reduce(
              (sum, item) => sum + item.ref.size_bytes,
              0,
            ),
          },
        );
        active.signal.throwIfAborted();
        completed = { output: result.output, files: artifacts };
      } catch (e) {
        if (!accepting)
          fault = new RunnerFault(
            "EXECUTION_UNKNOWN",
            "Runner stopped; inspect the run before retrying",
          );
        else if (active.signal.aborted)
          fault = new RunnerFault("DEADLINE_EXCEEDED", "Run deadline exceeded");
        else if (e instanceof RunnerFault)
          fault =
            run.dispatched && e.code === "MCP_UNAVAILABLE"
              ? new RunnerFault(
                  "EXECUTION_UNKNOWN",
                  "MCP execution outcome is unknown; inspect the run before retrying",
                )
              : e;
        else
          fault = new RunnerFault(
            run.result.status === "publishing"
              ? "OUTPUT_PUBLISH_FAILED"
              : run.dispatched
                ? "EXECUTION_UNKNOWN"
                : "INTERNAL_ERROR",
            "Run failed; inspect server state before retrying",
          );
        if (fault.code === "VERIFICATION_FAILED")
          run.result.business_success = false;
      } finally {
        clearTimeout(timer);
        const cleaned = await executor.cleanup(run);
        run.result.cleanup = cleaned ? "succeeded" : "failed";
        if (!cleaned) {
          cleanupBlocked.add(run.accepted.run_id);
          store.quarantine();
        }
        const finished_at = new Date().toISOString();
        run.result = completed
          ? {
              ...run.result,
              error: undefined,
              status: "succeeded",
              business_success: true,
              ...completed,
              finished_at,
            }
          : {
              ...run.result,
              output: undefined,
              files: undefined,
              status:
                fault?.code === "DEADLINE_EXCEEDED"
                  ? "timed_out"
                  : fault?.code === "EXECUTION_UNKNOWN"
                    ? "interrupted"
                    : "failed",
              error: {
                code: fault?.code ?? "INTERNAL_ERROR",
                message: fault?.message ?? "Run failed",
              },
              finished_at,
            };
        update(run);
        active = undefined;
      }
    };
    const wake = () => {
      if (work || !accepting || store.quarantined) return;
      work = (async () => {
        while (accepting && !store.quarantined) {
          const run = store.all().find((r) => r.result.status === "queued");
          if (!run) break;
          await perform(run);
        }
      })()
        .catch(() => {
          fatalStoreFailure = true;
          store.quarantine();
        })
        .finally(() => {
          work = undefined;
        });
    };
    const admit = (
      principal: string,
      request: RunScriptRequest,
    ): Promise<RunAccepted> => {
      const operation = admissions.then(async () => {
        requireValue(
          accepting,
          "MCP_UNAVAILABLE",
          "Runner execution is unavailable",
          503,
        );
        fields(
          request,
          ["cua_script_id", "request_id", "input"],
          ["script_version"],
        );
        requireValue(
          id(request.request_id) && object(request.input),
          "INVALID_REQUEST",
          "Invalid request ID or input",
          400,
        );
        await authorize(principal, request.cua_script_id);
        const digest = hash(canonical(request));
        const old = store.byRequest(principal, request.request_id);
        if (old) {
          requireValue(
            old.digest === digest,
            "IDEMPOTENCY_CONFLICT",
            "Request ID already refers to different input",
            409,
          );
          return old.accepted;
        }
        requireValue(
          !store.quarantined,
          "MCP_UNAVAILABLE",
          "Runner execution is unavailable",
          503,
        );
        requireValue(
          store.all().filter((r) => r.result.status === "queued").length <
            config.limits.max_queue_size,
          "QUEUE_FULL",
          "Runner queue is full",
          429,
        );
        const bundle = await scripts.load(request);
        store.checkVersion(bundle);
        requireValue(
          scripts.compile(bundle.manifest.input_schema)(request.input),
          "INPUT_INVALID",
          "Input does not match script schema",
        );
        scripts.files(bundle.manifest.input_schema, request.input);
        requireValue(
          accepting && !store.quarantined,
          "MCP_UNAVAILABLE",
          "Runner is shutting down or quarantined",
          503,
        );
        const runId = randomUUID();
        const now = new Date().toISOString();
        const accepted: RunAccepted = {
          run_id: runId,
          cua_script_id: bundle.manifest.cua_script_id,
          script_version: bundle.manifest.script_version,
          status: "queued",
        };
        store.save({
          principal,
          digest,
          request,
          bundle,
          accepted,
          deadline:
            Date.now() +
            Math.min(config.limits.run_timeout_ms, bundle.manifest.timeout_ms),
          receipts: [],
          result: {
            ...accepted,
            created_at: now,
            updated_at: now,
            business_success: null,
            cleanup: "pending",
          },
        });
        setImmediate(wake);
        return accepted;
      });
      admissions = operation.then(
        () => {},
        () => {},
      );
      return operation;
    };
    const authorize = async (principal: string, scriptId: string) => {
      requireValue(
        id(scriptId),
        "INVALID_REQUEST",
        "Invalid script identifier",
        400,
      );
      requireValue(
        !options.authorizeScript ||
          (await options.authorizeScript(principal, scriptId)),
        "FORBIDDEN",
        "Script access denied",
        403,
      );
    };
    const bearer = `Bearer ${token(config.listen.token_env)}`;
    const authenticate =
      options.authenticate ??
      (async (req: IncomingMessage) => {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from(bearer);
        return supplied.length === expected.length &&
          timingSafeEqual(supplied, expected)
          ? "service"
          : undefined;
      });
    const server = createServer(async (req, res) => {
      const respond = (status: number, value: unknown) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(status === 429 ? { "Retry-After": "5" } : {}),
        });
        res.end(JSON.stringify(value));
      };
      try {
        requireValue(
          accepting,
          "MCP_UNAVAILABLE",
          "Runner is shutting down",
          503,
        );
        requireValue(
          !req.headers.origin,
          "FORBIDDEN",
          "Browser-origin requests are not supported",
          403,
        );
        const principal = await authenticate(req);
        requireValue(
          principal && id(principal),
          "UNAUTHORIZED",
          "Authentication required",
          401,
        );
        requireValue(
          req.method === "POST",
          "INVALID_REQUEST",
          "POST required",
          405,
        );
        requireValue(
          ["/get_script_schema", "/run_cua_script", "/get_cua_result"].includes(
            req.url ?? "",
          ),
          "INVALID_REQUEST",
          "Unknown route",
          404,
        );
        requireValue(
          req.headers["content-type"]?.split(";")[0].trim() ===
            "application/json",
          "INVALID_REQUEST",
          "JSON content type required",
          415,
        );
        requireValue(
          Number(req.headers["content-length"] ?? 0) <=
            config.limits.request_max_bytes,
          "INVALID_REQUEST",
          "Request body too large",
          413,
        );
        let size = 0;
        const parts: Buffer[] = [];
        for await (const part of req.iterator({ destroyOnReturn: false })) {
          size += part.length;
          requireValue(
            size <= config.limits.request_max_bytes,
            "INVALID_REQUEST",
            "Request body too large",
            413,
          );
          parts.push(part);
        }
        const body = parseJSON(Buffer.concat(parts).toString("utf8"));
        if (req.url === "/run_cua_script")
          return respond(202, await admit(principal, body));
        if (req.url === "/get_script_schema") {
          fields(body, ["cua_script_id"], ["script_version"]);
          await authorize(principal, body.cua_script_id);
          const bundle = await scripts.load(body as ScriptSchemaRequest);
          store.checkVersion(bundle);
          const {
            cua_script_id,
            script_version,
            description,
            input_schema,
            output_schema,
          } = bundle.manifest;
          return respond(200, {
            cua_script_id,
            script_version,
            description,
            input_schema,
            output_schema,
          });
        }
        fields(body, ["run_id"]);
        requireValue(id(body.run_id), "INVALID_REQUEST", "Invalid run ID", 400);
        const run = store.get(body.run_id);
        requireValue(
          run && run.principal === principal,
          "RUN_NOT_FOUND",
          "Run not found",
          404,
        );
        respond(200, run.result);
      } catch (e) {
        const fault =
          e instanceof RunnerFault
            ? e
            : new RunnerFault("INTERNAL_ERROR", "Runner request failed", 500);
        respond(fault.httpStatus, {
          error: { code: fault.code, message: fault.message },
        });
      } finally {
        if (!req.complete) req.resume();
      }
    });
    server.requestTimeout = config.limits.io_timeout_ms;
    server.headersTimeout = config.limits.io_timeout_ms;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const cleanupExpired = async () => {
      for (const run of store.all())
        if (
          terminal(run.result.status) &&
          run.result.cleanup === "succeeded" &&
          "finished_at" in run.result &&
          Date.parse(run.result.finished_at) +
            config.limits.retention_days * 86400000 <
            Date.now()
        ) {
          await rm(join(config.work_directory, run.accepted.run_id), {
            recursive: true,
            force: true,
          });
          store.delete(run.accepted.run_id);
        }
    };
    const retryCleanup = async () => {
      if (!accepting || work || !cleanupBlocked.size) return;
      for (const runId of cleanupBlocked) {
        const run = store.get(runId)!;
        if (!run.sessionId || !(await executor.cleanup(run))) continue;
        run.result.cleanup = "succeeded";
        update(run);
        cleanupBlocked.delete(runId);
      }
      if (!cleanupBlocked.size && !fatalStoreFailure) {
        store.acknowledgeStopped();
        wake();
      }
    };
    let sweeping = Promise.resolve();
    const maintain = () => {
      sweeping = sweeping
        .then(async () => {
          await retryCleanup();
          await cleanupExpired();
        })
        .catch(() => {});
      return sweeping;
    };
    const interval = setInterval(() => {
      void maintain();
    }, 60000);
    interval.unref();
    setImmediate(wake);
    const address = server.address();
    requireValue(
      address && typeof address !== "string",
      "INTERNAL_ERROR",
      "Server address unavailable",
      500,
    );
    let closing: Promise<void> | undefined;
    return {
      url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
      get quarantined() {
        return store.quarantined;
      },
      /** Retry resource cleanup only; never re-execute a script. Also runs every minute. */
      retryCleanup: maintain,
      close() {
        return (closing ??= (async () => {
          accepting = false;
          active?.abort();
          clearInterval(interval);
          const stopped = new Promise<void>((resolve) =>
            server.close(() => resolve()),
          );
          server.closeIdleConnections();
          await admissions;
          await work;
          await sweeping;
          await connection!.close().catch(() => {});
          server.closeAllConnections();
          await stopped;
          store.close();
        })());
      },
    };
  } catch (e) {
    await connection?.close().catch(() => {});
    store.close();
    throw e;
  }
}
