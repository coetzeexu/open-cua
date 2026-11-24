import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeRun,
  type FileHistoryStore,
  type RunHistory,
  type HistoryEvent,
} from "@cua/history";
import type { RecipeStore } from "@cua/recipes";

export interface Span {
  id: string;
  parentId?: string;
  kind: "execution" | "sdk" | "operation";
  label: string;
  start: number;
  end: number;
  status: string;
  eventIds: string[];
  inferredOperationIds?: string[];
}

export function summarizeRun(run: RunHistory) {
  const recipe = run.events.find((e) => e.type === "recipe.started")?.data;
  const analysis = analyzeRun(run);
  const start = run.events[0]?.time ?? 0;
  const end = run.events.at(-1)?.time ?? start;
  const status =
    run.status === "succeeded"
      ? run.businessSuccess
        ? "succeeded"
        : "unverified"
      : run.status;
  return {
    runId: run.runId,
    name: recipe?.name as string | undefined,
    version: recipe?.version as string | undefined,
    mode: recipe ? (recipe.validation ? "validation" : "run") : "exploration",
    status,
    businessSuccess: run.businessSuccess,
    start,
    end,
    durationMs: end - start,
    metrics: analysis.metrics,
    profile: run.events.find((e) => e.type === "session.created")?.data.profile,
    params: recipe?.params,
    eventCount: run.events.length,
    error: run.events
      .filter((e) => e.type === "execution.finished" && e.data.error)
      .at(-1)?.data.error,
  };
}
export type RunSummary = ReturnType<typeof summarizeRun>;

export function runTrace(run: RunHistory) {
  const summary = summarizeRun(run);
  const spans: Span[] = [];
  const executionSpans = new Map<string, Span>();
  const callSpans = new Map<string, Span>();
  const operationSpans = new Map<string, Span>();
  // An unfinished historical record is not proof of a still-running process.
  const now = summary.end;
  for (const event of run.events) {
    if (event.type === "execution.started" && event.executionId) {
      const span: Span = {
        id: event.executionId,
        kind: "execution",
        label: `Execution ${executionSpans.size + 1}`,
        start: event.time,
        end: now,
        status: "incomplete",
        eventIds: [event.id],
      };
      spans.push(span);
      executionSpans.set(event.executionId, span);
    }
    if (event.type === "sdk.started" && event.callId) {
      const span: Span = {
        id: event.callId,
        parentId: event.executionId,
        kind: "sdk",
        label: event.data.method ?? "SDK call",
        start: event.time,
        end: now,
        status: "incomplete",
        eventIds: [event.id],
      };
      spans.push(span);
      callSpans.set(event.callId, span);
    }
    if (event.type === "operation.changed" && event.data.operationId) {
      let span = event.callId ? callSpans.get(event.callId) : undefined;
      span ??= operationSpans.get(event.data.operationId);
      if (!span) {
        span = {
          id: event.data.operationId,
          parentId: event.executionId,
          kind: "operation",
          label: event.data.kind ?? "operation",
          start: event.time,
          end: now,
          status: "incomplete",
          eventIds: [],
        };
        spans.push(span);
      }
      operationSpans.set(event.data.operationId, span);
      span.eventIds.push(event.id);
      if (event.data.status) {
        span.status = event.data.status;
        span.end = event.time;
      }
    }
    if (event.type === "sdk.finished" && event.callId) {
      const span = callSpans.get(event.callId);
      if (span) {
        span.end = event.time;
        span.status = event.data.status ?? "incomplete";
        span.eventIds.push(event.id);
      }
    }
    if (event.type === "execution.finished" && event.executionId) {
      const span = executionSpans.get(event.executionId);
      if (span) {
        span.end = event.time;
        span.status = event.data.status;
        span.eventIds.push(event.id);
      }
    }
    if (event.type === "execution.output" && event.executionId)
      executionSpans.get(event.executionId)?.eventIds.push(event.id);
  }
  // Older Service records lack operation.callId. Only associate a whole operation
  // with one completed SDK call of the same method/session/execution that encloses it.
  // Ambiguous concurrent calls remain separate; never deduplicate by label alone.
  const eventById = new Map(run.events.map((e) => [e.id, e]));
  const merged = new Set<Span>();
  for (const operation of spans.filter((s) => s.kind === "operation")) {
    const events = operation.eventIds.map((id) => eventById.get(id)!);
    const candidates = events.some((e) => e.callId)
      ? []
      : spans.filter(
          (call) =>
            call.kind === "sdk" &&
            call.parentId === operation.parentId &&
            !!call.parentId &&
            call.label === operation.label &&
            call.start <= operation.start &&
            call.end >= operation.end &&
            events.every(
              (e) => e.sessionId === eventById.get(call.eventIds[0])?.sessionId,
            ) &&
            call.eventIds.some(
              (id) => eventById.get(id)?.type === "sdk.finished",
            ),
        );
    if (candidates.length === 1) {
      const call = candidates[0];
      call.eventIds.push(...operation.eventIds);
      call.eventIds.sort(
        (a, b) => eventById.get(a)!.time - eventById.get(b)!.time,
      );
      (call.inferredOperationIds ??= []).push(operation.id);
      merged.add(operation);
    } else operation.label = `底层操作 · ${operation.label}`;
  }
  const visibleSpans = spans.filter((s) => !merged.has(s));
  // Group children under their execution, independent of interleaved event order.
  const ordered: Span[] = [];
  for (const parent of visibleSpans.filter((s) => !s.parentId)) {
    ordered.push(parent);
    ordered.push(
      ...visibleSpans
        .filter((s) => s.parentId === parent.id)
        .sort((a, b) => a.start - b.start),
    );
  }
  for (const span of visibleSpans)
    if (!ordered.includes(span)) ordered.push(span);
  const artifacts = run.events.flatMap((e) => {
    const ref = artifactReference(e);
    return ref
      ? [
          {
            eventId: e.id,
            time: e.time,
            mimeType: ref.mimeType,
            path: ref.path,
          },
        ]
      : [];
  });
  return {
    ...summary,
    spans: ordered,
    events: run.events,
    artifacts,
    analysis: analyzeRun(run),
    outputs: run.events
      .filter((e) => e.type === "execution.output")
      .map((e) => ({ id: e.id, time: e.time, ...e.data })),
  };
}

