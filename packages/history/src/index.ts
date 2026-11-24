import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";

export interface HistoryConfig {
  enabled?: boolean;
  directory?: string;
  maxEventBytes?: number;
  maxArtifactBytes?: number;
  captureOnFailure?: boolean;
  upload?: { enabled?: boolean; endpoint?: string };
}
export interface HistoryEvent {
  id: string;
  time: number;
  runId: string;
  type: string;
  sessionId?: string;
  executionId?: string;
  callId?: string;
  data: any;
}
export interface RunHistory {
  runId: string;
  events: HistoryEvent[];
  status: "incomplete" | "succeeded" | "failed" | "cancelled";
  businessSuccess: boolean;
}
export function storagePath(path: string) {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
export function safeId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  )
    throw Error("Invalid storage identifier");
  return value;
}
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
/** Publish only fully written JSON; interrupted temporary files are ignored by readers. */
export function atomicJSON(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function readJSON(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
const secretKey =
  /password|passwd|authorization|cookie|credential|secret|access.?token|refresh.?token|api.?key|^token$|^otp$/i;
export function sanitize(value: any, depth = 0): any {
  if (depth > 20) return "[depth limit]";
  if (typeof value === "string")
    return value
      .replace(/(Bearer\s+)[\w.+\/-]+/gi, "$1[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(
        /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
        "$1[redacted]",
      );
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["_meta", "__handle"].includes(k))
        .map(([k, v]) => [
          k,
          secretKey.test(k) ? "[redacted]" : sanitize(v, depth + 1),
        ]),
    );
  return value;
}
function privateData(data: any): any {
  // Never retain free-form text, parameters, diagnostics, or identifiers from page code.
  const result: any = { restricted: true };
  for (const key of [
    "status",
    "phase",
    "outcome",
    "aggregateOutcome",
    "stateImpact",
    "control",
  ])
    if (typeof data?.[key] === "string" && /^[a-z_]+$/.test(data[key]))
      result[key] = data[key];
  if (Array.isArray(data?.operations))
    result.operations = data.operations.map(privateData);
  return result;
}
export function validateHistoryConfig(config: HistoryConfig = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("Invalid history configuration");
  for (const key of ["enabled", "captureOnFailure"] as const)
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw Error(`history.${key} must be boolean`);
  if (
    config.directory !== undefined &&
    (typeof config.directory !== "string" || !config.directory)
  )
    throw Error("Invalid history.directory");
  for (const key of ["maxEventBytes", "maxArtifactBytes"] as const)
    if (
      config[key] !== undefined &&
      (!Number.isSafeInteger(config[key]) || config[key]! < 1024)
    )
      throw Error(`Invalid history.${key}`);
  if (
    config.upload !== undefined &&
    (!config.upload ||
      typeof config.upload !== "object" ||
      Array.isArray(config.upload))
  )
    throw Error("Invalid history.upload");
  if (
    config.upload?.enabled !== undefined &&
    typeof config.upload.enabled !== "boolean"
  )
    throw Error("Invalid history.upload.enabled");
  if (config.upload?.enabled) {
    const endpoint = new URL(config.upload.endpoint ?? "");
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password
    )
      throw Error(
        "History upload requires HTTPS endpoint without embedded credentials",
      );
  }
}
export class FileHistoryStore {
  readonly directory: string;
  readonly enabled: boolean;
  private sequence = 0;
  private privateSessions = new Set<string>();
  private scrubbedSessions = new Set<string>();
  constructor(readonly config: HistoryConfig = {}) {
    validateHistoryConfig(config);
    this.directory = storagePath(
      config.directory ?? process.env.CUA_HISTORY_DIRECTORY ?? "~/.cua/history",
    );
    this.enabled = config.enabled !== false;
  }
  private root(runId: string) {
    return join(this.directory, safeId(runId));
  }
  private restricted(runId: string, sessionId?: string) {
    return (
      !!sessionId &&
      (this.privateSessions.has(`${runId}/${sessionId}`) ||
        existsSync(join(this.root(runId), `private-${safeId(sessionId)}`)))
    );
  }
  append(
    runId: string,
    type: string,
    data: unknown,
    context: Partial<
      Pick<HistoryEvent, "sessionId" | "executionId" | "callId">
    > = {},
  ) {
    if (!this.enabled) return;
    const root = this.root(runId);
    privateDirectory(root);
    const time = Date.now();
    const id = `${time}-${String(this.sequence++).padStart(10, "0")}-${randomUUID()}`;
    let payload = this.restricted(runId, context.sessionId)
      ? privateData(data)
      : sanitize(data);
    const bytes = Buffer.byteLength(JSON.stringify(payload) ?? "null");
    if (bytes > (this.config.maxEventBytes ?? 262144))
      payload = {
        ...privateData(payload),
        restricted: this.restricted(runId, context.sessionId) || undefined,
        truncated: true,
        originalBytes: bytes,
      };
    const event: HistoryEvent = {
      id,
      time,
      runId,
      type,
      ...context,
      data: payload,
    };
    atomicJSON(join(root, `${id}.json`), event);
    return event;
  }
  restrictSession(runId: string, sessionId: string) {
    if (!this.enabled) return;
    if (this.scrubbedSessions.has(`${runId}/${sessionId}`)) return;
    this.privateSessions.add(`${runId}/${safeId(sessionId)}`);
    const root = this.root(runId);
    privateDirectory(root);
    atomicJSON(join(root, `private-${safeId(sessionId)}`), {
      restricted: true,
    });
    // Also scrub the bytes on disk, not just the query projection.
    for (const file of readdirSync(root).filter((f) => f.endsWith(".json"))) {
      const event = readJSON(join(root, file)) as HistoryEvent;
      if (event.sessionId === sessionId) {
        event.data = privateData(event.data);
        atomicJSON(join(root, file), event);
      }
    }
    rmSync(join(root, "artifacts", safeId(sessionId)), {
      recursive: true,
      force: true,
    });
    this.scrubbedSessions.add(`${runId}/${sessionId}`);
  }
  artifact(
    runId: string,
    sessionId: string,
    bytes: Uint8Array,
    mimeType: string,
  ) {
    if (!this.enabled || this.restricted(runId, sessionId)) return;
    if (bytes.byteLength > (this.config.maxArtifactBytes ?? 5242880))
      return { omitted: "size_limit" };
    const dir = join(this.root(runId), "artifacts", safeId(sessionId));
    privateDirectory(dir);
    const name = `${randomUUID()}.${mimeType === "image/png" ? "png" : "jpg"}`;
    const path = join(dir, name);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return {
      path: `artifacts/${sessionId}/${name}`,
      mimeType,
      bytes: bytes.byteLength,
    };
  }
  read(runId: string): RunHistory {
    const root = this.root(runId);
    const events = readdirSync(root)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const event = readJSON(join(root, f)) as HistoryEvent;
        if (this.restricted(runId, event.sessionId))
          event.data = privateData(event.data);
        return event;
      });
    const starts = events.filter((e) => e.type === "execution.started");
    const ends = events.filter((e) => e.type === "execution.finished");
    const open = starts.some(
      (e) => !ends.some((end) => end.executionId === e.executionId),
    );
    const completed = events.filter((e) => e.type === "run.completed").at(-1);
    const terminal = ends.at(-1)?.data.status;
    return {
      runId,
      events,
      status:
        open || !ends.length
          ? "incomplete"
          : terminal === "succeeded"
            ? "succeeded"
            : terminal === "cancelled"
              ? "cancelled"
              : "failed",
      businessSuccess:
        !open &&
        !!completed?.data.businessSuccess &&
        terminal === "succeeded" &&
        JSON.stringify(completed.data.executionIds) ===
          JSON.stringify(starts.map((e) => e.executionId).sort()),
    };
  }
  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(d.name),
      )
      .map((d) => {
        const r = this.read(d.name);
        return {
          runId: r.runId,
          status: r.status,
          businessSuccess: r.businessSuccess,
          events: r.events.length,
          updated: r.events.at(-1)?.time,
        };
      })
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }
  complete(runId: string, businessSuccess: boolean) {
    const run = this.read(runId);
    if (
      run.status === "incomplete" ||
      (businessSuccess && run.status !== "succeeded")
    )
      throw Error("Run has no successful completed execution");
    this.append(runId, "run.completed", {
      businessSuccess,
      executionIds: run.events
        .filter((e) => e.type === "execution.started")
        .map((e) => e.executionId)
        .sort(),
    });
  }
  delete(runId: string) {
    const run = this.read(runId);
    const sessions = run.events.filter((e) => e.type === "session.created");
    if (
      sessions.some(
        (s) =>
          !run.events.some(
            (e) => e.type === "session.closed" && e.sessionId === s.sessionId,
          ),
      )
    )
      throw Error(
        "Run has unclosed sessions; close them before deleting history",
      );
    rmSync(this.root(runId), { recursive: true });
  }
  async upload(runId: string) {
    if (!this.config.upload?.enabled) throw Error("History upload is disabled");
    const response = await fetch(this.config.upload.endpoint!, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sanitize(this.read(runId))),
    });
    if (!response.ok)
      throw Error(`History upload failed: HTTP ${response.status}`);
    return { uploaded: true, runId };
  }
}

export { analyzeRun, observationMethods, type RunAnalysis } from "./analysis.js";
