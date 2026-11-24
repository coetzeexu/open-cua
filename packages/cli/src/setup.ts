import {
  access,
  mkdir,
  readFile,
  writeFile,
  unlink,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FileHistoryStore, storagePath } from "@cua/history";
import type { AssistMode } from "@cua/recipes";
import type { Config, ProfileConfig } from "./index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "packages/cli/dist/index.js");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

export interface SetupChoices {
  host: string;
  provider: "local" | "agentbay" | "sandbox";
  mode?: "create" | "attach";
  endpoint?: string;
  imageId?: string;
  sessionId?: string;
  headless?: boolean;
  apps: boolean;
  history: boolean;
  captureOnFailure?: boolean;
  distill: AssistMode;
  repair: AssistMode;
  serverName?: string;
  /** Host-discovered skills parent directory. Never assume a Codex path. */
  skillDirectory?: string;
}

function checkChoices(c: SetupChoices) {
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw Error("Setup choices must be an object.");
  const keys = new Set([
    "host",
    "provider",
    "mode",
    "endpoint",
    "imageId",
    "sessionId",
    "headless",
    "apps",
    "history",
    "captureOnFailure",
    "distill",
    "repair",
    "serverName",
    "skillDirectory",
  ]);
  for (const key of Object.keys(c))
    if (!keys.has(key)) throw Error(`Unknown setup choice: ${key}`);
  if (typeof c.host !== "string" || !c.host.trim())
    throw Error("host is required.");
  if (!["local", "agentbay", "sandbox"].includes(c.provider))
    throw Error("Invalid provider.");
  for (const key of ["apps", "history"] as const)
    if (typeof c[key] !== "boolean")
      throw Error(`${key} must be explicitly selected.`);
  for (const key of ["headless", "captureOnFailure"] as const)
    if (c[key] !== undefined && typeof c[key] !== "boolean")
      throw Error(`${key} must be boolean.`);
  for (const key of ["distill", "repair"] as const)
    if (!["disabled", "manual", "auto"].includes(c[key]))
      throw Error(`${key} mode is required.`);
  for (const key of [
    "endpoint",
    "imageId",
    "sessionId",
    "skillDirectory",
  ] as const)
    if (c[key] !== undefined && (typeof c[key] !== "string" || !c[key]!.trim()))
      throw Error(`Invalid ${key}.`);
  if (
    c.serverName !== undefined &&
    (typeof c.serverName !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.serverName))
  )
    throw Error("Invalid serverName.");
  if (c.mode !== undefined && !["create", "attach"].includes(c.mode))
    throw Error("Invalid mode.");
  if (
    !c.history &&
    (c.distill !== "disabled" || c.repair !== "disabled" || c.captureOnFailure)
  )
    throw Error(
      "With history disabled, disable distill, repair and failure capture too.",
    );
  if (c.provider !== "agentbay" && (c.imageId || c.sessionId))
    throw Error("imageId/sessionId require AgentBay.");
  if (c.provider === "agentbay") {
    if (c.endpoint || c.headless !== undefined)
      throw Error("AgentBay does not use endpoint/headless choices.");
    if (
      (c.mode ?? "create") === "create"
        ? !c.imageId || !!c.sessionId
        : !c.sessionId || !!c.imageId
    )
      throw Error(
        "AgentBay create requires imageId; attach requires sessionId. Choose only one.",
      );
  }
  if (
    c.provider === "sandbox" &&
    (c.mode === "create" || c.headless !== undefined)
  )
    throw Error("Sandbox attaches to an existing browser; omit mode/headless.");
  if (c.provider === "local") {
    if ((c.mode ?? "create") === "attach" && !c.endpoint)
      throw Error("Local attach requires endpoint.");
    if ((c.mode ?? "create") === "create" && c.endpoint)
      throw Error("Local create does not use endpoint.");
    if ((c.mode ?? "create") === "attach" && c.headless !== undefined)
      throw Error("Local attach does not control headless mode.");
  }
  if (c.endpoint) {
    const url = new URL(c.endpoint);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error(
        "Setup endpoint must be a CDP URL without credentials, query or fragment.",
      );
  }
}

