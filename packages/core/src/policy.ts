import { randomUUID } from "node:crypto";
import { operationError, type PolicyProvider } from "@cua/contracts";
export interface PolicyConfig {
  allow?: string[];
  deny?: string[];
  confirmFirstVisit?: boolean;
  confirmationTtlMs?: number;
}
export interface Confirmation {
  id: string;
  sessionId: string;
  origin: string;
  kind: string;
  expiresAt: number;
}
export class DefaultPolicyProvider implements PolicyProvider {
  private approvals = new Map<string, Set<string>>();
  private pending = new Map<string, Confirmation>();
  constructor(readonly config: PolicyConfig = {}) {}
  async check(
    url: string,
    { sessionId, kind }: { sessionId: string; kind: string },
  ): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw operationError("POLICY_BLOCKED", {
        message:
          "Invalid URL. Do not bypass policy using evaluate, raw CDP, or indirect access.",
      });
    }
    if (
      parsed.protocol === "file:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      url === "about:blank"
    )
      return;
    const origin = parsed.origin;
    if (
      this.config.deny?.includes(origin) ||
      (this.config.allow && !this.config.allow.includes(origin))
    )
      throw operationError("POLICY_BLOCKED", {
        message: `Origin ${origin} is blocked. Do not bypass using evaluate, raw CDP, or indirect access.`,
      });
    if (
      this.config.confirmFirstVisit &&
      !this.approvals.get(sessionId)?.has(origin)
    ) {
      const confirmation = {
        id: randomUUID(),
        sessionId,
        origin,
        kind,
        expiresAt: Date.now() + (this.config.confirmationTtlMs ?? 300000),
      };
      this.pending.set(confirmation.id, confirmation);
      throw operationError("POLICY_CONFIRMATION_REQUIRED", {
        message: `Ask the user to run cua approve ${confirmation.id} in their terminal. No operation was dispatched.`,
        diagnostics: { confirmationId: confirmation.id },
      });
    }
  }
  confirmation(id: string): Confirmation | undefined {
    const c = this.pending.get(id);
    if (c && c.expiresAt > Date.now()) return { ...c };
    this.pending.delete(id);
  }
  decide(id: string, approve: boolean): boolean {
    const c = this.confirmation(id);
    if (!c) return false;
    this.pending.delete(id);
    if (approve) {
      const origins = this.approvals.get(c.sessionId) ?? new Set();
      origins.add(c.origin);
      this.approvals.set(c.sessionId, origins);
    }
    return true;
  }
  closeSession(id: string): void {
    this.approvals.delete(id);
    for (const [key, value] of this.pending)
      if (value.sessionId === id) this.pending.delete(key);
  }
}
