import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerFault } from "./common.js";
import type {
  OutputFile,
  RunAccepted,
  RunResult,
  RunScriptRequest,
} from "./index.js";
import type { ScriptBundle } from "./scripts.js";

export interface StoredRun {
  principal: string;
  digest: string;
  request: RunScriptRequest;
  bundle: ScriptBundle;
  accepted: RunAccepted;
  result: RunResult;
  deadline: number;
  sessionId?: string;
  executionId?: string;
  transportSessionId?: string;
  cursor?: number;
  dispatched?: boolean;
  receipts: OutputFile[];
}
export const terminal = (status: string) =>
  ["succeeded", "failed", "timed_out", "interrupted"].includes(status);
export class RunStore {
  private db: DatabaseSync;
  private lock: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    // OS-backed SQLite lock is released on process death, with no stale-PID race.
    this.lock = new DatabaseSync(join(directory, "runner-lock.sqlite"));
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (id INTEGER)",
      );
    } catch {
      this.lock.close();
      throw Error("Runner state directory is already in use");
    }
    try {
      this.db = new DatabaseSync(join(directory, "runner.sqlite"));
      chmodSync(join(directory, "runner.sqlite"), 0o600);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, principal TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(principal, request_id)); CREATE TABLE IF NOT EXISTS versions (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    } catch (e) {
      this.lock.close();
      throw e;
    }
  }
  all(): StoredRun[] {
    return this.db
      .prepare("SELECT body FROM runs ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  get(runId: string): StoredRun | undefined {
    const r = this.db.prepare("SELECT body FROM runs WHERE id=?").get(runId);
    return r && JSON.parse(r.body as string);
  }
  byRequest(principal: string, requestId: string): StoredRun | undefined {
    const r = this.db
      .prepare("SELECT body FROM runs WHERE principal=? AND request_id=?")
      .get(principal, requestId);
    return r && JSON.parse(r.body as string);
  }
  save(run: StoredRun) {
    this.db
      .prepare(
        "INSERT INTO runs(id,principal,request_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(
        run.accepted.run_id,
        run.principal,
        run.request.request_id,
        JSON.stringify(run),
      );
  }
  checkVersion(bundle: ScriptBundle) {
    const key = `${bundle.manifest.cua_script_id}/${bundle.manifest.script_version}`;
    const old = this.db
      .prepare("SELECT fingerprint FROM versions WHERE key=?")
      .get(key);
    if (old && old.fingerprint !== bundle.fingerprint)
      throw new RunnerFault(
        "INTEGRITY_MISMATCH",
        "Published version changed",
        409,
      );
    this.db
      .prepare("INSERT OR IGNORE INTO versions(key,fingerprint) VALUES(?,?)")
      .run(key, bundle.fingerprint);
  }
  get quarantined() {
    return !!this.db
      .prepare("SELECT value FROM meta WHERE key='quarantine'")
      .get();
  }
  quarantine() {
    this.db.exec("INSERT OR REPLACE INTO meta VALUES('quarantine','1')");
  }
  /** Only after an operator has independently stopped all old CUA work. */
  acknowledgeStopped() {
    for (const run of this.all())
      if (!terminal(run.result.status) && run.result.status !== "queued")
        throw Error("Recover interrupted records before clearing quarantine");
    this.db.exec("DELETE FROM meta WHERE key='quarantine'");
  }
  recover() {
    for (const run of this.all())
      if (!terminal(run.result.status) && run.result.status !== "queued") {
        if (run.dispatched || run.sessionId) this.quarantine();
        run.result = {
          ...run.result,
          output: undefined,
          files: undefined,
          status: "interrupted",
          error: {
            code: "EXECUTION_UNKNOWN",
            message: "Runner restarted; execution was not replayed",
          },
          cleanup: run.dispatched || run.sessionId ? "failed" : "succeeded",
          finished_at: new Date().toISOString(),
        };
        this.save(run);
      }
  }
  delete(runId: string) {
    this.db.prepare("DELETE FROM runs WHERE id=?").run(runId);
  }
  close() {
    this.db.close();
    this.lock.close();
  }
}