export function requiredEnvironment(config: Config): string[] {
  const names = new Set<string>();
  for (const p of Object.values(config.profiles)) {
    if (p.provider === "agentbay") names.add("AGENTBAY_API_KEY");
    if (p.provider === "sandbox" && !p.sandbox?.endpoint)
      names.add(p.sandbox?.endpointEnv ?? "CUA_BROWSER_CDP_URL");
  }
  return [...names];
}

/** Generate portable artifacts; the agent registers them with the selected host. */
export async function setup(
  choices: SetupChoices,
  directory: string,
  validate: (config: Config) => Config,
) {
  checkChoices(choices);
  const target = storagePath(directory);
  const name = choices.serverName ?? "cua";
  const profileName = choices.provider;
  const mode = choices.mode ?? "create";
  let profile: ProfileConfig;
  if (choices.provider === "local")
    profile = {
      provider: "local",
      local:
        mode === "attach"
          ? { mode, endpoint: choices.endpoint }
          : { mode, channel: "chrome", headless: choices.headless ?? false },
    };
  else if (choices.provider === "agentbay")
    profile = {
      provider: "agentbay",
      agentbay:
        mode === "attach"
          ? { mode, sessionId: choices.sessionId }
          : {
              mode,
              imageId: choices.imageId,
              lifecycleMode: "managed",
              idleReleaseTimeout: 10,
              maxRuntime: 240,
              keepAliveMs: 180000,
            },
    };
  else
    profile = {
      provider: "sandbox",
      sandbox: choices.endpoint
        ? { endpoint: choices.endpoint }
        : { endpointEnv: "CUA_BROWSER_CDP_URL" },
    };
  const config = validate({
    defaultProfile: profileName,
    profiles: { [profileName]: profile },
    history: {
      enabled: choices.history,
      directory: join(target, "history"),
      captureOnFailure: choices.captureOnFailure ?? false,
      upload: { enabled: false },
    },
    recipes: {
      directory: join(target, "recipes"),
      distill: { mode: choices.distill },
      repair: { mode: choices.repair },
    },
    service: {
      executeWaitMs: 20000,
      cellTimeoutMs: 60000,
      imageOutput: "inline",
    },
  });
  const configPath = join(target, "cua.json");
  const launch = {
    command: process.execPath,
    args: [cli, "serve", "--config", configPath],
    cwd: root,
    env: { CUA_MCP_APPS: choices.apps ? "1" : "0" },
  };
  const skillSource = join(root, "skills/cua-recipes/SKILL.md");
  const skillText = await readFile(skillSource, "utf8");
  const installation = json({
    host: choices.host,
    config: configPath,
    cli: [process.execPath, cli],
    profile: profileName,
  });
  const context = `# CUA installation\n\nHost: ${JSON.stringify(choices.host)}. MCP server: ${name}.\n\nRead installation.json for the CLI executable, config and profile. Always pass that --config to history/recipe commands; do not silently use global defaults.\n\nUse the mounted server's cua_session_create, cua_exec, cua_poll and cua_close for browser work. Read returned API guidance before operating. Confirm business success from evidence before history complete. For distillation or repair, read recipe-guide/SKILL.md and use the current agent model; ordinary Runner execution needs no model. Never automatically replay unknown actions.\n\nGenerated files do not prove host registration. Verify tools from the selected host after registration/reload. Without browser authorization, run only output.text(\"CUA ready\") and close the session; browser capability remains untested until the first authorized browser task.\n`;
  const files = new Map<string, string>([
    [configPath, json(config)],
    [join(target, "choices.json"), json(choices)],
    [join(target, "mcp.json"), json({ mcpServers: { [name]: launch } })],
    [
      join(target, "launch.json"),
      json({ ...launch, requiredEnvironment: requiredEnvironment(config) }),
    ],
    [join(target, "installation.json"), installation],
    [join(target, "agent-context.md"), context],
    [join(target, "recipe-guide/SKILL.md"), skillText],
    [join(target, "recipe-guide/installation.json"), installation],
  ]);
  if (choices.skillDirectory) {
    const skillTarget = join(
      storagePath(choices.skillDirectory),
      "cua-recipes",
    );
    // Do not follow an existing skill symlink into another checkout.
    if ((await lstat(skillTarget).catch(() => undefined))?.isSymbolicLink())
      throw Error(
        "Skill target is a symlink. Reuse it explicitly or select another skill directory; setup will not overwrite it.",
      );
    files.set(join(skillTarget, "SKILL.md"), skillText);
    files.set(join(skillTarget, "installation.json"), installation);
  }
  const pending: [string, string][] = [];
  for (const [path, contents] of files) {
    const stat = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (stat?.isSymbolicLink())
      throw Error(`Refusing to overwrite symlink: ${path}`);
    if (stat) {
      const previous = await readFile(path, "utf8");
      let same = previous === contents;
      if (!same && path.endsWith(".json")) {
        try {
          same = isDeepStrictEqual(JSON.parse(previous), JSON.parse(contents));
        } catch {}
      }
      if (!same)
        throw Error(
          `Existing file differs; preserve it and choose another directory or explicitly reconcile it: ${path}`,
        );
    } else pending.push([path, contents]);
  }
  for (const [path, contents] of pending) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  }
  return {
    status: "configuration_generated",
    directory: target,
    config: configPath,
    written: pending.map(([path]) => path),
    requiredEnvironment: requiredEnvironment(config),
    next: [
      "Register the MCP entry in the chosen host, preserving existing servers.",
      "Load agent-context.md in the host's persistent project instructions or skill mechanism.",
      "Run doctor, then verify the mounted tools from that host. Configuration generation alone is not host readiness.",
    ],
    limitations: [
      ...(!choices.apps
        ? [
            "MCP Apps disabled: use supported terminal/manual channels for human input.",
          ]
        : [
            "MCP Apps requires a host UI and private routes; setting this flag does not implement them.",
          ]),
      ...(choices.provider !== "local"
        ? [
            "Recipe activation currently requires a successful local-browser validation; remote-only setup does not complete the Recipe lifecycle.",
          ]
        : []),
      ...(choices.distill === "auto" || choices.repair === "auto"
        ? [
            "Auto creates model_required requests; the host must handle them with its current model. No automatic agent wake-up.",
          ]
        : []),
    ],
  };
}

