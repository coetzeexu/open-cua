import { randomUUID } from "node:crypto";
import {
  operationError,
  type SecureFormControl,
  type Target,
  type SecureFormState,
} from "@cua/contracts";
const bad = () =>
  operationError("INVALID_ARGUMENT", {
    message:
      "Invalid secure form schema. Use native controls and fill-only delivery; unsupported forms require human handoff.",
  });
export function parseSecureForm(
  raw: unknown,
  sessionId: string,
  generation: number,
  tabId: string,
) {
  const r = raw as Record<string, any>;
  const exact = (v: any, keys: string[]) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !keys.includes(k))
    )
      throw bad();
  };
  const id = (s: any) => {
    if (
      typeof s !== "string" ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(s) ||
      ["constructor", "prototype", "__proto__"].includes(s)
    )
      throw bad();
    return s as string;
  };
  const label = (s: any) => {
    if (typeof s !== "string" || !s.trim() || s.length > 120) throw bad();
    return s.trim();
  };
  exact(r, ["title", "groups", "fields", "delivery", "timeoutMs"]);
  const title = label(r.title);
  if (r.delivery) {
    exact(r.delivery, ["mode"]);
    if (r.delivery.mode !== "fill") throw bad();
  }
  if (
    r.timeoutMs !== undefined &&
    (!Number.isFinite(r.timeoutMs) || r.timeoutMs <= 0)
  )
    throw bad();
  if (r.groups !== undefined && !Array.isArray(r.groups)) throw bad();
  const groups = (r.groups ?? []).map((g: any) => {
    exact(g, ["id", "label"]);
    return { id: id(g.id), label: label(g.label) };
  }) as { id: string; label: string }[];
  if (
    groups.length > 20 ||
    new Set(groups.map((g) => g.id)).size !== groups.length
  )
    throw bad();
  if (!Array.isArray(r.fields) || r.fields.length < 1 || r.fields.length > 20)
    throw bad();
  const fields = r.fields.map((f: any) => {
    exact(f, ["id", "label", "control", "target", "groupId", "masked"]);
    if (
      !["text", "email", "tel", "password", "date", "select"].includes(
        f.control,
      ) ||
      (f.masked !== undefined && typeof f.masked !== "boolean")
    )
      throw bad();
    if (f.groupId !== undefined && !groups.some((g) => g.id === f.groupId))
      throw bad();
    const t = f.target as Target;
    if (!t || !["ref", "locator"].includes(t.type)) throw bad();
    if (
      t.sessionId !== sessionId ||
      t.generation !== generation ||
      t.tabId !== tabId
    )
      throw operationError("HANDLE_STALE");
    return {
      id: id(f.id),
      label: label(f.label),
      control: f.control as SecureFormControl,
      target: structuredClone(t),
      ...(f.groupId ? { groupId: f.groupId as string } : {}),
      masked: f.control === "password" || f.masked === true,
    };
  });
  if (new Set(fields.map((f: any) => f.id)).size !== fields.length) throw bad();
  return {
    title,
    groups,
    fields,
    timeoutMs: Math.min(r.timeoutMs ?? 300000, 900000),
    schemaRevision: randomUUID(),
  };
}
/** A model-safe whitelist; excludes schema labels, option values, and origin. */
export function secureFormPublicState(s: SecureFormState): SecureFormState {
  return {
    requestId: s.requestId,
    operationId: s.operationId,
    sessionId: s.sessionId,
    scopeId: s.scopeId,
    ...(s.executionId ? { executionId: s.executionId } : {}),
    schemaRevision: s.schemaRevision,
    status: s.status,
    confirmedFieldIds: [...s.confirmedFieldIds],
    uncertainFieldIds: [...s.uncertainFieldIds],
    businessOutcome: "unverified",
    actionOutcome: "not_dispatched",
    nextAction: s.nextAction,
    ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
  };
}
