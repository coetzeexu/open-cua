import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { Script } from "node:vm";
import {
  analyzeRun,
  type RunAnalysis,
  FileHistoryStore,
  atomicJSON,
  privateDirectory,
  readJSON,
  safeId,
  storagePath,
  type RunHistory,
} from "@cua/history";
import type { CUAService } from "@cua/service";
import type { ExecutionResult } from "@cua/contracts";

import {
  requireRecipeQuality,
  type RecipeProvenance,
  type RecipeQuality,
} from "./quality.js";
export {
  reviewRecipe,
  requireRecipeQuality,
  type RecipeProvenance,
  type RecipeQuality,
} from "./quality.js";

export type AssistMode = "disabled" | "manual" | "auto";
export interface RecipesConfig {
  directory?: string;
  distill?: { mode?: AssistMode };
  repair?: { mode?: AssistMode };
}
import {
  resolveParameters,
  validateParameterSchema,
  type Parameter,
} from "./parameters.js";
export type { Parameter, JSONValue } from "./parameters.js";
export interface RecipeDraft {
  name: string;
  description: string;
  sourceRunId: string;
  parentVersion?: string;
  parameters: Record<string, Parameter>;
  preconditions: string[];
  script: string;
  verify: string;
  provenance?: RecipeProvenance;
}
export interface RecipeVersion extends RecipeDraft {
  version: string;
  created: number;
  hash: string;
}
export interface Validation {
  runId: string;
  hash: string;
  environment: "fake" | "local-browser" | "other-browser";
  passed: boolean;
  browserObserved: boolean;
  time: number;
  quality?: RecipeQuality;
  metrics?: RunAnalysis["metrics"];
}
export function validateRecipesConfig(config: RecipesConfig = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("Invalid recipes configuration");
  if (
    config.directory !== undefined &&
    (typeof config.directory !== "string" || !config.directory)
  )
    throw Error("Invalid recipes.directory");
  for (const key of ["distill", "repair"] as const)
    if (
      config[key] !== undefined &&
      (!config[key] ||
        !["disabled", "manual", "auto"].includes(config[key]?.mode ?? "manual"))
    )
      throw Error(`Invalid recipes.${key}.mode`);
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function recipeBody(r: RecipeDraft) {
  return {
    name: r.name,
    description: r.description,
    sourceRunId: r.sourceRunId,
    parentVersion: r.parentVersion,
    parameters: r.parameters,
    preconditions: r.preconditions,
    script: r.script,
    verify: r.verify,
    ...(r.provenance ? { provenance: r.provenance } : {}),
  };
}
function validateDraft(raw: RecipeDraft): RecipeDraft {
  if (!raw || typeof raw !== "object")
    throw Error("Recipe draft must be an object");
  safeId(raw.name);
  safeId(raw.sourceRunId);
  if (raw.name === "assistance") throw Error("Reserved recipe name");
  if (raw.parentVersion) safeId(raw.parentVersion);
  if (
    typeof raw.description !== "string" ||
    !Array.isArray(raw.preconditions) ||
    raw.preconditions.some((v) => typeof v !== "string")
  )
    throw Error("Recipe description and preconditions are required");
  if (
    typeof raw.script !== "string" ||
    !raw.script.trim() ||
    typeof raw.verify !== "string" ||
    !raw.verify.trim()
  )
    throw Error("script and verify are required; verify must return true");
  if (
    !raw.parameters ||
    typeof raw.parameters !== "object" ||
    Array.isArray(raw.parameters)
  )
    throw Error("parameters must be an object");
  validateParameterSchema(
    { type: "object", properties: raw.parameters },
    "params",
  );
  // Parse the actual execution wrapper without executing user code.
  new Script(
    `(async function(params) { ${raw.script}\n;return await (async () => { ${raw.verify}\n})(); })`,
  );
  return structuredClone(recipeBody(raw));
}
export class RecipeStore {
  readonly directory: string;
  constructor(readonly config: RecipesConfig = {}) {
    validateRecipesConfig(config);
    this.directory = storagePath(config.directory ?? "~/.cua/recipes");
  }
  private root(name: string) {
    return join(this.directory, safeId(name));
  }
  private versionRoot(name: string, version: string) {
    return join(this.root(name), safeId(version));
  }
  save(input: RecipeDraft): RecipeVersion {
    const draft = validateDraft(input);
    if (draft.parentVersion) this.read(draft.name, draft.parentVersion);
    const version = randomUUID();
    const result = {
      ...draft,
      version,
      created: Date.now(),
      hash: digest(draft),
    };
    const root = this.versionRoot(draft.name, version);
    privateDirectory(root);
    atomicJSON(join(root, "recipe.json"), result);
    return result;
  }
  read(name: string, version?: string): RecipeVersion {
    version ??= readJSON(join(this.root(name), "active.json")).version;
    const result = readJSON(
      join(this.versionRoot(name, version!), "recipe.json"),
    ) as RecipeVersion;
    if (
      result.name !== name ||
      result.version !== version ||
      digest(recipeBody(result)) !== result.hash
    )
      throw Error("Recipe integrity check failed");
    validateDraft(result);
    return result;
  }
  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "assistance")
      .map((d) => {
        const root = this.root(d.name);
        return {
          name: d.name,
          active: existsSync(join(root, "active.json"))
            ? readJSON(join(root, "active.json")).version
            : null,
          versions: readdirSync(root, { withFileTypes: true })
            .filter((v) => v.isDirectory())
            .map((v) => {
              const r = this.read(d.name, v.name);
              return {
                version: r.version,
                created: r.created,
                hash: r.hash,
                validations: this.validations(d.name, v.name),
              };
            }),
        };
      });
  }
  validations(name: string, version: string): Validation[] {
    return readdirSync(this.versionRoot(name, version))
      .filter((f) => f.startsWith("validation-") && f.endsWith(".json"))
      .sort()
      .map((f) => readJSON(join(this.versionRoot(name, version), f)));
  }
  recordValidation(
    recipe: RecipeVersion,
    validation: Omit<Validation, "hash" | "time">,
  ) {
    this.read(recipe.name, recipe.version);
    atomicJSON(
      join(
        this.versionRoot(recipe.name, recipe.version),
        `validation-${Date.now()}-${randomUUID()}.json`,
      ),
      { ...validation, hash: recipe.hash, time: Date.now() },
    );
  }
  activate(name: string, version: string, history?: FileHistoryStore) {
    const recipe = this.read(name, version);
    const validations = this.validations(name, version);
    const latest = validations.at(-1);
    if (
      !latest?.passed ||
      !latest.browserObserved ||
      latest.environment !== "local-browser" ||
      latest.hash !== recipe.hash
    )
      throw Error(
        "Activation requires the latest validation to pass on a local browser",
      );
    if (!latest.quality || latest.quality.blockers.length)
      throw Error(
        "Activation requires provenance review and a new local browser validation",
      );
    if (history) {
      const quality = requireRecipeQuality(
        recipe,
        history.read(recipe.sourceRunId),
        recipe.parentVersion
          ? this.read(name, recipe.parentVersion)
          : undefined,
      );
      if (quality.sourceFingerprint !== latest.quality.sourceFingerprint)
        throw Error("Source history changed after validation");
    }
    atomicJSON(join(this.root(name), "active.json"), {
      version,
      hash: recipe.hash,
    });
    return { name, active: version };
  }
  delete(name: string, version: string) {
    this.read(name, version);
    const active = join(this.root(name), "active.json");
    if (existsSync(active) && readJSON(active).version === version)
      throw Error("Cannot delete an active recipe version");
    rmSync(this.versionRoot(name, version), { recursive: true });
  }
}
export function recipeParameters(
  recipe: RecipeVersion,
  supplied: Record<string, unknown>,
) {
  return resolveParameters(recipe.parameters, supplied);
}