async function writableDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const probe = join(path, `.cua-doctor-${randomUUID()}`);
  await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  await unlink(probe);
}

export async function doctor(
  config: Config,
  configPath: string,
  probe: boolean,
  apps: boolean,
) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await check("node", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major !== 24 || minor < 18) throw Error("Use Node >=24.18.0 <25.");
    return process.versions.node;
  });
  await check("build", async () => {
    await access(cli, constants.R_OK);
    return cli;
  });
  await check("environment", async () => {
    const missing = requiredEnvironment(config).filter(
      (name) => !process.env[name],
    );
    if (missing.length)
      throw Error(
        `Set these variables in the service host environment: ${missing.join(", ")}`,
      );
    return "Required environment variable names are present; values were not printed.";
  });
  await check("storage", async () => {
    const store = new FileHistoryStore(config.history);
    if (store.enabled) await writableDirectory(store.directory);
    await writableDirectory(
      storagePath(config.recipes?.directory ?? "~/.cua/recipes"),
    );
    return "History/recipe directories are writable (history omitted if disabled).";
  });
  if (probe && checks.every((c) => c.ok))
    await check("mcp-repl", async () => {
      const client = new Client({ name: "cua-doctor", version: "1.0.0" }, {
        capabilities: apps
          ? {
              extensions: {
                "io.modelcontextprotocol/ui": {
                  mimeTypes: ["text/html;profile=mcp-app"],
                },
              },
            }
          : {},
      } as any);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--config", storagePath(configPath)],
        cwd: root,
        env: { ...env, CUA_MCP_APPS: apps ? "1" : "0" },
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {});
      let sessionId: string | undefined;
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: 15000 },
        );
        if (result.isError || !result.structuredContent)
          throw Error(`${name} failed; inspect service configuration.`);
        return result.structuredContent as Record<string, any>;
      };
      try {
        await client.connect(transport, { timeout: 15000 });
        const names = new Set(
          (await client.listTools()).tools.map((t) => t.name),
        );
        for (const name of [
          "cua_session_create",
          "cua_exec",
          "cua_poll",
          "cua_close",
          ...(apps ? ["cua_view", "cua_login", "cua_secure_form"] : []),
        ])
          if (!names.has(name)) throw Error(`MCP tool missing: ${name}`);
        if (apps)
          for (const uri of [
            "ui://cua/browser.html",
            "ui://cua/login.html",
            "ui://cua/secure-form.html",
          ]) {
            const resource = await client.readResource({ uri });
            if (
              !resource.contents.some(
                (r) => r.mimeType === "text/html;profile=mcp-app",
              )
            )
              throw Error(`MCP Apps resource missing: ${uri}`);
          }
        const session = await call("cua_session_create", {
          profile: config.defaultProfile ?? Object.keys(config.profiles)[0],
          goal: "CUA setup REPL check; no browser connection",
        });
        sessionId = session.sessionId;
        let result = await call("cua_exec", {
          sessionId,
          requestId: randomUUID(),
          code: 'output.text("CUA ready");',
        });
        const output = [...(result.output ?? [])];
        const deadline = Date.now() + 20000;
        while (result.status === "running" && Date.now() < deadline) {
          result = await call("cua_poll", {
            sessionId,
            executionId: result.executionId,
            cursor: result.cursor,
            waitMs: 1000,
          });
          output.push(...(result.output ?? []));
        }
        if (
          result.status !== "succeeded" ||
          !output.some((o) => o.text === "CUA ready")
        )
          throw Error("MCP REPL check did not complete successfully.");
        await call("cua_close", { sessionId });
        sessionId = undefined;
        const history = new FileHistoryStore(config.history);
        if (
          history.enabled &&
          !history
            .read(session.runId)
            .events.some((e) => e.type === "execution.finished")
        )
          throw Error("MCP execution history was not persisted.");
        return `MCP tools and REPL passed; runId=${session.runId}. Browser not connected.`;
      } finally {
        if (sessionId)
          await call("cua_close", { sessionId }).catch(() => undefined);
        await client.close();
        await transport.close();
      }
    });
  return {
    ok: checks.every((c) => c.ok),
    scope: probe ? "standalone-mcp" : "configuration",
    hostRegistration: "not_checked",
    browser: "not_tested",
    checks,
  };
}

