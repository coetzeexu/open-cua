import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { validateConfig } from "@cua/cli";
import { FileHistoryStore } from "@cua/history";
import {
  setup,
  requiredEnvironment,
  type SetupChoices,
} from "../packages/cli/src/setup.js";

const exec = promisify(execFile);
const cli = resolve("packages/cli/dist/index.js");
const choices: SetupChoices = {
  host: "generic-agent",
  provider: "local",
  apps: false,
  history: true,
  captureOnFailure: true,
  distill: "manual",
  repair: "manual",
};
const readJSON = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
async function temporary(t: any) {
  // Keep service Unix socket paths short.
  const dir = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "cua-setup-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("setup generates portable config and explicit skill binding, is idempotent and preserves unrelated files", async (t) => {
  const dir = await temporary(t);
  const target = join(dir, "install with spaces");
  const skillDirectory = join(dir, "qoder-skills");
  const input = { ...choices, host: "qoder", skillDirectory };
  await mkdir(target);
  await writeFile(join(target, "choices.json"), JSON.stringify(input));
  await writeFile(join(target, "unrelated.txt"), "keep");
  const first = await setup(input, target, validateConfig);
  assert.equal(first.status, "configuration_generated");
  const config = await readJSON(first.config);
  assert.equal(config.profiles.local.local.headless, false);
  assert.equal(config.history.upload.enabled, false);
  assert.equal(config.history.directory, join(target, "history"));
  const launch = await readJSON(join(target, "launch.json"));
  assert.ok(isAbsolute(launch.command));
  assert.deepEqual(launch.args, [cli, "serve", "--config", first.config]);
  assert.equal(launch.env.CUA_MCP_APPS, "0");
  const mcp = await readJSON(join(target, "mcp.json"));
  assert.equal(mcp.mcpServers.cua.command, process.execPath);
  assert.equal(
    (await readJSON(join(skillDirectory, "cua-recipes/installation.json")))
      .config,
    first.config,
  );
  assert.equal(
    await readFile(join(skillDirectory, "cua-recipes/SKILL.md"), "utf8"),
    await readFile(join(target, "recipe-guide/SKILL.md"), "utf8"),
  );
  assert.deepEqual((await setup(input, target, validateConfig)).written, []);
  assert.equal(await readFile(join(target, "unrelated.txt"), "utf8"), "keep");
  assert.equal((await readdir(dir)).includes(".codex"), false);
});

