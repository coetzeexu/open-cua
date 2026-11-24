import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, type RunHistory, type HistoryEvent } from "@cua/history";

function event(
  id: string,
  type: string,
  data: Record<string, unknown>,
  extra: Partial<HistoryEvent> = {},
): HistoryEvent {
  return {
    id,
    type,
    time: Number(id),
    runId: "run",
    sessionId: "s",
    executionId: "x",
    callId: "call",
    data,
    ...extra,
  } as HistoryEvent;
}
function observations(events: HistoryEvent[]) {
  return analyzeRun({
    runId: "run",
    events,
    status: "failed",
    businessSuccess: false,
  } as RunHistory).observations;
}
test("failure screenshot retains the exact failed call tab without rewriting history", () => {
  const events = [
    event("1", "sdk.finished", {
      status: "failed",
      method: "waitForFunction",
      tabId: "actual-tab",
    }),
    event("2", "failure.evidence", {
      evidence: { path: "artifacts/shot.jpg" },
    }),
  ];
  const before = JSON.stringify(events);
  assert.deepEqual(observations(events), [
    {
      eventId: "2",
      time: 2,
      tabId: "actual-tab",
      method: "screenshot.capture",
    },
  ]);
  assert.equal(JSON.stringify(events), before);
});
test("unavailable, restricted, mismatched, later or ambiguous screenshots cannot resolve effects", () => {
  const failed = event("1", "sdk.finished", {
    status: "failed",
    method: "waitForFunction",
    tabId: "actual-tab",
  });
  const shot = event("2", "failure.evidence", {
    evidence: { path: "artifacts/shot.jpg" },
  });
  for (const events of [
    [failed, { ...shot, data: { unavailable: true } }],
    [failed, { ...shot, data: { ...shot.data, restricted: true } }],
    [failed, { ...shot, data: { ...shot.data, truncated: true } }],
    [failed, { ...shot, callId: "other" }],
    [failed, { ...shot, sessionId: "other" }],
    [failed, { ...shot, executionId: "other" }],
    [shot, failed],
    [failed, { ...failed, id: "duplicate" }, shot],
  ])
    assert.equal(observations(events).length, 0);
});
