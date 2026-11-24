import type {
  CredentialRequest,
  SecureFormRequest,
  SecureFormState,
  SecureFormAnswer,
  HandoffRequest,
  UserChannel,
} from "@cua/contracts";
export type HumanRequestView =
  | SecureFormRequest
  | {
      type: "credentials";
      id: string;
      origin: string;
      fields: CredentialRequest["fields"];
      expiresAt: number;
    }
  | {
      type: "handoff";
      id: string;
      origin: string;
      reason?: string;
      kind: HandoffRequest["target"]["kind"];
      url?: string;
      expiresAt: number;
    };
const MAX_VALUE = 4096;
/**
 * Holds requests until the user answers through the private local control channel.
 * Credential values pass from the CLI to this object and then to the provider; never to the worker.
 */
export class PendingUserChannel implements UserChannel {
  private secureForms = new Map<
    string,
    {
      request: SecureFormRequest;
      state: SecureFormState;
      submissionId?: string;
      onAccept?: () => void;
      resolve?: (
        answer:
          | { action: "accept"; values: Record<string, string> }
          | { action: "decline" },
      ) => void;
    }
  >();
  collectSecureForm(
    request: SecureFormRequest,
    signal: AbortSignal,
    onAccept?: () => void,
  ) {
    return new Promise<
      | { action: "accept"; values: Record<string, string> }
      | { action: "decline" }
    >((resolve, reject) => {
      const state: SecureFormState = {
        requestId: request.id,
        operationId: request.id,
        sessionId: request.sessionId,
        scopeId: request.scopeId,
        executionId: request.executionId,
        schemaRevision: request.schemaRevision,
        status: "pending",
        confirmedFieldIds: [],
        uncertainFieldIds: [],
        businessOutcome: "unverified",
        actionOutcome: "not_dispatched",
        nextAction: "fill",
      };
      this.secureForms.set(request.id, {
        request: structuredClone(request),
        state,
        resolve,
        onAccept,
      });
      if (signal.aborted) {
        state.status = "cancelled";
        state.nextAction = "stop";
        this.secureForms.get(request.id)!.resolve = undefined;
        resolve({ action: "decline" });
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          const record = this.secureForms.get(request.id)!;
          if (record.state.status === "pending")
            this.updateSecureForm(request.id, {
              status: Date.now() >= request.expiresAt ? "expired" : "cancelled",
              nextAction: "stop",
            });
          record.resolve = undefined;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  secureFormState(id: string): SecureFormState | undefined {
    const r = this.secureForms.get(id);
    if (!r) return;
    if (r.state.status === "pending" && r.request.expiresAt <= Date.now()) {
      this.updateSecureForm(id, { status: "expired", nextAction: "stop" });
      r.resolve?.({ action: "decline" });
      r.resolve = undefined;
    }
    return structuredClone({
      ...r.state,
      ...(r.state.status === "pending" ? { request: r.request } : {}),
    });
  }
  updateSecureForm(id: string, patch: Partial<SecureFormState>) {
    const r = this.secureForms.get(id);
    if (!r) return;
    Object.assign(r.state, patch);
    if (!["pending", "accepted", "delivering"].includes(r.state.status))
      r.onAccept = undefined;
  }
  answerSecureForm(id: string, answer: SecureFormAnswer): SecureFormState {
    const state = this.secureFormState(id),
      r = this.secureForms.get(id);
    if (!state || !r) throw Error("Secure form unavailable.");
    if (state.status !== "pending") return state;
    if (answer.action === "decline") {
      r.resolve?.({ action: "decline" });
      r.resolve = undefined;
      this.updateSecureForm(id, { status: "cancelled", nextAction: "stop" });
      return this.secureFormState(id)!;
    }
    if (
      answer.schemaRevision !== r.request.schemaRevision ||
      typeof answer.submissionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(answer.submissionId)
    )
      throw Error("Secure form unavailable or invalid submission.");
    const values = answer.values;
    if (
      answer.action !== "submit" ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.keys(values).length !== r.request.fields.length
    )
      throw Error("Invalid secure form values.");
    const accepted: Record<string, string> = Object.create(null);
    for (const f of r.request.fields) {
      const v = Object.hasOwn(values, f.id) ? values[f.id] : undefined;
      if (
        typeof v !== "string" ||
        v.length > Math.min(f.maxLength ?? 4096, 4096) ||
        (f.required && !v.trim())
      )
        throw Error("Invalid secure form values.");
      if (v && f.control === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        throw Error("Invalid secure form values.");
      if (
        v &&
        f.control === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          !Number.isFinite(Date.parse(v)) ||
          new Date(v).toISOString().slice(0, 10) !== v ||
          (f.min && v < f.min) ||
          (f.max && v > f.max))
      )
        throw Error("Invalid secure form values.");
      if (f.control === "select" && !f.options?.some((o) => o.id === v))
        throw Error("Invalid secure form values.");
      accepted[f.id] = v;
    }
    try {
      r.onAccept?.();
    } catch {
      for (const key of Object.keys(accepted)) delete accepted[key];
      this.updateSecureForm(id, {
        status: "failed_before_write",
        nextAction: "human_review",
        reasonCode: "PROTECTION_UNAVAILABLE",
      });
      r.resolve?.({ action: "decline" });
      r.resolve = undefined;
      r.onAccept = undefined;
      return this.secureFormState(id)!;
    }
    r.onAccept = undefined;
    r.submissionId = answer.submissionId;
    this.updateSecureForm(id, { status: "accepted", nextAction: "wait" });
    r.resolve?.({ action: "accept", values: accepted });
    r.resolve = undefined;
    return this.secureFormState(id)!;
  }
  private credentials = new Map<
    string,
    {
      request: CredentialRequest;
      resolve: (
        value:
          | { action: "accept"; values: Record<string, string> }
          | { action: "decline" },
      ) => void;
    }
  >();
  private handoffs = new Map<
    string,
    {
      request: HandoffRequest;
      resolve: (value: "resumed" | "cancelled") => void;
    }
  >();
  collectCredentials(request: CredentialRequest, signal: AbortSignal) {
    return new Promise<
      | { action: "accept"; values: Record<string, string> }
      | { action: "decline" }
    >((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      this.credentials.set(request.id, { request, resolve });
      signal.addEventListener(
        "abort",
        () => {
          this.credentials.delete(request.id);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  handoff(request: HandoffRequest, signal: AbortSignal) {
    return new Promise<"resumed" | "cancelled">((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      this.handoffs.set(request.id, { request, resolve });
      signal.addEventListener(
        "abort",
        () => {
          this.handoffs.delete(request.id);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  inspect(id: string): HumanRequestView | undefined {
    const secure = this.secureFormState(id);
    if (secure?.request) return secure.request;
    const c = this.credentials.get(id);
    if (c && c.request.expiresAt > Date.now())
      return {
        type: "credentials",
        id,
        origin: c.request.origin,
        fields: c.request.fields.map((f) => ({ ...f })),
        expiresAt: c.request.expiresAt,
      };
    const h = this.handoffs.get(id);
    if (h && h.request.expiresAt > Date.now())
      return {
        type: "handoff",
        id,
        origin: h.request.origin,
        reason: h.request.reason,
        kind: h.request.target.kind,
        url: h.request.target.url,
        expiresAt: h.request.expiresAt,
      };
  }
  submitCredentials(id: string, values: unknown): boolean {
    const c = this.credentials.get(id);
    if (!c || c.request.expiresAt <= Date.now()) return false;
    if (!values || typeof values !== "object") return false;
    const accepted: Record<string, string> = {};
    for (const field of c.request.fields) {
      const value = (values as Record<string, unknown>)[field.id];
      if (typeof value !== "string" || value.length > MAX_VALUE) return false;
      accepted[field.id] = value;
    }
    if (Object.keys(values).length !== c.request.fields.length) return false;
    this.credentials.delete(id);
    c.resolve({ action: "accept", values: accepted });
    return true;
  }
  decline(id: string): boolean {
    const c = this.credentials.get(id);
    if (c) {
      this.credentials.delete(id);
      c.resolve({ action: "decline" });
      return true;
    }
    const h = this.handoffs.get(id);
    if (h) {
      this.handoffs.delete(id);
      h.resolve("cancelled");
      return true;
    }
    return false;
  }
  resume(id: string): boolean {
    const h = this.handoffs.get(id);
    if (!h || h.request.expiresAt <= Date.now()) return false;
    this.handoffs.delete(id);
    h.resolve("resumed");
    return true;
  }
  listForSession(sessionId: string) {
    return [
      ...this.credentials.values(),
      ...this.handoffs.values(),
      ...this.secureForms.values(),
    ]
      .filter((v) => v.request.sessionId === sessionId)
      .map((v) => this.inspect(v.request.id))
      .filter((v) => v !== undefined);
  }
  pending() {
    return {
      credentials: this.credentials.size,
      handoffs: this.handoffs.size,
    };
  }
}
