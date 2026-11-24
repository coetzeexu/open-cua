import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import {
  ConfirmationServer,
  DefaultPolicyProvider,
  PendingUserChannel,
  FileJournal,
  processStart,
  listInstanceSockets,
  socketRequest,
} from "@cua/service";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "cua-cli-check-"));
const directory = join(home, ".cua", "run");
await mkdir(directory, { recursive: true });
const cli = join(root, "packages/cli/dist/index.js");
const commandEnv = { ...process.env, HOME: home, USERPROFILE: home };
const evidence = resolve(
  process.env.CUA_CLI_EVIDENCE ?? "artifacts/cli-verified",
);
await mkdir(evidence, { recursive: true });
const report = {
  time: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  checks: [],
  success: false,
};
const human = new PendingUserChannel();
const policy = new DefaultPolicyProvider({ confirmFirstVisit: true });
const server = new ConfirmationServer({
  directory,
  instanceId: "parity",
  human,
  policies: () => [policy],
  status: () => [{ sessionId: "test-status" }],
});
const abort = new AbortController();
let pending = [];
const run = async (command, id, steps, secrets = [], exitCode = 0) => {
  const spec = join(directory, "console.json");
  await writeFile(
    spec,
    JSON.stringify({
      command: process.execPath,
      args: [cli, command, id],
      steps,
      secrets,
      exitCode,
    }),
  );
  const args =
    process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "deploy/sandbox/console-driver.ps1"),
          spec,
        ]
      : [join(root, "deploy/sandbox/console-driver.py"), spec];
  const { stdout } = await exec(
    process.platform === "win32" ? "powershell.exe" : "python3",
    args,
    { timeout: 60000, windowsHide: true, env: commandEnv },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  return result;
};
const credentials = (id) => {
  const result = human
    .collectCredentials(
      {
        id,
        sessionId: "test",
        origin: "https://fixture.test",
        fields: [{ id: "password", label: "Password", type: "password" }],
        expiresAt: Date.now() + 120000,
      },
      abort.signal,
    )
    .catch(() => undefined);
  pending.push(result);
  return result;
};
const handoff = (id) => {
  const result = human
    .handoff(
      {
        id,
        sessionId: "test",
        tabId: "tab",
        origin: "https://fixture.test",
        target: { kind: "window" },
        expiresAt: Date.now() + 120000,
      },
      abort.signal,
    )
    .catch(() => undefined);
  pending.push(result);
  return result;
};
const confirmation = async () => {
  try {
    await policy.check("https://fixture.test", {
      sessionId: crypto.randomUUID(),
      kind: "goto",
    });
  } catch (e) {
    return e.diagnostics.confirmationId;
  }
  throw Error("Missing confirmation");
};
try {
  await server.start();
  assert.deepEqual(await listInstanceSockets(directory), [server.socketPath]);
  assert.equal(
    (await socketRequest(server.socketPath, { method: "status" })).sessions[0]
      .sessionId,
    "test-status",
  );
  if (process.platform === "win32") {
    const descriptor = JSON.parse(await readFile(server.socketPath, "utf8"));
    const unauthorized = await new Promise((resolve, reject) => {
      const socket = net.connect(descriptor.port, "127.0.0.1", () =>
        socket.end('{"method":"status"}\n'),
      );
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(JSON.parse(data)));
      socket.on("error", reject);
    });
    assert.equal(unauthorized.ok, false);
    const script =
      "$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath $env:CUA_ACL_PATH; if(-not $a.AreAccessRulesProtected){throw 'Inherited ACL'}; foreach($r in $a.Access){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'Other identity has access'}}; 'private'";
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, CUA_ACL_PATH: directory } },
    );
    assert.equal(stdout.trim(), "private");
    report.checks.push(
      "Windows user-only directory ACL and unauthenticated IPC rejection",
    );
  }
  const status = await exec(process.execPath, [cli, "status"], {
    env: commandEnv,
  });
  assert.equal(
    JSON.parse(status.stdout)[0].sessions[0].sessionId,
    "test-status",
  );
  report.checks.push(
    "CLI status, instance discovery and authenticated status IPC",
  );
  const secret = "synthetic-Pass-7!";
  const result = credentials("credentials-submit");
  await run(
    "auth",
    "credentials-submit",
    [
      { wait: "Continue?", text: "y\r" },
      { wait: "Password:", text: secret + "\r" },
    ],
    [secret],
  );
  assert.deepEqual(await result, {
    action: "accept",
    values: { password: secret },
  });
  report.checks.push(
    "auth reads real console, no password echo, credentials delivered only to human channel",
  );
  const decline = credentials("credentials-decline");
  await run("auth", "credentials-decline", [
    { wait: "Continue?", text: "n\r" },
  ]);
  assert.deepEqual(await decline, { action: "decline" });
  const cancel = credentials("credentials-cancel");
  await run(
    "auth",
    "credentials-cancel",
    [
      { wait: "Continue?", text: "y\r" },
      { wait: "Password:", text: "\u0003" },
    ],
    [],
    1,
  );
  assert.ok(human.inspect("credentials-cancel"));
  report.checks.push(
    "auth decline and Ctrl-C cancellation do not submit credentials",
  );
  for (const [id, text] of [
    ["handoff-resume", "\r"],
    ["handoff-cancel", "cancel\r"],
  ]) {
    const waiting = handoff(id);
    await run("resume", id, [{ wait: "Press Enter", text }]);
    assert.equal(await waiting, text === "\r" ? "resumed" : "cancelled");
    assert.equal(human.inspect(id), undefined);
  }
  report.checks.push("resume and cancel through a real console");
  const approved = await confirmation();
  await run("approve", approved, [{ wait: "Allow goto", text: "y\r" }]);
  assert.equal(policy.confirmation(approved), undefined);
  const denied = await confirmation();
  await run("deny", denied, []);
  assert.equal(policy.confirmation(denied), undefined);
  report.checks.push(
    "approve prompts in console; deny consumes the intended confirmation",
  );
  // No controlling console: the command must fail instead of consuming piped answers.
  credentials("noninteractive");
  const noninteractive = spawn(
    process.execPath,
    [cli, "auth", "noninteractive"],
    {
      detached: true,
      windowsHide: true,
      env: commandEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let error = "";
  noninteractive.stderr.on("data", (data) => (error += data));
  noninteractive.stdin.end("y\nsecret\n");
  assert.equal(
    await new Promise((resolve) => noninteractive.once("exit", resolve)),
    1,
  );
  assert.match(error, /requires an interactive terminal/);
  assert.ok(human.inspect("noninteractive"));
  report.checks.push(
    "piped answers cannot satisfy auth without a controlling terminal",
  );
  const journalDirectory = join(directory, "journal");
  const owner = new FileJournal({
    directory: journalDirectory,
    instanceId: "owner",
  });
  const recoverer = new FileJournal({
    directory: journalDirectory,
    instanceId: "recoverer",
  });
  try {
    await owner.startInstance();
    await owner.append({
      event: "intent",
      kind: "local-profile",
      key: "test",
      owned: true,
      resourceId: "synthetic",
    });
    await recoverer.startInstance();
    assert.ok(await processStart(process.pid));
    assert.equal(await processStart(-1), undefined);
    let released = 0;
    const handlers = {
      lookup: async () => ["synthetic"],
      release: async () => {
        released++;
      },
    };
    assert.deepEqual((await recoverer.recover(handlers)).recovered, []);
    await owner.close();
    assert.equal((await recoverer.recover(handlers)).recovered.length, 1);
    assert.equal(released, 1);
    await recoverer.recover(handlers);
    assert.equal(released, 1);
  } finally {
    await owner.close();
    await recoverer.close();
  }
  report.checks.push(
    "process start identity protects active journal; stopped owner is recovered once",
  );
  report.success = true;
} finally {
  abort.abort();
  await Promise.all(pending);
  await server.close();
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith(".sock")),
    false,
  );
  await rm(home, { recursive: true, force: true });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `CLI acceptance ${report.success ? "PASSED" : "FAILED"}: ${evidence}`,
  );
}
