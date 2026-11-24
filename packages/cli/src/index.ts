#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateHistoryConfig, type HistoryConfig } from "@cua/history";
import { validateRecipesConfig, type RecipesConfig } from "@cua/recipes";
import { workflowCommand } from "./workflows.js";
import { setupCommand } from "./setup.js";
import { openTerminal } from "./terminal.js";
import { dashboardCommand } from "./dashboard.js";
import { runnerCommand } from "./runner.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUAService,
  FileJournal,
  ConfirmationServer,
  listInstanceSockets,
  socketRequest,
} from "@cua/service";
import {
  serveStdio,
  startHttpGateway,
  type HttpGatewayOptions,
} from "@cua/mcp";
import {
  LocalBrowserProvider,
  releaseLocalProfile,
  type LocalBrowserOptions,
} from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
import {
  AgentBayBrowserProvider,
  type AgentBayOptions,
} from "@cua/browser-agentbay";
import {
  DefaultPolicyProvider,
  PendingUserChannel,
  type PolicyConfig,
  type CUAOptions,
} from "@cua/service";
import {
  SandboxBrowserProvider,
  validateSandboxOptions,
  type SandboxBrowserOptions,
} from "@cua/browser-sandbox";
export interface ProfileConfig {
  provider: "local" | "agentbay" | "sandbox";
  sandbox?: SandboxBrowserOptions;
  local?: LocalBrowserOptions;
  agentbay?: Omit<AgentBayOptions, "client" | "connect" | "journal" | "apiKey">;
  policy?: PolicyConfig;
  credentials?: { mode?: "require" | "allow"; requestTtlMs?: number };
}
export interface Config {
  history?: HistoryConfig;
  recipes?: RecipesConfig;
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
  service?: {
    executeWaitMs?: number;
    cellTimeoutMs?: number;
    idleMs?: number;
    imageOutput?: "inline" | "file";
  };
}
export async function loadConfig(path?: string): Promise<Config> {
  if (path) return validateConfig(JSON.parse(await readFile(path, "utf8")));
  return {
    defaultProfile: "local",
    profiles: {
      local: {
        provider: "local",
        local: { channel: "chrome", headless: true },
      },
    },
  };
}
export function validateConfig(config: Config): Config {
  if (
    !config ||
    typeof config !== "object" ||
    !config.profiles ||
    !Object.keys(config.profiles).length
  )
    throw Error("At least one browser profile is required.");
  if (config.defaultProfile && !(config.defaultProfile in config.profiles))
    throw Error("defaultProfile must name a configured profile.");
  validateHistoryConfig(config.history);
  validateRecipesConfig(config.recipes);
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!["local", "agentbay", "sandbox"].includes(profile.provider))
      throw Error(`Unsupported provider in profile ${name}.`);
    if (
      profile.agentbay?.lifecycleMode &&
      !["managed", "server-default"].includes(profile.agentbay.lifecycleMode)
    )
      throw Error(`Invalid AgentBay lifecycleMode in profile ${name}.`);
    if (
      profile.credentials?.mode &&
      !["require", "allow"].includes(profile.credentials.mode)
    )
      throw Error(`Invalid credentials.mode in profile ${name}.`);
    if (profile.provider === "sandbox") validateSandboxOptions(profile.sandbox);
    const connection =
      profile.provider === "local" ? profile.local : profile.agentbay;
    if (connection?.mode && !["create", "attach"].includes(connection.mode))
      throw Error(`Invalid browser mode in profile ${name}.`);
    if (
      profile.provider === "local" &&
      profile.local?.mode === "attach" &&
      !profile.local.endpoint
    )
      throw Error(`Attach profile ${name} requires an endpoint.`);
    if (
      profile.provider === "agentbay" &&
      profile.agentbay?.mode === "attach" &&
      !profile.agentbay.sessionId
    )
      throw Error(`Attach profile ${name} requires a sessionId.`);
  }
  return config;
}
export async function createRuntime(config: Config) {
  validateConfig(config);
  const journal = new FileJournal();
  const human = new PendingUserChannel();
  const policies: DefaultPolicyProvider[] = [];
  const localProviders: LocalBrowserProvider[] = [];
  let cloudRecovery: AgentBayBrowserProvider | undefined;
  const profiles: Record<string, () => CUAOptions> = {};
  for (const [name, profile] of Object.entries(config.profiles))
    profiles[name] = () => {
      const policy = new DefaultPolicyProvider(profile.policy);
      policies.push(policy);
      const browser =
        profile.provider === "agentbay"
          ? new AgentBayBrowserProvider({
              ...profile.agentbay,
              apiKey: process.env.AGENTBAY_API_KEY,
              journal,
              instanceId: journal.instanceId,
            })
          : profile.provider === "sandbox"
            ? new SandboxBrowserProvider(profile.sandbox)
            : new LocalBrowserProvider({ ...profile.local, journal });
      if (browser instanceof LocalBrowserProvider) localProviders.push(browser);
      if (browser instanceof AgentBayBrowserProvider) cloudRecovery = browser;
      return {
        browser,
        capabilities: chromiumCapabilities(),
        targetResolvers: [new ChromiumTargetResolver()],
        policy,
        credentials: profile.credentials,
      };
    };
  if (Object.values(config.profiles).some((p) => p.provider === "agentbay"))
    cloudRecovery = new AgentBayBrowserProvider({
      apiKey: process.env.AGENTBAY_API_KEY,
    });
  await journal.startRecovery({
    lookup: async (record) => {
      if (record.kind === "local-profile" && record.resourceId)
        return [record.resourceId];
      if (record.kind === "agentbay" && cloudRecovery)
        return cloudRecovery.lookup(record.labels ?? {});
      throw Error("No recovery provider for recorded resource.");
    },
    release: async (record) => {
      if (record.kind === "local-profile")
        return releaseLocalProfile(record.resourceId!);
      if (record.kind === "agentbay" && cloudRecovery)
        return cloudRecovery.release(record.resourceId!);
      throw Error("No recovery provider for recorded resource.");
    },
  });
  const service = new CUAService({
    profiles,
    history: config.history,
    defaultProfile: config.defaultProfile,
    ...config.service,
    userChannel: human,
    secureFormProtectionDirectory: join(
      journal.directory,
      "..",
      "secure-form-protection",
    ),
  });
  const confirmations = new ConfirmationServer({
    instanceId: journal.instanceId,
    policies: () => policies,
    status: () => service.status(),
    releaseSession: (input) => service.releaseSession(input),
    human,
  });
  await confirmations.start();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await service.close();
      await Promise.all(localProviders.map((provider) => provider.shutdown()));
      await confirmations.close();
      await journal.close();
    })());
  return { service, close };
}
export async function start(config: Config) {
  const runtime = await createRuntime(config);
  let connection;
  try {
    connection = await serveStdio(runtime.service, {
      apps: process.env.CUA_MCP_APPS === "1",
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const { server, adapter } = connection;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      process.stdin.off("end", onInputEnd);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await connection!.close();
      await runtime.close();
      await server.close();
    })());
  const onInputEnd = () => {
    void close();
  };
  const onSignal = () => {
    void close();
  };
  process.stdin.once("end", onInputEnd);
  server.onclose = onInputEnd;
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { service: runtime.service, close };
}
/** HTTP keeps the process alive independently of stdin and preserves CLI human channels. */
export async function startHttp(config: Config, options: HttpGatewayOptions) {
  const runtime = await createRuntime(config);
  let gateway;
  try {
    gateway = await startHttpGateway(runtime.service, options);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await gateway.close();
      await runtime.close();
    })());
  const onSignal = () => {
    void close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { service: runtime.service, server: gateway.server, close };
}

