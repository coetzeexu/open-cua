import { analyzeRun, type RunHistory, type RunAnalysis } from "@cua/history";
import { validateParameterSchema } from "./parameters.js";
import type { RecipeDraft } from "./index.js";
export interface RecipeProvenance {
  sourceFingerprint: string;
  steps: {
    sourceEventId: string;
    disposition: "keep" | "drop" | "change";
    reason: string;
    evidenceEventIds: string[];
  }[];
  resolutions: {
    operationId: string;
    reason: string;
    evidenceEventIds: string[];
  }[];
  assertions: {
    description: string;
    expression: string;
    evidenceEventIds: string[];
  }[];
  parameterChecks: {
    name: string;
    expression: string;
    evidenceEventIds: string[];
  }[];
  waits: {
    sourceEventId: string;
    strategy: "condition" | "remove" | "retain";
    reason: string;
  }[];
  assertionChanges?: {
    description: string;
    reason: string;
    evidenceEventIds: string[];
  }[];
}
export interface RecipeQuality {
  sourceFingerprint: string;
  blockers: string[];
  warnings: string[];
  sourceMetrics: RunAnalysis["metrics"];
}
/** Validates traceability and evidence presence. It cannot prove arbitrary JS equivalence. */
export function reviewRecipe(
  draft: RecipeDraft,
  run: RunHistory,
  parent?: RecipeDraft,
): RecipeQuality {
  const analysis = analyzeRun(run);
  const blockers = [...analysis.blockers];
  const warnings = [...analysis.warnings];
  try {
    validateParameterSchema(
      { type: "object", properties: draft.parameters },
      "params",
    );
  } catch (e) {
    blockers.push(`INVALID_PARAMETER_SCHEMA: ${(e as Error).message}`);
  }
  const p = draft.provenance;
  const events = new Map(run.events.map((e) => [e.id, e]));
  const eventOrder = new Map(run.events.map((e, index) => [e.id, index]));
  const evidence = (ids: string[]) =>
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => {
      const e = events.get(id);
      return (
        e &&
        !e.data.restricted &&
        !e.data.truncated &&
        (analysis.observations.some((o) => o.eventId === id) ||
          (e.type === "execution.output" && !e.data.truncated) ||
          (e.type === "failure.evidence" && e.data.evidence))
      );
    });
  const reason = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (run.runId !== draft.sourceRunId) blockers.push("SOURCE_RUN_MISMATCH");
  if (!run.businessSuccess && !(parent && run.status === "failed"))
    blockers.push("SOURCE_BUSINESS_SUCCESS_REQUIRED");
  if (!p) blockers.push("PROVENANCE_REQUIRED");
  else {
    if (p.sourceFingerprint !== analysis.fingerprint)
      blockers.push("SOURCE_HISTORY_CHANGED");
    if (
      ![p.steps, p.resolutions, p.assertions, p.parameterChecks, p.waits].every(
        Array.isArray,
      )
    ) {
      blockers.push("INVALID_PROVENANCE");
    } else {
      const sourceIds = new Set(
        analysis.executions.map((e) => e.sourceEventId),
      );
      if (
        p.steps.length !== sourceIds.size ||
        new Set(p.steps.map((s) => s.sourceEventId)).size !== sourceIds.size ||
        p.steps.some(
          (s) =>
            !sourceIds.has(s.sourceEventId) ||
            !["keep", "drop", "change"].includes(s.disposition) ||
            !reason(s.reason) ||
            !Array.isArray(s.evidenceEventIds) ||
            (s.evidenceEventIds.length > 0 && !evidence(s.evidenceEventIds)),
        )
      )
        blockers.push("EVERY_SOURCE_CELL_NEEDS_A_DECISION");
      for (const op of analysis.unknownEffects) {
        const resolution = p.resolutions.find(
          (r) => r.operationId === op.operationId,
        );
        const later =
          resolution &&
          evidence(resolution.evidenceEventIds) &&
          resolution.evidenceEventIds.some((id) =>
            analysis.observations.some(
              (o) =>
                o.eventId === id &&
                (eventOrder.get(o.eventId) ?? -1) >
                  (eventOrder.get(op.eventId) ?? Infinity) &&
                !!op.tabId &&
                o.tabId === op.tabId,
            ),
          );
        if (!resolution || !reason(resolution.reason) || !later)
          blockers.push(`UNRESOLVED_EFFECT:${op.operationId}`);
      }
      for (const op of analysis.failedCellEffects) {
        const cell = analysis.executions.find(
          (e) => e.executionId === op.executionId,
        );
        const decision = p.steps.find(
          (s) => s.sourceEventId === cell?.sourceEventId,
        );
        if (
          decision?.disposition === "drop" &&
          !evidence(decision.evidenceEventIds)
        )
          blockers.push(`DROPPED_EFFECT_NEEDS_EVIDENCE:${op.operationId}`);
      }
      if (
        !p.assertions.length ||
        p.assertions.some(
          (a) =>
            !reason(a.description) ||
            !reason(a.expression) ||
            !draft.verify.includes(a.expression) ||
            !evidence(a.evidenceEventIds),
        )
      )
        blockers.push("BUSINESS_ASSERTION_EVIDENCE_REQUIRED");
      for (const name of Object.keys(draft.parameters)) {
        const check = p.parameterChecks.find((c) => c.name === name);
        if (
          !check ||
          !reason(check.expression) ||
          !draft.verify.includes(check.expression) ||
          !check.expression.includes(`params.${name}`) ||
          !evidence(check.evidenceEventIds)
        )
          blockers.push(`PARAMETER_CHECK_REQUIRED:${name}`);
      }
      for (const wait of analysis.fixedWaitCandidates) {
        if (
          !p.waits.some(
            (w) =>
              w.sourceEventId === wait.sourceEventId &&
              ["condition", "remove", "retain"].includes(w.strategy) &&
              reason(w.reason),
          )
        )
          blockers.push(`WAIT_DECISION_REQUIRED:${wait.sourceEventId}`);
      }
      for (const assertion of parent?.provenance?.assertions ?? []) {
        if (
          !p.assertions.some((a) => a.description === assertion.description) &&
          !p.assertionChanges?.some(
            (a) =>
              a.description === assertion.description &&
              reason(a.reason) &&
              evidence(a.evidenceEventIds),
          )
        )
          blockers.push(`LOST_PARENT_ASSERTION:${assertion.description}`);
      }
    }
  }
  // Exact known historical identifiers only; not a claim of complete static analysis.
  const sourceIds = new Set<string>();
  const collect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 20) return;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "sessionId",
          "tabId",
          "frameId",
          "refId",
          "observationId",
          "imageId",
          "screenshotId",
        ].includes(key) &&
        typeof item === "string" &&
        item.length >= 8
      )
        sourceIds.add(item);
      if (
        key === "id" &&
        ["tab", "browser"].includes((value as any).kind) &&
        typeof item === "string"
      )
        sourceIds.add(item);
      if (typeof item === "object") collect(item, depth + 1);
    }
  };
  for (const e of run.events) collect({ sessionId: e.sessionId, ...e.data });
  if (
    [...sourceIds].some(
      (id) => draft.script.includes(id) || draft.verify.includes(id),
    )
  )
    blockers.push("HISTORICAL_HANDLE_LITERAL");
  if (/\b(?:setTimeout|sleep)\s*\(/.test(draft.script))
    warnings.push("DRAFT_FIXED_WAIT: prefer an observed condition");
  warnings.push(
    "REVIEW_IS_STRUCTURAL: model must explain semantic equivalence; local validation proves only tested inputs",
  );
  return {
    sourceFingerprint: analysis.fingerprint,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    sourceMetrics: analysis.metrics,
  };
}
export function requireRecipeQuality(
  draft: RecipeDraft,
  run: RunHistory,
  parent?: RecipeDraft,
) {
  const quality = reviewRecipe(draft, run, parent);
  if (quality.blockers.length)
    throw Error(`Recipe review blocked: ${quality.blockers.join(", ")}`);
  return quality;
}
