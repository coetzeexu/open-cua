import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { analyzeRun, FileHistoryStore } from "@cua/history";
import {
  reviewRecipe,
  requireRecipeQuality,
  RecipeStore,
  runRecipe,
  requestAssistance,
  readAssistance,
  fulfillAssistance,
} from "@cua/recipes";
import type { Config, createRuntime } from "./index.js";

export async function workflowCommand(
  command: "history" | "recipe",
  args: string[],
  load: (path?: string) => Promise<Config>,
  runtime: typeof createRuntime,
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      params: { type: "string" },
      profile: { type: "string" },
      version: { type: "string" },
      request: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const [action, id, version] = positionals;
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? undefined
      : Number(values["timeout-ms"]);
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000)
  )
    throw Error("--timeout-ms must be an integer between 1 and 300000");
  const config = await load(values.config);
  const history = new FileHistoryStore(config.history);
  const store = new RecipeStore(config.recipes);
  const required = (v: string | undefined, name: string): string => {
    if (!v) throw Error(`${name} is required`);
    return v;
  };
  let result: unknown;
  if (command === "history") {
    if (action === "list") result = history.list();
    else if (action === "show") result = history.read(required(id, "runId"));
    else if (action === "analyze")
      result = analyzeRun(history.read(required(id, "runId")));
    else if (action === "complete") {
      history.complete(required(id, "runId"), true);
      result = { runId: id, businessSuccess: true };
    } else if (action === "delete") {
      history.delete(required(id, "runId"));
      result = { deleted: id };
    } else if (action === "upload")
      result = await history.upload(required(id, "runId"));
    else
      throw Error(
        "Usage: cua history <list|show RUN|analyze RUN|complete RUN|delete RUN|upload RUN> [--config FILE]",
      );
  } else {
    if (action === "list") result = store.list();
    else if (action === "show")
      result = store.read(required(id, "name"), values.version ?? version);
    else if (action === "request")
      result = readAssistance(store, required(id, "requestId"));
    else if (action === "review") {
      const draft = JSON.parse(
        await readFile(required(id, "draft.json"), "utf8"),
      );
      const quality = reviewRecipe(
        draft,
        history.read(draft.sourceRunId),
        draft.parentVersion
          ? store.read(draft.name, draft.parentVersion)
          : undefined,
      );
      result = quality;
      if (quality.blockers.length) process.exitCode = 1;
    } else if (action === "import") {
      const draft = JSON.parse(
        await readFile(required(id, "draft.json"), "utf8"),
      );
      requireRecipeQuality(
        draft,
        history.read(draft.sourceRunId),
        draft.parentVersion
          ? store.read(draft.name, draft.parentVersion)
          : undefined,
      );
      result = values.request
        ? fulfillAssistance(store, history, values.request, draft)
        : store.save(draft);
    } else if (action === "activate")
      result = store.activate(
        required(id, "name"),
        required(values.version ?? version, "version"),
        history,
      );
    else if (action === "delete") {
      store.delete(
        required(id, "name"),
        required(values.version ?? version, "version"),
      );
      result = { deleted: id, version: values.version ?? version };
    } else if (action === "distill" || action === "repair") {
      result = await requestAssistance({
        store,
        history,
        kind: action,
        runId: required(id, "runId"),
        trigger: "manual",
        recipe:
          action === "repair"
            ? {
                name: required(version, "recipe name"),
                version: required(values.version, "--version"),
              }
            : undefined,
      });
    } else if (action === "run" || action === "validate") {
      const params = values.params
        ? JSON.parse(await readFile(values.params, "utf8"))
        : {};
      const name = required(id, "name");
      const targetVersion = values.version ?? version;
      if (action === "validate") required(targetVersion, "version");
      // Reject invalid source/parameters before starting providers or resource recovery.
      const recipe = store.read(name, targetVersion);
      const { recipeParameters } = await import("@cua/recipes");
      recipeParameters(recipe, params);
      const host = await runtime(config);
      try {
        const notices = new Set<string>();
        const run = await runRecipe({
          service: host.service,
          store,
          name,
          version: targetVersion,
          params,
          profile: values.profile,
          validate: action === "validate",
          timeoutMs,
          onProgress(result) {
            for (const warning of result.warnings) {
              if (warning.code !== "USER_ACTION_REQUIRED" || notices.has(warning.message)) continue;
              notices.add(warning.message);
              process.stderr.write(warning.message + "\n");
            }
          },
        });
        result = run;
        if (!run.passed || !run.closed) process.exitCode = 1;
      } finally {
        await host.close();
      }
    } else
      throw Error(
        "Usage: cua recipe <list|show|review|import|validate|activate|run|delete|distill|repair|request> [--config FILE] [--params FILE] [--profile NAME] [--version ID]",
      );
  }
  console.log(JSON.stringify(result, null, 2));
}
