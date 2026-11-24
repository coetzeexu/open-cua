import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ParentMessage, WorkerMessage } from "@cua/contracts";
export interface WorkerHandle {
  process: ChildProcess;
  ready: Promise<void>;
  send(message: ParentMessage): void;
  kill(): Promise<void>;
}
export function launchWorker(options: {
  cwd: string;
  onMessage: (message: WorkerMessage) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}): WorkerHandle {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = fork(
    fileURLToPath(new URL("./worker.js", import.meta.url)),
    [],
    {
      cwd: options.cwd,
      env,
      execArgv: ["--experimental-vm-modules"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    },
  );
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(() => {
    readyReject(Error("Worker ping timed out"));
    child.kill("SIGKILL");
  }, 2000);
  child.on("message", (message: WorkerMessage) => {
    if (message.type === "ready") {
      clearTimeout(timer);
      readyResolve();
    } else options.onMessage(message);
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    readyReject(e);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    readyReject(Error("Worker exited before readiness"));
    options.onExit(code, signal);
  });
  child.stderr?.on("data", () => {
    /* Never forward arbitrary worker diagnostics to the stdio protocol. */
  });
  return {
    process: child,
    ready,
    send(message) {
      if (child.connected) child.send(message);
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    },
  };
}
