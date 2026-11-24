import { createHash } from "node:crypto";
import type { RunnerErrorCode } from "./index.js";

export class RunnerFault extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
    readonly httpStatus = 422,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  code: RunnerErrorCode,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new RunnerFault(code, message, status);
}
export const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const id = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);
export const sha = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
/** Parse JSON while rejecting duplicate keys, non-finite numbers and excessive nesting. */
export function parseJSON(text: string): any {
  let i = 0;
  const fail = () => {
    throw new RunnerFault("INVALID_REQUEST", "Invalid or ambiguous JSON", 400);
  };
  const ws = () => {
    while (/[ \t\r\n]/.test(text[i] ?? "") && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          fail();
        }
      }
    }
    return fail();
  };
  const value = (depth: number): any => {
    if (depth > 100) return fail();
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++;
      ws();
      const result = Object.create(null);
      const keys = new Set<string>();
      if (text[i] === "}") {
        i++;
        return result;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key);
        ws();
        if (text[i++] !== ":") return fail();
        result[key] = value(depth + 1);
        ws();
        const c = text[i++];
        if (c === "}") return result;
        if (c !== ",") return fail();
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      const result: any[] = [];
      if (text[i] === "]") {
        i++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        ws();
        const c = text[i++];
        if (c === "]") return result;
        if (c !== ",") return fail();
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
    if (!match) return fail();
    i += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isFinite(result)) return fail();
    return result;
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail();
  return result;
}
export function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
) {
  requireValue(
    object(value) &&
      required.every((k) => Object.hasOwn(value, k)) &&
      Object.keys(value).every((k) => [...required, ...optional].includes(k)),
    "INVALID_REQUEST",
    "Invalid request fields",
    400,
  );
}
export function token(env: string | undefined): string | undefined {
  if (!env) return undefined;
  const value = process.env[env];
  requireValue(
    value && !/\s/.test(value),
    "INVALID_REQUEST",
    `Missing or invalid credential environment variable: ${env}`,
    500,
  );
  return value;
}
export async function bytes(response: Response, max: number): Promise<Buffer> {
  requireValue(
    Number(response.headers.get("content-length") ?? 0) <= max,
    "FILE_INVALID",
    "Response exceeds byte limit",
  );
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireValue(size <= max, "FILE_INVALID", "Response exceeds byte limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts);
}
export function endpoint(base: string, path: string): URL {
  return new URL(`${base.replace(/\/$/, "")}/${path}`);
}
export async function fetchBounded(
  url: URL,
  init: RequestInit,
  timeout: number,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    if (signal?.aborted)
      throw new RunnerFault("DEADLINE_EXCEEDED", "Run deadline exceeded");
    throw new RunnerFault(
      "SOURCE_UNAVAILABLE",
      "Configured service is unavailable",
      502,
    );
  }
}