export function artifactReference(event: HistoryEvent) {
  if (event.data.restricted || event.data.truncated) return undefined;
  const ref = ["failure.evidence", "sdk.finished"].includes(event.type)
    ? event.data.evidence
    : event.type === "execution.output"
      ? event.data.artifact
      : undefined;
  return ref &&
    typeof ref.path === "string" &&
    /^image\/(png|jpeg|webp)$/.test(ref.mimeType)
    ? (ref as { path: string; mimeType: string })
    : undefined;
}

export class DashboardData {
  private cache = new Map<string, { mtime: number; summary: RunSummary }>();
  constructor(
    readonly history: FileHistoryStore,
    readonly recipes: RecipeStore,
  ) {}
  snapshot() {
    const warnings: string[] = [];
    const runs: RunSummary[] = [];
    const names = existsSync(this.history.directory)
      ? readdirSync(this.history.directory, { withFileTypes: true })
      : [];
    for (const entry of names.filter(
      (e) => e.isDirectory() && /^[a-zA-Z0-9][\w-]{0,127}$/.test(e.name),
    )) {
      try {
        const mtime = statSync(
          join(this.history.directory, entry.name),
        ).mtimeMs;
        let cached = this.cache.get(entry.name);
        if (!cached || cached.mtime !== mtime) {
          cached = {
            mtime,
            summary: summarizeRun(this.history.read(entry.name)),
          };
          this.cache.set(entry.name, cached);
        }
        runs.push(cached.summary);
      } catch {
        warnings.push(`无法读取历史 ${entry.name}`);
      }
    }
    const present = new Set(names.map((e) => e.name));
    for (const id of this.cache.keys())
      if (!present.has(id)) this.cache.delete(id);
    runs.sort((a, b) => b.start - a.start);
    const recipes = this.recipes.list().map((item) => {
      item.versions.sort((a, b) => b.created - a.created);
      const current = this.recipes.read(
        item.name,
        item.active ?? item.versions[0]?.version,
      );
      const sources = [
        ...new Set(
          item.versions.map(
            (v) => this.recipes.read(item.name, v.version).sourceRunId,
          ),
        ),
      ];
      return {
        ...item,
        description: current.description,
        sources,
        stats: executionStats(runs.filter((r) => r.name === item.name)),
      };
    });
    return { recipes, runs, warnings, stats: executionStats(runs) };
  }
}

export function executionStats(runs: RunSummary[]) {
  const executions = runs.filter((r) => r.mode === "run");
  const completed = executions.filter((r) => r.status !== "incomplete");
  const passed = completed.filter((r) => r.status === "succeeded").length;
  const durations = completed
    .map((r) => r.metrics.durationMs)
    .sort((a, b) => a - b);
  return {
    total: executions.length,
    completed: completed.length,
    passed,
    failed: completed.filter((r) => ["failed", "cancelled"].includes(r.status))
      .length,
    unverified: completed.filter((r) => r.status === "unverified").length,
    successRate: completed.length ? passed / completed.length : null,
    averageMs: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    validations: runs.filter((r) => r.mode === "validation").length,
  };
}
