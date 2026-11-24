export type Layer =
  | "repl"
  | "ipc"
  | "service"
  | "policy"
  | "binding"
  | "cdp"
  | "page"
  | "agentbay";
export type Phase = "before_dispatch" | "dispatch" | "after_dispatch";
export type Outcome = "not_executed" | "executed" | "failed" | "unknown";
export type AggregateOutcome = "none" | "all_known" | "some_unknown";
export type NextAction =
  | "retry"
  | "observe_then_retry"
  | "observe"
  | "respond_dialog"
  | "reacquire_handle"
  | "reconnect_browser"
  | "open_new_tab"
  | "fix_code"
  | "request_user"
  | "use_secure_input"
  | "navigate_new_document"
  | "stop";
export interface ErrorRow {
  code: string;
  layer: Layer;
  phase: Phase;
  outcome: Outcome;
  nextAction: NextAction;
}
const row = (
  code: string,
  layer: Layer,
  phase: Phase,
  outcome: Outcome,
  nextAction: NextAction,
): ErrorRow => ({ code, layer, phase, outcome, nextAction });
const before = (code: string, layer: Layer, next: NextAction) =>
  row(code, layer, "before_dispatch", "not_executed", next);
export const operationErrorTable: readonly ErrorRow[] = [
  before("SECURE_FORM_PROTECTED", "service", "request_user"),
  before("REF_STALE", "binding", "observe_then_retry"),
  before("REF_EXPIRED", "binding", "observe"),
  before("HANDLE_STALE", "ipc", "reacquire_handle"),
  before("TARGET_NOT_ACTIONABLE", "page", "observe_then_retry"),
  before("ACTION_UNSUPPORTED_FOR_TARGET", "binding", "fix_code"),
  before("CAPABILITY_UNAVAILABLE", "service", "fix_code"),
  before("SCOPE_CLOSED", "ipc", "fix_code"),
  before("SCOPE_UNKNOWN", "ipc", "fix_code"),
  before("DIALOG_PENDING", "page", "respond_dialog"),
  row("INTERRUPTED_BY_DIALOG", "page", "dispatch", "unknown", "respond_dialog"),
  before("TAB_CLOSED", "binding", "reacquire_handle"),
  before("TAB_QUARANTINED", "binding", "open_new_tab"),
  ...(["cdp", "page"] as const).flatMap((layer) => [
    before("OPERATION_TIMEOUT", layer, "retry"),
    row("OPERATION_TIMEOUT", layer, "dispatch", "unknown", "observe"),
  ]),
  before("OPERATION_CANCELLED", "service", "stop"),
  row("OPERATION_CANCELLED", "service", "dispatch", "unknown", "observe"),
  row("ACTION_OUTCOME_UNKNOWN", "cdp", "dispatch", "unknown", "observe"),
  row("EVALUATE_ABANDONED", "page", "dispatch", "unknown", "observe"),
  row("PAGE_SCRIPT_ERROR", "page", "dispatch", "failed", "fix_code"),
  before("BROWSER_DISCONNECTED", "binding", "reconnect_browser"),
  ...(["dispatch", "after_dispatch"] as const).map((phase) =>
    row(
      "BROWSER_DISCONNECTED",
      "binding",
      phase,
      "unknown",
      "reconnect_browser",
    ),
  ),
  before("CONNECT_FAILED", "binding", "retry"),
  before("POLICY_BLOCKED", "policy", "stop"),
  row("POLICY_BLOCKED", "policy", "after_dispatch", "executed", "stop"),
  before("POLICY_CONFIRMATION_REQUIRED", "policy", "request_user"),
  before("POLICY_UNAVAILABLE", "policy", "retry"),
  before("BROWSER_MAX_RUNTIME_EXCEEDED", "agentbay", "request_user"),
  before("AGENTBAY_CREATE_FAILED", "agentbay", "retry"),
  row(
    "AGENTBAY_CREATE_UNKNOWN",
    "agentbay",
    "dispatch",
    "unknown",
    "request_user",
  ),
  before("SECURE_INPUT_REQUIRED", "policy", "use_secure_input"),
  before("CREDENTIAL_PROTECTED", "policy", "navigate_new_document"),
  before("TAB_HANDED_OFF", "binding", "request_user"),
  before("INVALID_ARGUMENT", "service", "fix_code"),
  before("AUTH_UNAVAILABLE", "service", "stop"),
  before("AUTH_DECLINED", "service", "stop"),
  before("AUTH_EXPIRED", "service", "observe_then_retry"),
  before("AUTH_PAGE_CHANGED", "page", "observe_then_retry"),
  before("AUTH_ORIGIN_CHANGED", "page", "observe_then_retry"),
  before("AUTH_LOCATOR_INVALID", "page", "observe_then_retry"),
  row("AUTH_SUBMISSION_FAILED", "page", "dispatch", "unknown", "observe"),
];
export interface ExecutionErrorRow {
  code: string;
  layer: Layer;
  aggregateOutcome: AggregateOutcome;
  nextAction: NextAction;
}
const execRows = (
  codes: string[],
  layer: Layer,
  outcomes: AggregateOutcome[],
  nextAction: NextAction,
): ExecutionErrorRow[] =>
  codes.flatMap((code) =>
    outcomes.map((aggregateOutcome) => ({
      code,
      layer,
      aggregateOutcome,
      nextAction,
    })),
  );
