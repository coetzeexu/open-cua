import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateDirectory, windowsScript } from "./platform.js";
import type { ResourceJournal, ResourceRecord } from "@cua/contracts";
const exec = promisify(execFile);
export async function processStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      return (
        (await windowsScript(
          "(Get-Process -Id ([int]$env:CUA_PROCESS_ID)).StartTime.ToUniversalTime().Ticks.ToString()",
          { CUA_PROCESS_ID: String(pid) },
        )) || undefined
      );
    }
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
interface Alive {
  pid: number;
  started: string;
  heartbeat: number;
}
export interface RecoveryHandlers {
  lookup(record: ResourceRecord): Promise<string[]>;
  release(record: ResourceRecord): Promise<void>;
}
export class FileJournal implements ResourceJournal {
  readonly instanceId: string;
  readonly directory: string;
  readonly path: string;
  private alivePath: string;
  private start = "";
  private heartbeat?: ReturnType<typeof setInterval>;
  private scan?: ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  private scanning = false;
  constructor(options: { directory?: string; instanceId?: string } = {}) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.directory =
      options.directory ?? join(homedir(), ".cua", "state", "instances");
    this.path = join(this.directory, `${this.instanceId}.jsonl`);
    this.alivePath = join(this.directory, `${this.instanceId}.alive`);
  }
  async startRecovery(handlers: RecoveryHandlers, scanMs = 300000) {
    await this.startInstance();
    await this.recover(handlers);
    this.scan = setInterval(() => {
      void this.recover(handlers).catch(() => {});
    }, scanMs);
    this.scan.unref();
  }
  async startInstance() {
    await privateDirectory(this.directory);
    this.start = (await processStart(process.pid)) ?? "";
    if (!this.start)
      throw Error(
        "Cannot determine process start time; refusing unsafe journal recovery.",
      );
    await this.beat();
    this.heartbeat = setInterval(() => {
      void this.beat().catch(() => {});
    }, 30000);
    this.heartbeat.unref();
  }
  private async beat() {
    const temp = `${this.alivePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({
        pid: process.pid,
        started: this.start,
        heartbeat: Date.now(),
      } satisfies Alive),
      { mode: 0o600 },
    );
    await rename(temp, this.alivePath);
  }
  append(record: ResourceRecord) {
    const task = this.queue.then(() => this.appendTo(this.path, record));
    this.queue = task.catch(() => {});
    return task;
  }
  private async appendTo(path: string, record: ResourceRecord) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(path, "a", 0o600);
    try {
      await file.write(`${JSON.stringify({ ...record, time: Date.now() })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async alive(id: string) {
    try {
      const state = JSON.parse(
        await readFile(join(this.directory, `${id}.alive`), "utf8"),
      ) as Alive;
      return (
        !!state.started && state.started === (await processStart(state.pid))
      );
    } catch {
      return false;
    }
  }
  async recover(
    handlers: RecoveryHandlers,
  ): Promise<{ recovered: string[]; failed: string[] }> {
    const result = { recovered: [] as string[], failed: [] as string[] };
    if (this.scanning) return result;
    this.scanning = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of await readdir(this.directory)) {
        const match = /^([\w-]+)(?:\.jsonl|\.recovering\.([\w-]+))$/.exec(name);
        if (!match) continue;
        const owner = match[2] ?? match[1];
        if (owner === this.instanceId && !match[2]) continue;
        if (owner !== this.instanceId && (await this.alive(owner))) continue;
        const original = join(this.directory, name);
        const claimed = join(
          this.directory,
          `${match[1]}.recovering.${this.instanceId}`,
        );
        if (original !== claimed)
          try {
            await rename(original, claimed);
          } catch {
            continue;
          }
        try {
          const content = await readFile(claimed, "utf8");
          const records = replay(content);
          if (!content.endsWith("\n"))
            await writeFile(
              claimed,
              content.slice(0, content.lastIndexOf("\n") + 1),
              { mode: 0o600 },
            );
          const keys = new Map<string, ResourceRecord>();
          for (const r of records)
            if (r.event === "intent" && r.owned) keys.set(r.key, r);
          for (const [key, intent] of keys) {
            const related = records.filter((r) => r.key === key);
            if (related.some((r) => r.event === "released" && !r.resourceId))
              continue;
            const created = related.filter(
              (r) => r.event === "created" && r.resourceId,
            );
            const ids = created.length
              ? created.map((r) => r.resourceId!)
              : await retry(() => handlers.lookup(intent));
            for (const id of ids) {
              if (
                related.some(
                  (r) => r.event === "released" && r.resourceId === id,
                )
              )
                continue;
              const record = { ...intent, resourceId: id };
              try {
                await retry(() => handlers.release(record));
                await this.appendTo(claimed, { ...record, event: "released" });
              } catch (e) {
                await this.appendTo(claimed, {
                  ...record,
                  event: "release_failed",
                });
                throw e;
              }
            }
            await this.appendTo(claimed, {
              ...intent,
              event: "released",
              resourceId: undefined,
            });
          }
          await rm(claimed);
          result.recovered.push(name);
        } catch {
          result.failed.push(
            name,
          ); /* Keep the durable progress for the next recovery owner. */
        }
      }
    } finally {
      this.scanning = false;
    }
    return result;
  }
  async close() {
    clearInterval(this.scan);
    while (this.scanning)
      await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(this.heartbeat);
    await this.queue;
    await rm(this.alivePath, { force: true });
  }
}
export function replay(text: string): ResourceRecord[] {
  const lines = text.split("\n");
  lines.pop();
  return lines
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResourceRecord);
}
export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseMs = 50,
): Promise<T> {
  let error: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      if (i + 1 < attempts)
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw error;
}
