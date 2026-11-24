import { test } from "node:test";
import assert from "node:assert/strict";
import {
  operationErrorTable,
  executionErrorTable,
  operationError,
  executionError,
  aggregate,
} from "@cua/contracts";
test("every legal operation error matches its row and safety constraints", () => {
  for (const row of [
    ...operationErrorTable,
    ...Array.from(
      { length: 1000 },
      () =>
        operationErrorTable[
          Math.floor(Math.random() * operationErrorTable.length)
        ],
    ),
  ]) {
    const e = operationError(row.code, row);
    assert.equal(e.layer, row.layer);
    assert.equal(e.phase, row.phase);
    assert.equal(e.outcome, row.outcome);
    assert.equal(e.nextAction, row.nextAction);
    if (row.phase === "before_dispatch")
      assert.equal(row.outcome, "not_executed");
    if (row.outcome === "unknown") assert.equal(e.retryable, false);
    assert.doesNotMatch(e.message, /rerun/i);
  }
});
test("execution errors contain no operation outcome and constrain unknowns", () => {
  for (const row of executionErrorTable) {
    const e = executionError(row.code, row.aggregateOutcome);
    assert.equal(e.nextAction, row.nextAction);
    assert.equal(e.toJSON().level, "execution");
    assert.equal(e.phase, undefined);
    if (row.aggregateOutcome === "some_unknown")
      assert.ok(
        [
          "observe",
          "reacquire_handle",
          "reconnect_browser",
          "request_user",
          "stop",
        ].includes(e.nextAction),
      );
  }
  assert.equal(aggregate([]), "none");
  assert.equal(aggregate([{ outcome: "unknown" }]), "some_unknown");
});
