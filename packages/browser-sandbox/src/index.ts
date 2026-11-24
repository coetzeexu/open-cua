import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectChromiumEndpoint } from "@cua/browser-chromium";
import {
  CONTRACT_VERSION,
  operationError,
  type BrowserProvider,
  type BrowserConnection,
  type OperationContext,
} from "@cua/contracts";

export interface SandboxBrowserOptions {
  /** Explicit loopback CDP URL, or use endpointEnv (default CUA_BROWSER_CDP_URL). */
  endpoint?: string;
  endpointEnv?: string;
  /** Total connection readiness budget, including retries. Default 30 seconds. */
  connectTimeoutMs?: number;
  /** Optional HTTPS desktop URL. Resolved in the service, never in the worker. */
  handoffUrlEnv?: string;
}

function endpointUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error();
    // Share the lease when profiles use equivalent IPv4 loopback addresses.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.href;
  } catch {
    throw Error(
      "Sandbox CDP endpoint must be a loopback HTTP(S) or WS(S) URL without userinfo or fragment.",
    );
  }
}

export function validateSandboxOptions(options: SandboxBrowserOptions = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw Error("Sandbox options must be an object.");
  if (options.endpoint !== undefined && options.endpointEnv !== undefined)
    throw Error("Configure sandbox endpoint or endpointEnv, not both.");
  if (options.endpoint !== undefined) endpointUrl(options.endpoint);
  for (const name of [options.endpointEnv, options.handoffUrlEnv]) {
    if (
      name !== undefined &&
      (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    )
      throw Error(
        "Sandbox environment variable names must be valid identifiers.",
      );
  }
  if (
    options.connectTimeoutMs !== undefined &&
    (!Number.isInteger(options.connectTimeoutMs) ||
      options.connectTimeoutMs < 1 ||
      options.connectTimeoutMs > 120_000)
  )
    throw Error(
      "Sandbox connectTimeoutMs must be an integer between 1 and 120000.",
    );
}

/** Connects to a browser owned by the sandbox launcher; never creates cloud resources. */
export class SandboxBrowserProvider implements BrowserProvider {
  readonly descriptor = {
    id: "sandbox",
    contractVersion: CONTRACT_VERSION,
    bindingKind: "chromium",
    capabilities: ["browser"],
  };
  readonly resourceKey: string;
  private readonly endpoint: string;
  private readonly handoffUrl?: string;
  private readonly timeoutMs: number;
  constructor(
    options: SandboxBrowserOptions = {},
    private readonly connector: typeof connectChromiumEndpoint = connectChromiumEndpoint,
  ) {
    validateSandboxOptions(options);
    const value =
      options.endpoint ??
      process.env[options.endpointEnv ?? "CUA_BROWSER_CDP_URL"];
    if (!value)
      throw Error(
        "Sandbox CDP endpoint is missing. Set CUA_BROWSER_CDP_URL or configure endpoint/endpointEnv.",
      );
    this.endpoint = endpointUrl(value);
    this.resourceKey = `cdp:${createHash("sha256").update(this.endpoint).digest("hex")}`;
    this.timeoutMs = options.connectTimeoutMs ?? 30_000;
    const handoff = options.handoffUrlEnv && process.env[options.handoffUrlEnv];
    if (handoff) {
      try {
        const url = new URL(handoff);
        if (url.protocol !== "https:" || url.username || url.password)
          throw Error();
        this.handoffUrl = url.href;
      } catch {
        throw Error("Sandbox handoff URL must use HTTPS without userinfo.");
      }
    }
  }
  async reconnect(context?: OperationContext): Promise<BrowserConnection> {
    return this.connect(context);
  }
  async connect(context?: OperationContext): Promise<BrowserConnection> {
    context?.check();
    const deadline =
      performance.now() +
      Math.min(this.timeoutMs, context?.timeoutMs ?? this.timeoutMs);
    while (performance.now() < deadline) {
      context?.check();
      let connection: BrowserConnection | undefined;
      try {
        connection = await this.connector(this.endpoint, {
          mode: "attach",
          existingContextOnly: true,
          timeoutMs: Math.max(1, Math.min(2000, deadline - performance.now())),
          handoff: this.handoffUrl
            ? async () => ({ kind: "url", url: this.handoffUrl })
            : undefined,
        });
        context?.check();
        if (performance.now() >= deadline)
          throw Error("Connection budget elapsed");
        return connection;
      } catch {
        // A late connection must not escape a cancelled or expired operation.
        await connection?.close().catch(() => {});
        context?.check();
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        try {
          await delay(Math.min(250, remaining), undefined, {
            signal: context?.signal,
          });
        } catch {
          context?.check();
          throw operationError("CONNECT_FAILED");
        }
      }
    }
    throw operationError("CONNECT_FAILED", {
      message:
        "Sandbox browser is not ready. Check the internal CDP endpoint and browser startup; no browser or cloud session was created.",
    });
  }
}