export interface AssistanceRequest {
  id: string;
  kind: "distill" | "repair";
  runId: string;
  recipe?: { name: string; version: string };
  status: "model_required" | "draft_created";
  draft?: { name: string; version: string };
  analysis?: RunAnalysis;
}
export type ModelAssistant = (input: {
  request: AssistanceRequest;
  history: RunHistory;
  recipe?: RecipeVersion;
}) => Promise<RecipeDraft>;
export function readAssistance(
  store: RecipeStore,
  id: string,
): AssistanceRequest {
  return readJSON(join(store.directory, "assistance", `${safeId(id)}.json`));
}
function withRequestLock<T>(path: string, work: () => T): T {
  const lock = `${path}.lock`;
  writeFileSync(lock, "locked", { flag: "wx", mode: 0o600 });
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}
export function fulfillAssistance(
  store: RecipeStore,
  history: FileHistoryStore,
  id: string,
  proposal: RecipeDraft,
) {
  const path = join(store.directory, "assistance", `${safeId(id)}.json`);
  return withRequestLock(path, () => {
    const request = readAssistance(store, id);
    if (store.config[request.kind]?.mode === "disabled")
      throw Error("Model assistance is disabled");
    if (request.status === "draft_created") return request;
    const run = history.read(request.runId);
    if (run.events.some((e) => e.data?.restricted))
      throw Error("Private workflow cannot be distilled");
    if (
      request.kind === "distill"
        ? !run.businessSuccess
        : run.status !== "failed"
    )
      throw Error("Source run no longer eligible");
    if (
      proposal.sourceRunId !== request.runId ||
      (request.recipe &&
        request.kind === "repair" &&
        (proposal.name !== request.recipe.name ||
          proposal.parentVersion !== request.recipe.version))
    )
      throw Error("Draft must preserve source run and repair parent");
    requireRecipeQuality(
      proposal,
      run,
      request.recipe
        ? store.read(request.recipe.name, request.recipe.version)
        : undefined,
    );
    const saved = store.save(proposal);
    const completed: AssistanceRequest = {
      ...request,
      status: "draft_created",
      draft: { name: saved.name, version: saved.version },
    };
    atomicJSON(join(store.directory, "assistance", `${id}.json`), completed);
    history.append(request.runId, "assistance.draft_created", {
      kind: request.kind,
      draft: completed.draft,
    });
    return completed;
  });
}
/** Host-owned integration. CUA worker/SDK cannot choose mode or install this callback. */
export async function requestAssistance(options: {
  store: RecipeStore;
  history: FileHistoryStore;
  kind: "distill" | "repair";
  runId: string;
  trigger: "manual" | "auto";
  recipe?: { name: string; version: string };
  model?: ModelAssistant;
}) {
  const { store, history, kind, runId } = options;
  const mode = store.config[kind]?.mode ?? "manual";
  if (mode === "disabled" || (options.trigger === "auto" && mode !== "auto"))
    return { status: "disabled" as const };
  const run = history.read(runId);
  if (kind === "distill" ? !run.businessSuccess : run.status !== "failed")
    throw Error(
      kind === "distill"
        ? "Distillation requires explicit business success"
        : "Repair requires a failed run",
    );
  if (run.events.some((e) => e.data?.restricted))
    throw Error("Private workflow history cannot be sent for model assistance");
  const recipe = options.recipe
    ? store.read(options.recipe.name, options.recipe.version)
    : undefined;
  if (kind === "repair" && !recipe)
    throw Error("Repair requires a recipe version");
  const id = digest({ kind, runId, recipe: options.recipe });
  const root = join(store.directory, "assistance");
  privateDirectory(root);
  const path = join(root, `${id}.json`);
  const request: AssistanceRequest = withRequestLock(path, () => {
    if (existsSync(path)) return readJSON(path);
    const created: AssistanceRequest = {
      id,
      kind,
      runId,
      recipe: options.recipe,
      status: "model_required",
      analysis: analyzeRun(run),
    };
    atomicJSON(path, created);
    return created;
  });
  if (request.status === "draft_created" || !options.model) return request;
  const lock = `${path}.processing`;
  try {
    writeFileSync(lock, "processing", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { ...request, pending: true };
  }
  try {
    const latest = readAssistance(store, id);
    if (latest.status === "draft_created") return latest;
    const proposal = await options.model({ request, history: run, recipe });
    if (
      proposal.sourceRunId !== runId ||
      (kind === "repair" &&
        recipe &&
        (proposal.name !== recipe.name ||
          proposal.parentVersion !== recipe.version))
    )
      throw Error("Model draft must preserve source run and repair parent");
    return fulfillAssistance(store, history, id, proposal);
  } finally {
    rmSync(lock, { force: true });
  }
}
export async function runRecipe(options: {
  service: CUAService;
  store: RecipeStore;
  name: string;
  version?: string;
  params?: Record<string, unknown>;
  profile?: string;
  validate?: boolean;
  model?: ModelAssistant;
  timeoutMs?: number;
  onProgress?: (result: ExecutionResult) => void;
  /** Trusted host correlation ID, so a dashboard can observe history while running. */
  runId?: string;
}) {
  const { service, store } = options;
  const recipe = store.read(options.name, options.version);
  if (!options.validate && store.read(options.name).version !== recipe.version)
    throw Error("Only active versions may run; use validate for drafts");
  if (options.validate && !service.history.enabled)
    throw Error(
      "Recipe validation requires history recording for evidence and metrics",
    );
  const quality = options.validate
    ? requireRecipeQuality(
        recipe,
        service.history.read(recipe.sourceRunId),
        recipe.parentVersion
          ? store.read(recipe.name, recipe.parentVersion)
          : undefined,
      )
    : undefined;
  const params = recipeParameters(recipe, options.params ?? {});
  const marker = randomUUID();
  const code = `var __cuaRecipeResult = await (async function(params) {\n${recipe.script}\n;var __cuaVerified = await (async () => {\n${recipe.verify}\n})();\nif (__cuaVerified !== true) throw new Error("RECIPE_VERIFICATION_FAILED");\nreturn ${JSON.stringify(marker)};\n})((function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; })(JSON.parse(${JSON.stringify(JSON.stringify(params))})));\nif (__cuaRecipeResult !== ${JSON.stringify(marker)}) throw new Error("RECIPE_VERIFICATION_SKIPPED");\noutput.json({recipeVerified:${JSON.stringify(marker)}});`;
  const session = await service.createSession({
    profile: options.profile,
    runId: options.runId,
    goal: recipe.description,
  });
  let result: ExecutionResult | undefined;
  let closed = false;
  let passed = false;
  let browserObserved = false;
  try {
    service.history.append(session.runId, "recipe.started", {
      name: recipe.name,
      version: recipe.version,
      hash: recipe.hash,
      params,
      validation: !!options.validate,
    });
    result = await service.execute({
      sessionId: session.sessionId,
      code,
      timeoutMs: options.timeoutMs,
    });
    options.onProgress?.(result);
    const collectedOutput = [...result.output];
    while (result.status === "running") {
      result = await service.getExecution({
        sessionId: session.sessionId,
        executionId: result.executionId,
        // Advance the output cursor so already-delivered progress does not
        // turn long polling into a microtask loop that starves browser I/O.
        cursor: result.cursor,
        waitMs: 1000,
      });
      collectedOutput.push(...result.output);
      options.onProgress?.(result);
    }
    result = { ...result, output: collectedOutput };
    passed =
      result.status === "succeeded" &&
      result.output.some((o) => {
        try {
          return (
            o.type === "json" &&
            JSON.parse(o.text ?? "null")?.recipeVerified === marker
          );
        } catch {
          return false;
        }
      });
    browserObserved = result.operations.some(
      (operation) =>
        [
          "ax.snapshot",
          "dom.snapshot",
          "dom.inspect",
          "screenshot.capture",
          "evaluate",
          "waitForFunction",
        ].includes(operation.kind) && operation.status === "succeeded",
    );
    if (service.history.enabled)
      service.history.complete(session.runId, passed);
  } finally {
    closed = (await service.closeSession({ sessionId: session.sessionId }))
      .closed;
  }
  const provider = session.provider;
  const environment =
    provider === "local"
      ? "local-browser"
      : provider === "fake-browser"
        ? "fake"
        : "other-browser";
  let validationAnalysis: RunAnalysis | undefined;
  if (service.history.enabled) {
    try {
      validationAnalysis = analyzeRun(service.history.read(session.runId));
    } catch {
      quality?.blockers.push("VALIDATION_HISTORY_UNAVAILABLE");
      result?.warnings.push({
        code: "HISTORY_ANALYSIS_UNAVAILABLE",
        message:
          "Execution finished but history analysis is unavailable; inspect the result before any retry.",
      });
    }
  }
  if (quality && validationAnalysis) {
    quality.warnings.push(...validationAnalysis.warnings);
    quality.blockers.push(
      ...validationAnalysis.blockers,
      ...validationAnalysis.unknownEffects.map(
        (op) => `VALIDATION_UNKNOWN_EFFECT:${op.operationId}`,
      ),
    );
  }
  if (options.validate)
    passed = passed && !!quality && !quality.blockers.length;
  if (options.validate)
    store.recordValidation(recipe, {
      runId: session.runId,
      environment,
      passed: passed && closed && !!quality && !quality.blockers.length,
      quality,
      metrics: validationAnalysis?.metrics,
      browserObserved,
    });
  let assistance: unknown;
  if (
    !options.validate &&
    service.history.enabled &&
    closed &&
    (passed || result?.status === "failed")
  ) {
    try {
      assistance = await requestAssistance({
        store,
        history: service.history,
        kind: passed ? "distill" : "repair",
        runId: session.runId,
        trigger: "auto",
        recipe: { name: recipe.name, version: recipe.version },
        model: options.model,
      });
    } catch {
      assistance = {
        status: "unavailable",
        message:
          "Execution finished; model assistance could not be prepared. Inspect history before retrying.",
      };
    }
  }
  return {
    runId: session.runId,
    recipe: { name: recipe.name, version: recipe.version },
    passed,
    closed,
    browserObserved,
    environment,
    result,
    assistance,
    quality,
    metrics: validationAnalysis?.metrics,
  };
}
