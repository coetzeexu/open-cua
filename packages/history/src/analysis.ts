import { createHash } from "node:crypto";
import type { RunHistory, HistoryEvent } from "./index.js";

export const observationMethods = new Set([
  "ax.snapshot",
  "dom.snapshot",
  "dom.inspect",
  "screenshot.capture",
  "info",
  "devLogs",
]);
const readMethods = new Set([
  ...observationMethods,
  "describe",
  "tabs.list",
  "tabs.get",
  "userTabs.list",
  "dialogs.pending",
  "popups.list",
]);
export interface AnalyzedOperation {
  operationId: string;
  executionId?: string;
  eventId: string;
  time: number;
  kind: string;
  tabId?: string;
  status?: string;
  phase?: string;
  outcome?: string;
  mayChangeState: boolean;
}
export interface RunAnalysis {
  runId: string;
  fingerprint: string;
  businessSuccess: boolean;
  executions: {
    executionId?: string;
    sourceEventId: string;
    status: string;
    durationMs?: number;
  }[];
  operations: AnalyzedOperation[];
  observations: {
    eventId: string;
    time: number;
    tabId?: string;
    method: string;
  }[];
  unknownEffects: AnalyzedOperation[];
  failedCellEffects: AnalyzedOperation[];
  fixedWaitCandidates: { sourceEventId: string; milliseconds: number }[];
  redundantObservationCandidates: {
    eventId: string;
    previousEventId: string;
  }[];
  missingEvidence: {
    eventId: string;
    method?: string;
    originalBytes?: number;
    critical: boolean;
  }[];
  blockers: string[];
  warnings: string[];
  metrics: {
    executions: number;
    failedExecutions: number;
    operations: number;
    failedOperations: number;
    observations: number;
    durationMs: number;
    fixedWaitLiteralMs: number;
  };
}
/** Evidence inventory, not a JavaScript optimizer or a proof of business semantics. */
export function analyzeRun(run: RunHistory): RunAnalysis {
  const events = run.events.filter(
    (e) => !e.type.startsWith("assistance.") && e.type !== "run.completed",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  const starts = events.filter((e) => e.type === "execution.started");
  const finishes = new Map(
    events
      .filter((e) => e.type === "execution.finished")
      .map((e) => [e.executionId, e]),
  );
  const executions = starts.map((e) => ({
    executionId: e.executionId,
    sourceEventId: e.id,
    status: finishes.get(e.executionId)?.data.status ?? "incomplete",
    durationMs: finishes.has(e.executionId)
      ? Math.max(0, finishes.get(e.executionId)!.time - e.time)
      : undefined,
  }));
  const opMap = new Map<string, AnalyzedOperation>();
  const add = (event: HistoryEvent, op: any) => {
    if (!op?.operationId || !op.kind) return;
    const previous = opMap.get(op.operationId);
    opMap.set(op.operationId, {
      ...previous,
      ...op,
      executionId: event.executionId,
      eventId:
        event.type === "execution.finished" && previous
          ? previous.eventId
          : event.id,
      time:
        event.type === "execution.finished" && previous
          ? previous.time
          : event.time,
      mayChangeState: !readMethods.has(op.kind),
    });
  };
  for (const e of events) {
    if (e.type === "operation.changed") add(e, e.data);
    if (e.type === "execution.finished")
      for (const op of e.data.operations ?? []) add(e, op);
  }
  const operations = [...opMap.values()];
  const observations = events
    .filter(
      (e) =>
        e.type === "sdk.finished" &&
        e.data.status === "succeeded" &&
        (observationMethods.has(e.data.method) ||
          ["evaluate", "waitForFunction"].includes(e.data.method)) &&
        !e.data.truncated &&
        !e.data.restricted,
    )
    .map((e) => ({
      eventId: e.id,
      time: e.time,
      tabId: e.data.tabId,
      method: e.data.method,
    }));
  // Failure screenshots are captured by the service from the failed SDK call's
  // exact tab, but do not emit sdk.finished. Recover that identity only from an
  // unambiguous, earlier call in the same session/execution; never guess a tab.
  for (const [index, event] of events.entries()) {
    if (
      event.type !== "failure.evidence" ||
      !event.callId ||
      !event.data.evidence?.path ||
      event.data.restricted ||
      event.data.truncated
    )
      continue;
    const calls = events
      .slice(0, index)
      .filter(
        (candidate) =>
          candidate.type === "sdk.finished" &&
          candidate.callId === event.callId &&
          candidate.sessionId === event.sessionId &&
          candidate.executionId === event.executionId &&
          candidate.data.status === "failed" &&
          candidate.data.tabId &&
          !candidate.data.restricted &&
          !candidate.data.truncated,
      );
    if (calls.length !== 1) continue;
    observations.push({
      eventId: event.id,
      time: event.time,
      tabId: calls[0].data.tabId,
      method: "screenshot.capture",
    });
  }
  const unknownEffects = operations.filter(
    (o) => o.mayChangeState && (!o.outcome || o.outcome === "unknown"),
  );
  const failedIds = new Set(
    executions
      .filter((e) => e.status !== "succeeded")
      .map((e) => e.executionId),
  );
  const failedCellEffects = operations.filter(
    (o) =>
      o.mayChangeState &&
      o.outcome !== "not_executed" &&
      failedIds.has(o.executionId),
  );
  const fixedWaitCandidates = starts.flatMap((e) =>
    [
      ...String(e.data.code ?? "").matchAll(
        /(?:setTimeout\s*\(\s*\w+\s*,|\bsleep\s*\()\s*(\d+)\s*\)/g,
      ),
    ].map((m) => ({ sourceEventId: e.id, milliseconds: Number(m[1]) })),
  );
  // Only exact repeated read requests in adjacent SDK calls are candidates, never automatically removed.
  const redundantObservationCandidates: RunAnalysis["redundantObservationCandidates"] =
    [];
  let previous: { key: string; id: string } | undefined;
  for (const e of events.filter((e) => e.type === "sdk.started")) {
    if (!observationMethods.has(e.data.method)) {
      previous = undefined;
      continue;
    }
    const key = JSON.stringify([e.data.method, e.data.tabId, e.data.args]);
    if (previous?.key === key)
      redundantObservationCandidates.push({
        eventId: e.id,
        previousEventId: previous.id,
      });
    previous = { key, id: e.id };
  }
  const blockers: string[] = [];
  if (events.some((e) => e.data.restricted)) blockers.push("PRIVATE_HISTORY");
  const missingEvidence = events
    .filter((e) => e.data.truncated)
    .map((e) => {
      const method =
        e.type === "sdk.finished"
          ? events.find(
              (start) =>
                start.type === "sdk.started" && start.callId === e.callId,
            )?.data.method
          : undefined;
      const critical = !(
        e.type === "execution.output" ||
        e.type === "failure.evidence" ||
        (e.type === "sdk.finished" && observationMethods.has(method))
      );
      return {
        eventId: e.id,
        method,
        originalBytes: e.data.originalBytes,
        critical,
      };
    });
  if (missingEvidence.some((e) => e.critical))
    blockers.push("TRUNCATED_HISTORY");
  if (!starts.length || executions.some((e) => e.status === "incomplete"))
    blockers.push("INCOMPLETE_HISTORY");
  const startedCalls = events.filter((e) => e.type === "sdk.started");
  const finishedCalls = new Set(
    events.filter((e) => e.type === "sdk.finished").map((e) => e.callId),
  );
  if (startedCalls.some((e) => !finishedCalls.has(e.callId)))
    blockers.push("INCOMPLETE_SDK_CALLS");
  if (
    events.some((e) =>
      (e.data.warnings ?? []).some(
        (w: any) => w.code === "HISTORY_WRITE_FAILED",
      ),
    )
  )
    blockers.push("HISTORY_WRITE_FAILED");
  if (
    [...finishes.keys()].some((id) => !starts.some((e) => e.executionId === id))
  )
    blockers.push("MISSING_EXECUTION_SOURCE");
  const warnings: string[] = [];
  if (missingEvidence.some((e) => !e.critical))
    warnings.push(
      "OBSERVATION_EVIDENCE_TRUNCATED: use other complete observations; truncated events cannot support provenance",
    );
  if (fixedWaitCandidates.length)
    warnings.push(
      "FIXED_WAIT_CANDIDATES: literal source hints, not measured wait time",
    );
  if (redundantObservationCandidates.length)
    warnings.push(
      "REPEATED_READ_CANDIDATES: page may have changed asynchronously",
    );
  if (failedCellEffects.length)
    warnings.push("FAILED_CELL_HAS_EFFECTS: do not drop the whole cell");
  if (!observations.length) warnings.push("NO_BROWSER_OBSERVATION_EVIDENCE");
  return {
    runId: run.runId,
    fingerprint,
    businessSuccess: run.businessSuccess,
    executions,
    operations,
    observations,
    unknownEffects,
    failedCellEffects,
    fixedWaitCandidates,
    redundantObservationCandidates,
    missingEvidence,
    blockers,
    warnings,
    metrics: {
      executions: executions.length,
      failedExecutions: executions.filter((e) => e.status !== "succeeded")
        .length,
      operations: operations.length,
      failedOperations: operations.filter((o) => o.status !== "succeeded")
        .length,
      observations: observations.length,
      durationMs: executions.reduce((n, e) => n + (e.durationMs ?? 0), 0),
      fixedWaitLiteralMs: fixedWaitCandidates.reduce(
        (n, w) => n + w.milliseconds,
        0,
      ),
    },
  };
}
