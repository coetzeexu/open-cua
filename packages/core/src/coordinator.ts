import { randomUUID } from "node:crypto";
import {
  CuaError,
  operationError,
  type OperationContext,
  type OperationResult,
  type Phase,
  type TabBinding,
} from "@cua/contracts";
interface Scope {
  closed: boolean;
  controllers: Set<AbortController>;
  operations: OperationResult[];
  lifetime: AbortController;
}
interface Lane {
  tail: Promise<void>;
  pending: number;
  quarantined: boolean;
}
export class OperationCoordinator {
  private observers = new Set<
    (scopeId: string, event: Partial<OperationResult>) => void
  >();
  observe(
    listener: (scopeId: string, event: Partial<OperationResult>) => void,
  ) {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  private emit(scopeId: string, event: Partial<OperationResult>) {
    for (const listener of this.observers) {
      try {
        listener(scopeId, structuredClone(event));
      } catch {
        /* Observability must not change action outcome. */
      }
    }
  }
  private scopes = new Map<string, Scope>();
  private closedScopes = new Set<string>();
  private lanes = new Map<string, Lane>();
  constructor(
    private options: { hardExtraMs?: number; dialogGraceMs?: number } = {},
  ) {}
  openScope(id = randomUUID()): string {
    if (this.scopes.has(id)) throw Error("Scope IDs cannot be reused");
    this.scopes.set(id, {
      closed: false,
      controllers: new Set(),
      operations: [],
      lifetime: new AbortController(),
    });
    return id;
  }
  /** Aborts when the scope closes; used for waits that are not browser operations. */
  scopeSignal(id: string): AbortSignal {
    const s = this.scopes.get(id);
    if (!s || s.closed) return AbortSignal.abort();
    return s.lifetime.signal;
  }
  check(id: string): void {
    const s = this.scopes.get(id);
    if (!s)
      throw operationError(
        this.closedScopes.has(id) ? "SCOPE_CLOSED" : "SCOPE_UNKNOWN",
      );
    if (s.closed) throw operationError("SCOPE_CLOSED");
  }
  closeScope(id: string): void {
    const s = this.scopes.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    this.closedScopes.add(id);
    s.lifetime.abort();
    for (const c of s.controllers) c.abort();
  }
  state(tabId: string) {
    const lane = this.lanes.get(tabId);
    return lane?.quarantined
      ? ("quarantined" as const)
      : lane?.pending
        ? ("busy" as const)
        : ("ready" as const);
  }
  hasPendingOperations(): boolean {
    return [...this.scopes.values()].some((s) => s.controllers.size > 0);
  }
  isSettled(id: string): boolean {
    return !this.scopes.get(id)?.controllers.size;
  }
  operations(id: string): OperationResult[] {
    return this.scopes.get(id)?.operations ?? [];
  }
  recordFailure(
    scopeId: string,
    kind: string,
    tabId: string | undefined,
    error: CuaError,
  ): CuaError {
    if (error.diagnostics?.operationId) return error;
    const operationId = randomUUID();
    const tagged = new CuaError(
      { ...error.toJSON(), diagnostics: { ...error.diagnostics, operationId } },
      { phase: error.phase ?? "dispatch", outcome: error.outcome ?? "unknown" },
    );
    this.scopes.get(scopeId)?.operations.push({
      operationId,
      kind,
      tabId,
      status: "failed",
      phase: tagged.phase!,
      outcome: tagged.outcome!,
      error: tagged.toJSON(),
    });
    return tagged;
  }
  forget(id: string): void {
    const s = this.scopes.get(id);
    if (s?.closed && !s.controllers.size) this.scopes.delete(id);
  }
  async run<T>(
    options: {
      scopeId: string;
      sessionId: string;
      generation: number;
      kind: string;
      tab?: TabBinding;
      timeoutMs: number;
      readOnly?: boolean;
      /** Suppress provider/page diagnostics on private delivery paths. */
      private?: boolean;
      policy: OperationContext["policy"];
      validate?: () => Promise<void>;
    },
    work: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const { scopeId, tab, kind } = options;
    const result: OperationResult = {
      operationId: randomUUID(),
      kind,
      tabId: tab?.id,
      status: "failed",
      phase: "before_dispatch",
      outcome: "not_executed",
    };
    const scope = this.scopes.get(scopeId);
    scope?.operations.push(result);
    this.emit(scopeId, {
      operationId: result.operationId,
      kind,
      tabId: tab?.id,
      phase: "before_dispatch",
    });
    const fail = (error: CuaError) => {
      if (options.private) error = operationError("ACTION_OUTCOME_UNKNOWN");
      Object.assign(result, {
        status: error.code === "OPERATION_CANCELLED" ? "cancelled" : "failed",
        phase: error.phase ?? "dispatch",
        outcome: error.outcome ?? "unknown",
        error: {
          ...error.toJSON(),
          diagnostics: {
            ...error.diagnostics,
            operationId: result.operationId,
          },
        },
      });
      this.emit(scopeId, result);
      return new CuaError(result.error!, {
        phase: result.phase,
        outcome: result.outcome,
      });
    };
    try {
      this.check(scopeId);
    } catch (e) {
      throw fail(e as CuaError);
    }
    const controller = new AbortController();
    scope!.controllers.add(controller);
    let phase: Phase = "before_dispatch";
    let callerEnded = false;
    let underlyingSettled = false;
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const response = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const end = (error: CuaError, abandoned = false) => {
      if (callerEnded) return;
      callerEnded = true;
      const tagged = fail(error);
      if (abandoned) {
        result.status = "abandoned";
        this.emit(scopeId, result);
      }
      reject(tagged);
    };
    const onAbort = () =>
      end(
        operationError("OPERATION_CANCELLED", {
          phase: phase === "before_dispatch" ? "before_dispatch" : "dispatch",
        }),
        phase !== "before_dispatch",
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let releaseQuarantine!: () => void;
    const quarantined = new Promise<void>((resolve) => {
      releaseQuarantine = resolve;
    });
    const lane = tab
      ? (this.lanes.get(tab.id) ?? {
          tail: Promise.resolve(),
          pending: 0,
          quarantined: false,
        })
      : undefined;
    if (tab && lane) this.lanes.set(tab.id, lane);
    // Dialog and quarantine checks happen before queueing as well as at dispatch.
    const checkTab = () => {
      if (lane?.quarantined && kind !== "tab.close")
        throw operationError("TAB_QUARANTINED");
      if (tab?.dialog())
        throw operationError("DIALOG_PENDING", {
          diagnostics: { dialog: tab.dialog() },
        });
    };
    try {
      checkTab();
    } catch (e) {
      scope!.controllers.delete(controller);
      throw fail(e as CuaError);
    }
    const setHard = (ms: number) => {
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = setTimeout(() => {
        if (!underlyingSettled && lane) {
          lane.quarantined = true;
          tab?.quarantine();
          releaseQuarantine();
        }
      }, ms);
      hardTimer.unref();
    };
    const context: OperationContext = {
      sessionId: options.sessionId,
      generation: options.generation,
      scopeId,
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
      check: () => {
        this.check(scopeId);
        if (controller.signal.aborted)
          throw operationError("OPERATION_CANCELLED", {
            phase: phase === "before_dispatch" ? "before_dispatch" : "dispatch",
          });
        checkTab();
      },
      dispatch: () => {
        context.check();
        phase = "dispatch";
        this.emit(scopeId, {
          operationId: result.operationId,
          kind,
          tabId: tab?.id,
          phase,
        });
      },
      afterDispatch: () => {
        phase = "after_dispatch";
        this.emit(scopeId, {
          operationId: result.operationId,
          kind,
          tabId: tab?.id,
          phase,
        });
      },
      policy: options.policy,
    };
    const task = async () => {
      if (callerEnded) {
        scope!.controllers.delete(controller);
        controller.signal.removeEventListener("abort", onAbort);
        return;
      }
      try {
        context.check();
        await options.validate?.();
        context.check();
        if (tab)
          unsubscribe = tab.onDialog((dialog) => {
            if (dialog) {
              if (hardTimer) clearTimeout(hardTimer);
              end(
                operationError("INTERRUPTED_BY_DIALOG", {
                  diagnostics: { dialog },
                }),
                true,
              );
            } else if (!underlyingSettled)
              setHard(this.options.dialogGraceMs ?? 5000);
          });
        setHard(options.timeoutMs + (this.options.hardExtraMs ?? 15000));
        deadline = setTimeout(() => {
          end(
            operationError(
              kind === "evaluate" || kind === "waitForFunction"
                ? "EVALUATE_ABANDONED"
                : "OPERATION_TIMEOUT",
              {
                phase:
                  kind === "evaluate" || kind === "waitForFunction"
                    ? "dispatch"
                    : phase === "before_dispatch"
                      ? "before_dispatch"
                      : "dispatch",
              },
            ),
            true,
          );
          controller.abort();
        }, options.timeoutMs);
        const value = await work(context);
        if (!callerEnded) {
          callerEnded = true;
          Object.assign(result, {
            status: "succeeded",
            phase:
              phase === "before_dispatch"
                ? "before_dispatch"
                : "after_dispatch",
            outcome: phase === "before_dispatch" ? "not_executed" : "executed",
          });
          this.emit(scopeId, result);
          resolve(value);
        }
      } catch (e) {
        if (!callerEnded)
          end(
            e instanceof CuaError &&
              !(phase !== "before_dispatch" && e.phase === "before_dispatch")
              ? e
              : operationError("ACTION_OUTCOME_UNKNOWN", {
                  message:
                    "Browser operation failed; observe before deciding the next action.",
                }),
          );
      } finally {
        underlyingSettled = true;
        clearTimeout(deadline);
        clearTimeout(hardTimer);
        unsubscribe?.();
        scope!.controllers.delete(controller);
        controller.signal.removeEventListener("abort", onAbort);
      }
    };
    if (lane && !options.readOnly && kind !== "tab.close") {
      lane.pending++;
      const prior = lane.tail;
      lane.tail = Promise.race([prior.then(task), quarantined]).finally(() => {
        lane.pending--;
      });
    } else void task();
    return response;
  }
}
