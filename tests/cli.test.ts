import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateConfig } from "@cua/cli";
import {
  DefaultPolicyProvider,
  ConfirmationServer,
  PendingUserChannel,
} from "@cua/service";
test("invalid profile provider and attach parameters fail without fallback", () => {
  assert.throws(
    () => validateConfig({ profiles: { bad: { provider: "typo" as any } } }),
    /Unsupported provider/,
  );
  assert.throws(
    () =>
      validateConfig({
        profiles: { bad: { provider: "local", local: { mode: "attach" } } },
      }),
    /endpoint/,
  );
});
test("approve with a valid ID refuses a noninteractive process and does not consume confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-tty-"));
  const policy = new DefaultPolicyProvider({ confirmFirstVisit: true });
  let id = "";
  await assert.rejects(
    policy.check("https://approval.test", { sessionId: "s", kind: "goto" }),
    (e: any) => {
      id = e.diagnostics.confirmationId;
      return true;
    },
  );
  const server = new ConfirmationServer({
    directory,
    instanceId: "tty-test",
    policies: () => [policy],
    status: () => [],
  });
  await server.start();
  try {
    const script = `import {confirmationCommand} from ${JSON.stringify(pathToFileURL(resolve("packages/cli/dist/index.js")).href)};try{await confirmationCommand('approve',process.argv[1],process.argv[2])}catch(error){console.error(error.message);process.exitCode=1}`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, id, directory],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += String(data)));
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    assert.match(stderr, /requires an interactive terminal/);
    assert.ok(policy.confirmation(id));
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects an unknown cloud lifecycle mode", () => {
  assert.throws(
    () =>
      validateConfig({
        profiles: {
          cloud: {
            provider: "agentbay",
            agentbay: { lifecycleMode: "typo" as any },
          },
        },
      }),
    /lifecycleMode/,
  );
});

test("cua auth and cua resume refuse a noninteractive process and leave requests pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-human-"));
  const human = new PendingUserChannel();
  const abort = new AbortController();
  const credential = human
    .collectCredentials(
      {
        id: "cred-1",
        sessionId: "s",
        origin: "https://login.test",
        fields: [{ id: "pass", label: "Password", type: "password" }],
        expiresAt: Date.now() + 60000,
      },
      abort.signal,
    )
    .catch(() => undefined);
  const handoff = human
    .handoff(
      {
        id: "hand-1",
        sessionId: "s",
        tabId: "t",
        origin: "https://login.test",
        target: { kind: "url", url: "https://live.test" },
        expiresAt: Date.now() + 60000,
      },
      abort.signal,
    )
    .catch(() => undefined);
  const server = new ConfirmationServer({
    directory,
    instanceId: "human-test",
    policies: () => [],
    status: () => [],
    human,
  });
  await server.start();
  try {
    for (const [command, id] of [
      ["auth", "cred-1"],
      ["resume", "hand-1"],
    ]) {
      const script = `import {humanCommand} from ${JSON.stringify(pathToFileURL(resolve("packages/cli/dist/index.js")).href)};try{await humanCommand(process.argv[1],process.argv[2],process.argv[3])}catch(error){console.error(error.message);process.exitCode=1}`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, command, id, directory],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (data) => (stderr += String(data)));
      const code = await new Promise((r) => child.once("exit", r));
      assert.equal(code, 1);
      assert.match(stderr, /requires an interactive terminal/);
    }
    assert.ok(human.inspect("cred-1"));
    assert.ok(human.inspect("hand-1"));
  } finally {
    abort.abort();
    await Promise.all([credential, handoff]);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI stdin EOF closes the control endpoint and journal without a termination signal", async () => {
  const { writeFile, readdir } = await import("node:fs/promises");
  // macOS tmpdir is long; keep this fixture below Unix socket path limits.
  const home = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "cua-eof-"),
  );
  const config = join(home, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      profiles: {
        sandbox: {
          provider: "sandbox",
          sandbox: { endpoint: "http://127.0.0.1:9" },
        },
      },
    }),
  );
  // No cua.connect call: this test never opens a browser or contacts the endpoint.
  const child = spawn(
    process.execPath,
    [resolve("packages/cli/dist/index.js"), "serve", "--config", config],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const directory = join(home, ".cua", "run");
    const deadline = Date.now() + 15000;
    while (true) {
      const files = await readdir(directory).catch(() => []);
      if (files.some((name) => name.endsWith(".sock"))) break;
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, "CLI startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("CLI did not close on stdin EOF")),
          10000,
        );
      }),
    ]);
    assert.equal(code, 0, stderr);
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(
      await readdir(join(home, ".cua", "state", "instances")),
      [],
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});