test("setup detects conflicts before writing, including an existing Skill symlink", async (t) => {
  const dir = await temporary(t);
  const target = join(dir, "existing");
  await mkdir(target);
  await writeFile(join(target, "mcp.json"), '{"mcpServers":{"other":{}}}');
  await assert.rejects(
    setup(choices, target, validateConfig),
    /Existing file differs/,
  );
  assert.deepEqual(await readdir(target), ["mcp.json"]);
  const skillRoot = join(dir, "skills");
  await mkdir(skillRoot);
  await symlink(
    target,
    join(skillRoot, "cua-recipes"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    setup(
      { ...choices, skillDirectory: skillRoot },
      join(dir, "fresh"),
      validateConfig,
    ),
    /symlink/,
  );
  assert.equal(
    await readFile(join(target, "mcp.json"), "utf8"),
    '{"mcpServers":{"other":{}}}',
  );
});

test("setup validates dependent choices and refuses unsupported or secret-bearing input before writes", async (t) => {
  const dir = await temporary(t);
  const invalid = [
    { ...choices, history: false },
    { ...choices, apps: "yes" },
    { ...choices, repair: "automatic" },
    { ...choices, skillDirectory: "" },
    { ...choices, serverName: true },
    { ...choices, apiKey: "do-not-store" },
    { ...choices, mode: "attach" },
    {
      ...choices,
      mode: "attach",
      endpoint: "https://user:password@localhost:9222",
    },
    { ...choices, provider: "agentbay", mode: "create" },
    { ...choices, provider: "sandbox", mode: "create" },
  ];
  for (const input of invalid)
    await assert.rejects(
      setup(input as SetupChoices, join(dir, "never"), validateConfig),
    );
  assert.deepEqual(await readdir(dir), []);
});

test("setup maps remote providers to runtime config without embedding environment credentials", async (t) => {
  const dir = await temporary(t);
  const cloud = await setup(
    {
      ...choices,
      host: "dsh",
      provider: "agentbay",
      mode: "attach",
      sessionId: "existing-session",
    },
    join(dir, "cloud"),
    validateConfig,
  );
  const config = await readJSON(cloud.config);
  assert.deepEqual(config.profiles.agentbay.agentbay, {
    mode: "attach",
    sessionId: "existing-session",
  });
  assert.deepEqual(requiredEnvironment(config), ["AGENTBAY_API_KEY"]);
  assert.deepEqual(
    Object.keys((await readJSON(join(dir, "cloud/launch.json"))).env),
    ["CUA_MCP_APPS"],
  );
  const sandbox = await setup(
    { ...choices, provider: "sandbox" },
    join(dir, "sandbox"),
    validateConfig,
  );
  assert.deepEqual(requiredEnvironment(await readJSON(sandbox.config)), [
    "CUA_BROWSER_CDP_URL",
  ]);
  assert.ok(sandbox.limitations.some((text) => text.includes("local-browser")));
  const off = await setup(
    {
      ...choices,
      history: false,
      captureOnFailure: false,
      distill: "disabled",
      repair: "disabled",
    },
    join(dir, "off"),
    validateConfig,
  );
  assert.equal((await readJSON(off.config)).history.enabled, false);
});

test(
  "CLI doctor exercises actual MCP, Apps resources, REPL and persisted history without connecting a browser",
  { timeout: 60000 },
  async (t) => {
    const dir = await temporary(t);
    const input = join(dir, "answers.json");
    await writeFile(
      input,
      JSON.stringify({
        ...choices,
        provider: "local",
        mode: "attach",
        endpoint: "http://127.0.0.1:9",
        apps: true,
      }),
    );
    const env = { ...process.env, HOME: dir, USERPROFILE: dir };
    const generated = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            cli,
            "setup",
            "--answers",
            input,
            "--directory",
            join(dir, "installation"),
          ],
          { env },
        )
      ).stdout,
    );
    const command = await exec(
      process.execPath,
      [cli, "doctor", "--config", generated.config, "--mcp", "--apps", "on"],
      { env, timeout: 45000 },
    );
    const result = JSON.parse(command.stdout);
    assert.equal(result.ok, true, command.stdout);
    assert.equal(result.scope, "standalone-mcp");
    assert.equal(result.hostRegistration, "not_checked");
    assert.equal(result.browser, "not_tested");
    assert.ok(result.checks.some((c: any) => c.name === "mcp-repl" && c.ok));
    const config = await readJSON(generated.config);
    const history = new FileHistoryStore(config.history);
    const runs = history.list();
    assert.equal(runs.length, 1);
    const run = history.read(runs[0].runId);
    assert.ok(run.events.some((e) => e.type === "session.closed"));
    const executions = run.events.filter(
      (e) => e.type === "execution.finished",
    );
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0].data.operations, []);
    assert.equal(run.businessSuccess, false);
  },
);

test("doctor reports missing service environment, fails nonzero and does not start MCP", async (t) => {
  const dir = await temporary(t);
  const generated = await setup(
    { ...choices, provider: "agentbay", imageId: "browser-image" },
    join(dir, "install"),
    validateConfig,
  );
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    AGENTBAY_API_KEY: "",
  };
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "doctor", "--config", generated.config, "--mcp"],
      { env },
    ),
    (error: any) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.some(
          (c: any) =>
            c.name === "environment" &&
            !c.ok &&
            c.detail.includes("AGENTBAY_API_KEY"),
        ),
      );
      assert.equal(
        result.checks.some((c: any) => c.name === "mcp-repl"),
        false,
      );
      return true;
    },
  );
  const history = new FileHistoryStore(
    (await readJSON(generated.config)).history,
  );
  assert.deepEqual(history.list(), []);
});

test("CLI rejects misspelled setup/doctor options without changing files", async (t) => {
  const dir = await temporary(t);
  for (const args of [
    ["setup", "--directory", dir, "--answer", "x"],
    ["doctor", "--config", "x", "--apps", "yes"],
    ["doctor", "--mcp", "--mcp"],
  ])
    await assert.rejects(
      exec(process.execPath, [cli, ...args]),
      (error: any) => error.code === 1,
    );
  assert.deepEqual(await readdir(dir), []);
});