export const executionErrorTable: readonly ExecutionErrorRow[] = [
  ...execRows(
    ["SYNTAX_ERROR", "SYNTAX_INCOMPLETE", "STATIC_IMPORT_UNSUPPORTED"],
    "repl",
    ["none"],
    "fix_code",
  ),
  ...execRows(
    ["USER_CODE_ERROR", "EXECUTION_TIMEOUT"],
    "repl",
    ["none", "all_known"],
    "fix_code",
  ),
  ...execRows(
    ["USER_CODE_ERROR", "EXECUTION_TIMEOUT"],
    "repl",
    ["some_unknown"],
    "observe",
  ),
  ...execRows(
    ["EXECUTION_CANCELLED"],
    "service",
    ["none", "all_known"],
    "stop",
  ),
  ...execRows(["EXECUTION_CANCELLED"], "service", ["some_unknown"], "observe"),
  ...execRows(
    ["WORKER_UNRESPONSIVE", "WORKER_EXITED", "WORKER_FAULT"],
    "repl",
    ["none", "all_known", "some_unknown"],
    "reacquire_handle",
  ),
  ...execRows(["SESSION_BUSY"], "service", ["none"], "retry"),
  ...execRows(
    ["SESSION_LIMIT", "DEDUP_LIMIT"],
    "service",
    ["none"],
    "request_user",
  ),
  ...execRows(["REQUEST_ID_CONFLICT"], "service", ["none"], "fix_code"),
  ...execRows(
    ["RESULT_EXPIRED", "OUTPUT_EXPIRED", "HISTORY_WRITE_FAILED"],
    "service",
    ["none"],
    "stop",
  ),
  ...execRows(["CLEANUP_INCOMPLETE"], "agentbay", ["none"], "request_user"),
];
export interface SerializedError {
  code: string;
  level: "operation" | "execution";
  layer: Layer;
  nextAction: NextAction;
  retryable: boolean;
  message: string;
  diagnostics?: Record<string, unknown>;
}
export class CuaError extends Error implements SerializedError {
  readonly code: string;
  readonly level: "operation" | "execution";
  readonly layer: Layer;
  readonly nextAction: NextAction;
  readonly retryable: boolean;
  readonly diagnostics?: Record<string, unknown>;
  readonly phase?: Phase;
  readonly outcome?: Outcome;
  constructor(
    error: SerializedError,
    operation?: { phase: Phase; outcome: Outcome },
  ) {
    super(error.message);
    this.name = "CuaError";
    this.code = error.code;
    this.level = error.level;
    this.layer = error.layer;
    this.nextAction = error.nextAction;
    this.retryable = error.retryable;
    this.diagnostics = error.diagnostics;
    if (operation) {
      this.phase = operation.phase;
      this.outcome = operation.outcome;
    }
  }
  toJSON(): SerializedError {
    return {
      code: this.code,
      level: this.level,
      layer: this.layer,
      nextAction: this.nextAction,
      retryable: this.retryable,
      message: this.message,
      ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}),
    };
  }
}
export function operationError(
  code: string,
  options: {
    phase?: Phase;
    layer?: Layer;
    message?: string;
    diagnostics?: Record<string, unknown>;
  } = {},
): CuaError {
  const found = operationErrorTable.find(
    (r) =>
      r.code === code &&
      (!options.phase || r.phase === options.phase) &&
      (!options.layer || r.layer === options.layer),
  );
  if (!found) throw new Error(`Invalid operation error contract: ${code}`);
  return new CuaError(
    {
      ...found,
      level: "operation",
      retryable: ["retry", "observe_then_retry"].includes(found.nextAction),
      message: options.message ?? `${code}: ${found.nextAction}`,
      diagnostics: options.diagnostics,
    },
    found,
  );
}
export function executionError(
  code: string,
  aggregateOutcome: AggregateOutcome = "none",
  message?: string,
  diagnostics?: Record<string, unknown>,
): CuaError {
  const found = executionErrorTable.find(
    (r) => r.code === code && r.aggregateOutcome === aggregateOutcome,
  );
  if (!found)
    throw new Error(
      `Invalid execution error contract: ${code}/${aggregateOutcome}`,
    );
  return new CuaError({
    ...found,
    level: "execution",
    retryable: ["retry", "observe_then_retry"].includes(found.nextAction),
    message: message ?? `${code}: ${found.nextAction}`,
    diagnostics,
  });
}
export const aggregate = (
  operations: { outcome: Outcome }[],
): AggregateOutcome =>
  operations.length === 0
    ? "none"
    : operations.some((o) => o.outcome === "unknown")
      ? "some_unknown"
      : "all_known";
