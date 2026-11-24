import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { FileHistoryStore } from "@cua/history";
import { RecipeStore, runRecipe } from "@cua/recipes";
import { startDashboard } from "@cua/dashboard";
import type { Config, createRuntime } from "./index.js";

export async function dashboardCommand(
  args: string[],
  load: (path?: string) => Promise<Config>,
  runtimeFactory: typeof createRuntime,
) {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string" }, port: { type: "string" } },
  });
  if (!values.config)
    throw Error("Usage: cua dashboard --config FILE [--port 30152]");
  const port = Number(values.port ?? 30152);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("Invalid dashboard port");
  const config = await load(values.config);
  const store = new RecipeStore(config.recipes);
  let runtimePromise: ReturnType<typeof createRuntime> | undefined;
  const app = await startDashboard({
    history: new FileHistoryStore(config.history),
    recipes: store,
    profiles: Object.entries(config.profiles).map(([name, p]) => ({
      name,
      provider: p.provider,
    })),
    defaultProfile: config.defaultProfile ?? Object.keys(config.profiles)[0],
    configLabel: resolve(values.config),
    port,
    async execute(input) {
      const runtime = await (runtimePromise ??= runtimeFactory(config).catch(
        (error) => {
          runtimePromise = undefined;
          throw error;
        },
      ));
      return runRecipe({ service: runtime.service, store, ...input });
    },
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      const stopped = app.close();
      try {
        await (await runtimePromise)?.close();
      } finally {
        await stopped;
      }
    })());
  const onSignal = () => {
    void close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.log(
    `CUA Dashboard ready: ${app.url}\nConfig: ${resolve(values.config)}`,
  );
  return { ...app, close };
}