export async function setupCommand(
  command: "setup" | "doctor",
  args: string[],
  load: (path?: string) => Promise<Config>,
  validate: (config: Config) => Config,
) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed =
    command === "setup" ? ["--answers", "--directory"] : ["--config", "--apps"];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (command === "doctor" && key === "--mcp" && !flags.has(key)) {
      flags.add(key);
      continue;
    }
    if (
      !allowed.includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error(`Invalid ${command} argument: ${key}`);
    values.set(key, args[++i]);
  }
  if (command === "setup") {
    if (!values.has("--answers") || !values.has("--directory"))
      throw Error(
        "Usage: cua setup --answers choices.json --directory <installation-directory>",
      );
    console.log(
      json(
        await setup(
          JSON.parse(
            await readFile(storagePath(values.get("--answers")!), "utf8"),
          ),
          values.get("--directory")!,
          validate,
        ),
      ),
    );
  } else {
    if (
      !values.has("--config") ||
      (values.has("--apps") && !["on", "off"].includes(values.get("--apps")!))
    )
      throw Error(
        "Usage: cua doctor --config cua.json [--mcp] [--apps on|off]",
      );
    const path = storagePath(values.get("--config")!);
    const result = await doctor(
      await load(path),
      path,
      flags.has("--mcp"),
      values.get("--apps") === "on",
    );
    console.log(json(result));
    if (!result.ok) process.exitCode = 1;
  }
}
