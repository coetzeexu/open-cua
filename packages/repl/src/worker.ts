import { randomUUID } from "node:crypto";
import { createHook } from "node:async_hooks";
import {
  CuaError,
  createFacade,
  executionError,
  operationError,
  type ParentMessage,
  type WorkerMessage,
  type SerializedError,
} from "@cua/contracts";
import { ReplKernel, type CellScope } from "./kernel.js";
const send = (message: WorkerMessage) => {
  if (process.connected) process.send!(message);
};
interface Scope extends CellScope {
  pending: Set<Promise<unknown>>;
  ended: boolean;
  error?: SerializedError;
}
const scopes = new Map<string, Scope>();
const pending = new Map<
  string,
  { scope: Scope; resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
let identity = { sessionId: "", generation: 0 };
const provenance = new WeakMap<object, { id: string; json: string }>();
const promiseScopes = new WeakMap<object, Scope>();
const toError = (e: unknown): SerializedError =>
  e instanceof CuaError && e.level === "execution"
    ? e.toJSON()
    : executionError(
        "USER_CODE_ERROR",
        "none",
        e instanceof Error ? e.message : String(e),
      ).toJSON();
const recordError = (scope: Scope | undefined, error: unknown) => {
  if (scope && !scope.closed) {
    scope.error = toError(error);
  } else
    send({
      type: "warning",
      warning: {
        code: "ORPHAN_ERROR",
        scopeId: scope?.id,
        message: toError(error).message,
        orphan: true,
      },
    });
};
const invoke = (method: string, args: unknown[], tabId?: string) => {
  const scope = kernel.als.getStore() as Scope | undefined;
  if (!scope) return Promise.reject(operationError("SCOPE_UNKNOWN"));
  if (scope.closed) {
    send({
      type: "warning",
      warning: {
        code: "SCOPE_CLOSED",
        scopeId: scope.id,
        message: "A late SDK call was rejected.",
        orphan: true,
      },
    });
    return Promise.reject(operationError("SCOPE_CLOSED"));
  }
  const id = randomUUID();
  const promise = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { scope, resolve, reject });
    send({
      type: "sdk",
      id,
      request: { method, args, tabId, ...identity, scopeId: scope.id },
    });
  });
  scope.pending.add(promise);
  promise.then(
    (value) => {
      scope.pending.delete(promise);
      if (value && typeof value === "object" && "observationId" in value)
        provenance.set(value, {
          id: String(value.observationId),
          json: JSON.stringify(value),
        });
    },
    () => scope.pending.delete(promise),
  );
  // The returned branch intentionally has no rejection handler. Node reports genuinely unhandled SDK errors.
  return promise.then((v) => v);
};
const emit = (kind: "text" | "json" | "image", value: unknown) => {
  const scope = kernel.als.getStore() as Scope | undefined;
  if (!scope || scope.closed) {
    send({
      type: "warning",
      warning: {
        code: "ORPHAN_OUTPUT",
        scopeId: scope?.id,
        message: "Console/output from a finished cell was omitted.",
        orphan: true,
      },
    });
    return;
  }
  const original =
    value && typeof value === "object" ? provenance.get(value) : undefined;
  const observationId =
    original && original.json === JSON.stringify(value)
      ? original.id
      : undefined;
  send({
    type: "output",
    scopeId: scope.id,
    kind,
    value: { value, observationId },
  });
};
const kernel = new ReplKernel({
  globals: {
    cua: createFacade(invoke, () => identity),
    output: {
      text: (v: unknown) => emit("text", v),
      json: (v: unknown) => emit("json", v),
      image: (v: unknown) => emit("image", v),
    },
    console: Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map((level) => [
        level,
        (...args: unknown[]) =>
          emit(
            "text",
            args
              .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
              .join(" "),
          ),
      ]),
    ),
  },
  warning: (warning) => send({ type: "warning", warning }),
  callbackError: (scope, error) =>
    recordError(scope as Scope | undefined, error),
});
createHook({
  init(_id, type, _trigger, resource) {
    if (type === "PROMISE") {
      const scope = kernel.als.getStore();
      if (scope) promiseScopes.set(resource, scope as Scope);
    }
  },
}).enable();
process.on("unhandledRejection", (error, promise) =>
  recordError(promiseScopes.get(promise), error),
);
process.on("uncaughtException", (error) => {
  send({
    type: "fault",
    message: `Worker uncaught exception: ${error.message}`,
  });
  setTimeout(() => process.exit(1), 20);
});
process.on("disconnect", () => {
  kernel.dispose();
  process.exit(0);
});
process.on("message", (message: ParentMessage) => {
  if (message.type === "ping") {
    send({ type: "ready" });
    return;
  }
  if (message.type === "shutdown") {
    kernel.dispose();
    process.exit(0);
  }
  if (message.type === "sdkResult") {
    if (message.generation !== undefined)
      identity.generation = Math.max(identity.generation, message.generation);
    const p = pending.get(message.id);
    if (p) {
      pending.delete(message.id);
      if (message.error) p.reject(new CuaError(message.error));
      else p.resolve(message.value);
    }
    return;
  }
  if (message.type === "closeScope") {
    const scope = scopes.get(message.scopeId);
    if (scope) {
      scope.closed = true;
      for (const [id, p] of pending)
        if (p.scope === scope) {
          pending.delete(id);
          p.reject(operationError("OPERATION_CANCELLED"));
        }
    }
    return;
  }
  if (message.type === "execute") {
    identity = { sessionId: message.sessionId, generation: message.generation };
    const scope: Scope = {
      id: message.scopeId,
      closed: false,
      ended: false,
      pending: new Set(),
    };
    scopes.set(scope.id, scope);
    void (async () => {
      try {
        await kernel.execute(message.code, scope);
      } catch (e) {
        scope.error = toError(e);
      } finally {
        scope.ended = true;
        send({ type: "moduleEnded", scopeId: scope.id, error: scope.error });
      }
      while (scope.pending.size && !scope.closed)
        await Promise.allSettled([...scope.pending]);
      await new Promise((resolve) => setImmediate(resolve));
      scope.closed = true;
      send({ type: "drained", scopeId: scope.id, error: scope.error });
    })().catch((e) => send({ type: "fault", message: String(e) }));
  }
});
send({ type: "ready" });
