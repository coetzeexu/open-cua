import { analyzeRun, type FileHistoryStore } from "@cua/history";
import type { RecipeDraft } from "@cua/recipes";
/** Test-only simulated model trace; never used by runtime to invent provenance. */
export function traced(
  draft: RecipeDraft,
  history: FileHistoryStore,
): RecipeDraft {
  const run = history.read(draft.sourceRunId);
  const analysis = analyzeRun(run);
  const evidenceEventIds = [
    ...analysis.observations.map((o) => o.eventId),
    ...run.events.filter((e) => e.type === "execution.output").map((e) => e.id),
  ].slice(-2);
  return {
    ...draft,
    provenance: {
      sourceFingerprint: analysis.fingerprint,
      steps: analysis.executions.map((e) => ({
        sourceEventId: e.sourceEventId,
        disposition: "change",
        reason:
          "Test model rebuilds the fixture in a fresh session; retains intended action and verifies receipt",
        evidenceEventIds,
      })),
      resolutions: [],
      assertions: [
        {
          description: "Fixture result matches input",
          expression: draft.verify,
          evidenceEventIds,
        },
      ],
      parameterChecks: Object.keys(draft.parameters).map((name) => ({
        name,
        expression: `params.${name}`,
        evidenceEventIds,
      })),
      waits: analysis.fixedWaitCandidates.map((w) => ({
        sourceEventId: w.sourceEventId,
        strategy: "condition",
        reason: "Wait for fixture receipt",
      })),
    },
  };
}