async function findRequest(id: string, directory?: string) {
  for (const path of await listInstanceSockets(directory)) {
    try {
      const result = await socketRequest(path, { method: "inspect", id });
      if (result.ok) return { path, result };
    } catch {}
  }
  throw Error(
    "Request ID expired, was already used, or its service is unavailable.",
  );
}
export async function humanCommand(
  command: "auth" | "resume",
  id: string,
  directory?: string,
) {
  const { path, result } = await findRequest(id, directory);
  const view = result.human as
    | {
        type: "credentials";
        origin: string;
        fields: { id: string; label: string; type: string }[];
      }
    | {
        type: "handoff";
        origin: string;
        reason?: string;
        kind: string;
        url?: string;
      }
    | undefined;
  if (!view || view.type !== (command === "auth" ? "credentials" : "handoff"))
    throw Error(
      `${id} is not a ${command === "auth" ? "sign-in" : "handoff"} request.`,
    );
  const tty = openTerminal();
  try {
    if (view.type === "credentials") {
      const proceed = await tty.prompt(
        `Sign in to ${view.origin}. The agent will not see these values. Continue? [y/N] `,
        false,
      );
      if (proceed.trim().toLowerCase() !== "y") {
        await socketRequest(path, { method: "deny", id });
        return { decision: "declined", id };
      }
      const values: Record<string, string> = {};
      for (const field of view.fields)
        values[field.id] = await tty.prompt(`${field.label}: `, true);
      const sent = await socketRequest(path, {
        method: "credentials",
        id,
        values,
      });
      if (!sent.ok)
        throw Error("The sign-in request expired or the page changed.");
      return { decision: "submitted", id };
    }
    const where =
      view.kind === "url"
        ? `Open this live view: ${view.url}`
        : view.kind === "window"
          ? "Use the browser window that was brought to the front."
          : "Use the tab in your own browser.";
    const answer = await tty.prompt(
      `Take over ${view.origin}${view.reason ? ` (${view.reason})` : ""}.\n${where}\nPress Enter when you are done, or type "cancel": `,
      false,
    );
    const method = answer.trim().toLowerCase() === "cancel" ? "deny" : "resume";
    const sent = await socketRequest(path, { method, id });
    if (!sent.ok) throw Error("The handoff expired before it was resumed.");
    return { decision: method === "deny" ? "cancelled" : "resumed", id };
  } finally {
    tty.close();
  }
}
export async function confirmationCommand(
  command: "approve" | "deny",
  id: string,
  directory?: string,
) {
  let found:
    | { path: string; confirmation: { origin: string; kind: string } }
    | undefined;
  for (const path of await listInstanceSockets(directory)) {
    try {
      const result = await socketRequest(path, { method: "inspect", id });
      if (result.ok && result.confirmation) {
        found = { path, confirmation: result.confirmation };
        break;
      }
    } catch {}
  }
  if (!found)
    throw Error(
      "Confirmation ID expired, was already used, or its service is unavailable.",
    );
  if (command === "approve") {
    const tty = openTerminal();
    try {
      const answer = await tty.prompt(
        `Allow ${found.confirmation.kind} on ${found.confirmation.origin}? [y/N] `,
      );
      if (answer.trim().toLowerCase() !== "y") command = "deny";
    } finally {
      tty.close();
    }
  }
  const result = await socketRequest(found.path, { method: command, id });
  if (!result.ok)
    throw Error(
      "Confirmation expired or was used before the decision arrived.",
    );
  return { decision: command, id };
}
export async function sessionCloseCommand(
  id: string,
  force = false,
  directory?: string,
) {
  for (const path of await listInstanceSockets(directory)) {
    let status;
    try {
      status = await socketRequest(path, { method: "status" });
    } catch {
      continue;
    }
    if (
      !status.ok ||
      !status.sessions?.some((s: { sessionId: string }) => s.sessionId === id)
    )
      continue;
    const response = await socketRequest(
      path,
      { method: "session-close", id, force },
      60000,
    );
    if (!response.ok) throw Error(response.error ?? "Session release failed");
    if (!response.result?.closed)
      throw Error(
        "Session cleanup incomplete; lease remains held. Retry session-close after checking the provider.",
      );
    return response.result;
  }
  throw Error(
    "Session not found on this host; run cua status on the host running the CUA service.",
  );
}
export async function main(args = process.argv.slice(2)) {
  const [command = "help", ...rest] = args;
  if (command === "setup" || command === "doctor") {
    await setupCommand(command, rest, loadConfig, validateConfig);
  } else if (command === "history" || command === "recipe") {
    await workflowCommand(command, rest, loadConfig, createRuntime);
  } else if (command === "runner") {
    await runnerCommand(rest);
  } else if (command === "dashboard") {
    await dashboardCommand(rest, loadConfig, createRuntime);
  } else if (command === "serve") {
    const index = rest.indexOf("--config");
    await start(await loadConfig(index < 0 ? undefined : rest[index + 1]));
  } else if (command === "serve-http") {
    const index = rest.indexOf("--config");
    await startHttp(
      await loadConfig(index < 0 ? undefined : rest[index + 1]),
      httpOptionsFromEnv(),
    );
    console.error("CUA HTTP MCP ready (authenticated /mcp).");
  } else if (command === "approve" || command === "deny") {
    if (!rest[0]) throw Error("A confirmation ID is required.");
    console.log(JSON.stringify(await confirmationCommand(command, rest[0])));
  } else if (command === "auth" || command === "resume") {
    if (!rest[0]) throw Error("A request ID is required.");
    console.log(JSON.stringify(await humanCommand(command, rest[0])));
  } else if (command === "session-close") {
    if (
      !rest[0] ||
      rest[0].startsWith("--") ||
      rest.slice(1).some((v) => v !== "--force")
    )
      throw Error("Usage: cua session-close <sessionId> [--force]");
    console.log(
      JSON.stringify(
        await sessionCloseCommand(rest[0], rest.includes("--force")),
      ),
    );
  } else if (command === "status") {
    const results = [];
    for (const path of await listInstanceSockets())
      try {
        results.push(await socketRequest(path, { method: "status" }));
      } catch {}
    console.log(JSON.stringify(results, null, 2));
  } else
    console.log(
      "Usage: cua runner --config FILE [--acknowledge-stopped] | cua dashboard --config FILE [--port 30152] | cua setup --answers choices.json --directory DIR | cua doctor --config FILE [--mcp] [--apps on|off] | cua history <list|show|analyze|complete|delete|upload> | cua recipe <list|show|review|import|validate|activate|run|delete|distill|repair|request> [--config path.json] | cua serve [--config path.json] | cua serve-http [--config path.json] | cua approve <id> | cua deny <id> | cua auth <id> | cua resume <id> | cua status | cua session-close <sessionId> [--force]",
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

export function httpOptionsFromEnv(): HttpGatewayOptions {
  return {
    apps: process.env.CUA_MCP_APPS === "1",
    token: process.env.CUA_MCP_TOKEN ?? "",
    host: process.env.CUA_MCP_HOST ?? "127.0.0.1",
    port: Number(process.env.CUA_MCP_PORT ?? 30151),
    allowedHosts: process.env.CUA_MCP_ALLOWED_HOSTS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedOrigins: process.env.CUA_MCP_ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
