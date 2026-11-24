import { randomUUID } from "node:crypto";
import {
  CuaError,
  CONTRACT_VERSION,
  createFacade,
  operationError,
  type CUA,
  type BrowserProvider,
  type BrowserConnection,
  type Capabilities,
  type TargetResolver,
  type PolicyProvider,
  type SDKRequest,
  type Handle,
  type TabBinding,
  type AXCapability,
  type DOMCapability,
  type ScreenshotCapability,
  type ActionCapability,
  type Snapshot,
  type Screenshot,
  type Target,
  type OperationContext,
  type UserChannel,
  type Warning,
  type ResolvedTarget,
  type FrameInfo,
  type TargetDescription,
  type SecureFormRequest,
} from "@cua/contracts";
import { parseSecureForm, secureFormPublicState } from "./secure-form.js";
import { OperationCoordinator } from "./coordinator.js";
import { DefaultPolicyProvider } from "./policy.js";
export interface CUAOptions {
  browser: BrowserProvider;
  capabilities: Capabilities;
  targetResolvers: TargetResolver[];
  policy?: PolicyProvider;
  sessionId?: string;
  operationTimeoutMs?: number;
  coordinator?: OperationCoordinator;
  imageCacheBytes?: number;
  /** require (default): model code may not write into password/OTP fields. */
  credentials?: { mode?: "require" | "allow"; requestTtlMs?: number };
  /** Reaches the human user out of band. Without it, secure input and handoff are unavailable. */
  userChannel?: UserChannel;
  /** Host-owned opaque execution association retained with private receipts. */
  executionIdForScope?: (scopeId: string) => string | undefined;
  /** Synchronous durable protection marker; throwing refuses delivery. Never invoked on restoration. */
  onSecureFormAccepted?: () => void;
  handoffTtlMs?: number;
  onBlocked?: (report: BlockedReport) => void;
  /** Called while a request waits for the user, so hosts can pause cell timers and idle reaping. */
  onUserWait?: (scopeId: string, waiting: boolean) => void;
  /** Called with a user-facing instruction; the text contains no secret values. */
  onUserNotice?: (scopeId: string, warning: Warning) => void;
}
export interface BlockedReport {
  hostname: string | null;
  reason: string;
  time: number;
}
const BLOCK_REASONS = [
  "captcha_failed",
  "access_denied",
  "challenge_loop",
  "unexpected_bot_error",
];
const PROTECTED_METHODS = [
  "dom.snapshot",
  "dom.inspect",
  "screenshot.capture",
  "evaluate",
  "waitForFunction",
  "devLogs",
];
const HANDOFF_ALLOWED = [
  "info",
  "handoff.wait",
  "handoff.status",
  "dialogs.pending",
  "dialogs.respond",
  "tab.close",
  "markDeliverable",
];
interface Bound {
  ax?: AXCapability;
  dom?: DOMCapability;
  screenshot?: ScreenshotCapability;
  action?: ActionCapability;
}
export class CUAEngine {
  readonly sessionId: string;
  generation = 0;
  readonly coordinator: OperationCoordinator;
  readonly policy: PolicyProvider;
  private connection?: BrowserConnection;
  private connecting?: Promise<BrowserConnection>;
  private bound = new Map<string, Bound>();
  private snapshots = new Map<
    string,
    { tabId: string; epoch: number; snapshot: Snapshot }
  >();
  private delivered = new Map<string, string>();
  /** Session-wide guard for generic private data, including later documents. */
  private secureFlowProtected = false;
  private secureFormWaiting = false;
  isSecureFormProtected() {
    return this.secureFlowProtected;
  }
  enforceSecureFormProtection() {
    this.secureFlowProtected = true;
    this.snapshots.clear();
    this.images.clear();
  }
  private secureFormGuard(method: string) {
    if (
      (this.secureFlowProtected || this.secureFormWaiting) &&
      ![
        "connect",
        "tabs.list",
        "tabs.get",
        "close",
        "tab.close",
        "secureForm.status",
        "handoff.request",
        "handoff.wait",
        "handoff.status",
      ].includes(method)
    )
      throw operationError("SECURE_FORM_PROTECTED", {
        message:
          "This private workflow permits only status, human handoff, and close. Navigation or reset does not release protection.",
      });
  }
  /** tabId → frameId → frame epoch for the legacy credential path. */
  private protectedFrames = new Map<string, Map<string, number>>();
  private handoffs = new Map<
    string,
    {
      id: string;
      kind: string;
      wait: Promise<"resumed" | "expired" | "cancelled">;
      abort: AbortController;
      status: "active" | "resumed" | "expired" | "cancelled";
    }
  >();
  readonly blocked: BlockedReport[] = [];
  readonly images = new Map<
    string,
    { metadata: Screenshot; bytes: Uint8Array }
  >();
  constructor(readonly options: CUAOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.coordinator = options.coordinator ?? new OperationCoordinator();
    this.policy = options.policy ?? new DefaultPolicyProvider();
  }
  private handle(type: "tab" | "browser", id: string): Handle {
    return {
      __cuaHandle: type,
      id,
      sessionId: this.sessionId,
      generation: this.generation,
    };
  }
  async connect(context?: OperationContext): Promise<BrowserConnection> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOrRecover(context);
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async connectOrRecover(context?: OperationContext) {
    let recovering = false;
    if (this.connection) {
      try {
        await this.connection.health();
        return this.connection;
      } catch (error) {
        if (
          !(error instanceof CuaError) ||
          error.code !== "BROWSER_DISCONNECTED" ||
          !this.options.browser.reconnect
        )
          throw error;
        // Do not close an external browser: close may delete resources or tabs.
        // Old references must never silently target the replacement connection.
        this.connection = undefined;
        this.reset();
        for (const handoff of this.handoffs.values()) handoff.abort.abort();
        this.handoffs.clear();
        recovering = true;
      }
    }
    let connection: BrowserConnection | undefined;
    try {
      context?.check();
      connection = recovering
        ? await this.options.browser.reconnect!(context)
        : await this.options.browser.connect(context);
      await connection.health();
      context?.check();
      this.connection = connection;
      return connection;
    } catch (error) {
      await connection?.close().catch(() => {});
      throw error instanceof CuaError
        ? error
        : operationError("CONNECT_FAILED");
    }
  }
  async close() {
    const connection =
      this.connection ?? (await this.connecting?.catch(() => undefined));
    if (!connection) return;
    await connection.close();
    this.connection = undefined;
    this.reset();
    this.policy.closeSession?.(this.sessionId);
  }
  reset() {
    this.generation++;
    this.bound.clear();
    this.delivered.clear();
    this.snapshots.clear();
    this.images.clear();
    // Protection and handoff describe the live page, which outlives a REPL reset.
  }
  /** Host-only: human input is private; retain protection until the document changes. */
  async openHumanView(tabId: string) {
    if (!this.connection?.openHumanView)
      throw Error("Connect a supported browser first.");
    return this.connection.openHumanView(tabId);
  }
  async protectHumanPages() {
    if (!this.connection) return;
    for (const tab of await this.connection.tabs()) {
      await this.protectHumanTab(tab);
    }
    this.reset();
  }
  private async protectHumanTab(tab: TabBinding) {
    this.protectedFrames.set(
      tab.id,
      new Map((await tab.frames()).map((f) => [f.id, f.epoch])),
    );
    await tab.invalidate();
  }
  /** True while a person controls a tab or a credential prompt is outstanding. */
  waitingForUser() {
    return [...this.handoffs.values()].some((h) => h.status === "active");
  }
  private async isProtected(tab: TabBinding) {
    const frames = this.protectedFrames.get(tab.id);
    if (!frames?.size) return false;
    const live = new Map((await tab.frames()).map((f) => [f.id, f.epoch]));
    for (const [id, epoch] of frames)
      if (live.get(id) !== epoch) frames.delete(id);
    if (!frames.size) {
      this.protectedFrames.delete(tab.id);
      return false;
    }
    return true;
  }
  private handoffActive(tabId: string) {
    return this.handoffs.get(tabId)?.status === "active";
  }
  private checkHandoff(tab: TabBinding, method: string) {
    if (this.handoffActive(tab.id) && !HANDOFF_ALLOWED.includes(method))
      throw operationError("TAB_HANDED_OFF", {
        message:
          "A person controls this tab. Wait with tab.handoff.wait(); do not act on intermediate state.",
      });
  }
  describe() {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      connected: !!this.connection,
      capabilities: Object.keys(this.options.capabilities),
      binding: this.options.browser.descriptor.bindingKind,
      credentials: this.options.credentials?.mode ?? "require",
      secureInput: !!this.options.userChannel,
      handoff: !!this.options.userChannel && !!this.connection?.handoff,
      blocked: this.blocked.slice(-20),
    };
  }
  async health() {
    if (!this.connection)
      return { browser: "not_connected", cdp: "not_connected" };
    try {
      await this.connection.health();
      return { browser: "healthy", cdp: "healthy" };
    } catch (error) {
      return {
        browser: "unhealthy",
        cdp: "unhealthy",
        error:
          error instanceof CuaError
            ? error.toJSON()
            : operationError("BROWSER_DISCONNECTED").toJSON(),
      };
    }
  }
  markDelivered(observationId: string) {
    const s = this.snapshots.get(observationId);
    if (s) this.delivered.set(s.tabId, observationId);
  }
  private async bind(tab: TabBinding) {
    const cached = this.bound.get(tab.id);
    if (cached) return cached;
    const result: Bound = {};
    for (const [key, p] of Object.entries(this.options.capabilities)) {
      if (!p) continue;
      if (
        p.descriptor.bindingKind !== tab.kind ||
        p.descriptor.contractVersion !== CONTRACT_VERSION
      )
        throw operationError("CAPABILITY_UNAVAILABLE", {
          message: `Provider ${p.descriptor.id} is incompatible with binding ${tab.kind}`,
        });
    }
    try {
      for (const [key, p] of Object.entries(this.options.capabilities)) {
        if (p) {
          for (const dependency of p.descriptor.dependencies ?? [])
            if (!(dependency in this.options.capabilities))
              throw operationError("CAPABILITY_UNAVAILABLE", {
                message: `Provider ${p.descriptor.id} requires ${dependency}.`,
              });
          (result as Record<string, unknown>)[key] = await p.bind({
            binding: tab,
            sessionId: this.sessionId,
            generation: this.generation,
          });
        }
      }
    } catch (error) {
      await Promise.all(
        Object.values(result).map((capability) =>
          (capability as { dispose?: () => Promise<void> })
            .dispose?.()
            .catch(() => {}),
        ),
      );
      throw error;
    }
    this.bound.set(tab.id, result);
    return result;
  }
  async dispatch(request: SDKRequest): Promise<unknown> {
    try {
      const result = await this.performDispatch(request);
      // A request started before protection may resolve afterward on another tab lane.
      if (this.secureFlowProtected && request.method !== "secureForm.request")
        this.secureFormGuard(request.method);
      return result;
    } catch (error) {
      throw this.coordinator.recordFailure(
        request.scopeId,
        request.method,
        request.tabId,
        this.secureFlowProtected &&
          !(error instanceof CuaError && error.code === "SECURE_FORM_PROTECTED")
          ? operationError("ACTION_OUTCOME_UNKNOWN")
          : error instanceof CuaError
            ? error
            : operationError("ACTION_OUTCOME_UNKNOWN"),
      );
    }
  }
  private async performDispatch(request: SDKRequest): Promise<unknown> {
    const { method, scopeId } = request;
    this.secureFormGuard(method);
    this.coordinator.check(scopeId);
    if (
      request.sessionId !== this.sessionId ||
      request.generation !== this.generation
    )
      throw operationError("HANDLE_STALE");
    const args = [...request.args];
    const browserHandle = (args[0] as { __browser?: Handle } | undefined)
      ?.__browser;
    if (browserHandle) {
      args.shift();
      if (
        browserHandle.sessionId !== this.sessionId ||
        browserHandle.generation !== this.generation ||
        browserHandle.id !== this.connection?.id
      )
        throw operationError("HANDLE_STALE");
    }
    let tab: TabBinding | undefined;
    if (request.tabId) {
      const wrapper = args.shift() as { __handle?: Handle } | undefined;
      const h = wrapper?.__handle;
      if (
        !h ||
        h.sessionId !== this.sessionId ||
        h.generation !== this.generation ||
        h.id !== request.tabId
      )
        throw operationError("HANDLE_STALE");
      if (!this.connection) throw operationError("HANDLE_STALE");
      tab = await this.connection.get(request.tabId);
    }
    const policy = async (url: string, kind = method) => {
      try {
        await this.policy.check(url, { sessionId: this.sessionId, kind });
      } catch (error) {
        throw error instanceof CuaError
          ? error
          : operationError("POLICY_UNAVAILABLE");
      }
    };
    const target = args[0] as Target | undefined;
    const validate = async () => {
      if (method !== "secureForm.request") this.secureFormGuard(method);
      this.coordinator.check(scopeId);
      if (request.generation !== this.generation)
        throw operationError("HANDLE_STALE");
      if (tab) {
        this.checkHandoff(tab, method);
        const info = await tab.info();
        if (info.state === "closed") throw operationError("TAB_CLOSED");
        if (info.state === "quarantined" && method !== "tab.close")
          throw operationError("TAB_QUARANTINED");
        if (
          ![
            "goto",
            "reload",
            "back",
            "forward",
            "tab.close",
            "markDeliverable",
            "popups.list",
          ].includes(method)
        )
          await policy(info.url);
        if (target?.type && ["ref", "locator", "point"].includes(target.type)) {
          if (
            target.sessionId !== this.sessionId ||
            target.generation !== this.generation ||
            target.tabId !== tab.id
          )
            throw operationError("HANDLE_STALE");
          if ("frameId" in target && target.frameId) {
            const frame = (await tab.frames()).find(
              (f) => f.id === target.frameId,
            );
            if (!frame) throw operationError("REF_STALE");
            await policy(frame.url);
          }
        }
      }
    };
    if (
      tab &&
      ["dialogs.pending", "dialogs.respond", "info"].includes(method)
    ) {
      this.coordinator.check(scopeId);
      if (method === "info") {
        const info = await tab.info();
        return {
          ...info,
          state: this.handoffActive(tab.id)
            ? "handed_off"
            : info.state === "ready"
              ? this.coordinator.state(tab.id)
              : info.state,
        };
      }
      if (method === "dialogs.pending") return tab.dialog();
      return tab.respondDialog(String(args[0]), args[1] as any);
    }
    if (tab && method === "handoff.status") {
      this.coordinator.check(scopeId);
      const h = this.handoffs.get(tab.id);
      return h ? { handoffId: h.id, kind: h.kind, status: h.status } : null;
    }
    if (tab && method === "handoff.wait") return this.waitHandoff(tab, scopeId);
    if (tab) this.checkHandoff(tab, method);
    if (tab && method === "reportBlocked") return this.reportBlocked(tab, args);
    if (tab && method === "secureForm.status") {
      const state = this.options.userChannel?.secureFormState?.(
        String(args[0]),
      );
      return state?.sessionId === this.sessionId
        ? secureFormPublicState(state)
        : undefined;
    }
    if (tab && method === "secureForm.request")
      return this.secureForm(tab, scopeId, args[0], policy, validate);
    if (tab && method === "auth.request")
      return this.secureInput(tab, scopeId, args[0], policy, validate);
    const timeoutOptions = (
      method === "evaluate"
        ? args[2]
        : method === "waitForFunction"
          ? args[1]
          : undefined
    ) as { timeoutMs?: number } | undefined;
    return this.coordinator.run(
      {
        scopeId,
        sessionId: this.sessionId,
        generation: this.generation,
        kind: method,
        private: this.secureFlowProtected,
        tab,
        timeoutMs:
          timeoutOptions?.timeoutMs ?? this.options.operationTimeoutMs ?? 30000,
        readOnly: [
          "ax.snapshot",
          "dom.snapshot",
          "dom.inspect",
          "screenshot.capture",
          "devLogs",
        ].includes(method),
        policy,
        validate,
      },
      async (ctx) => {
        if (method === "connect") {
          if (!this.connection) ctx.dispatch();
          const c = await this.connect(ctx);
          ctx.check();
          return this.handle("browser", c.id);
        }
        if (method === "describe")
          return { ...this.describe(), health: await this.health() };
        if (method === "close") {
          ctx.dispatch();
          await this.close();
          return;
        }
        const connection = this.connection;
        if (!connection) throw operationError("BROWSER_DISCONNECTED");
        await connection.health();
        if (method === "tabs.create") {
          const url = (args[0] as { url?: string })?.url;
          await policy(url ?? "about:blank");
          ctx.dispatch();
          const created = await connection.create();
          try {
            await this.bind(created);
            if (url) await created.navigate("goto", url, ctx);
            await this.checkNavigation(created, policy);
            return this.handle("tab", created.id);
          } catch (e) {
            await created.close().catch(() => {});
            throw e;
          }
        }
        if (method === "tabs.list")
          return (await connection.tabs()).map((t) => this.handle("tab", t.id));
        if (method === "tabs.get") {
          const t = await connection.get(String(args[0]));
          if (!this.secureFlowProtected) await policy((await t.info()).url);
          await this.bind(t);
          return this.handle("tab", t.id);
        }
        if (method === "userTabs.list") return connection.userTabs();
        if (method === "userTabs.claim") {
          await policy((args[0] as any).url);
          const t = await connection.claim(args[0] as any);
          await this.bind(t);
          return this.handle("tab", t.id);
        }
        if (!tab) throw operationError("CAPABILITY_UNAVAILABLE");
        const bound = await this.bind(tab);
        if (PROTECTED_METHODS.includes(method)) {
          // A script in a parent/sibling frame can read same-origin documents.
          // Protection therefore applies to the entire tab, including explicit frameId calls.
          if (await this.isProtected(tab))
            throw operationError("CREDENTIAL_PROTECTED", {
              message:
                "Observation is restricted on a document that received credentials. Navigate to a new document to continue; the accessibility snapshot remains available with values redacted.",
            });
        }
        if (method === "handoff.request") {
          const channel = this.options.userChannel;
          const provide = connection.handoff;
          if (!channel || !provide)
            throw operationError("CAPABILITY_UNAVAILABLE", {
              message:
                "This browser cannot be handed to a person (for example, a headless local browser). Stop and tell the user what is blocking.",
            });
          const existing = this.handoffs.get(tab.id);
          if (existing?.status === "active")
            return {
              handoffId: existing.id,
              kind: existing.kind,
              message: "Handoff already active.",
            };
          const info = await tab.info();
          ctx.check();
          const target = await provide(tab.id);
          const opts = (args[0] ?? {}) as {
            reason?: string;
            timeoutMs?: number;
          };
          const ttl = Math.min(
            opts.timeoutMs ?? this.options.handoffTtlMs ?? 1800000,
            4 * 3600000,
          );
          const id = randomUUID();
          const abort = new AbortController();
          const record = {
            id,
            kind: target.kind,
            abort,
            status: "active" as "active" | "resumed" | "expired" | "cancelled",
            wait: undefined as unknown as Promise<
              "resumed" | "expired" | "cancelled"
            >,
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          record.wait = Promise.race([
            channel.handoff(
              {
                id,
                sessionId: this.sessionId,
                tabId: tab.id,
                origin: safeOrigin(info.url),
                reason:
                  typeof opts.reason === "string"
                    ? opts.reason.slice(0, 200)
                    : undefined,
                target,
                expiresAt: Date.now() + ttl,
              },
              abort.signal,
            ),
            new Promise<"expired">((resolve) => {
              timer = setTimeout(() => resolve("expired"), ttl);
              timer.unref?.();
            }),
          ])
            .catch(() => "cancelled" as const)
            .then(async (status) => {
              clearTimeout(timer);
              abort.abort();
              // Whatever the person did is unknown: drop every reference to the old page state.
              // Keep the handoff active until every live frame is protected.
              await this.protectHumanTab(tab!);
              record.status = status;
              return status;
            });
          // A provider failure must leave the tab handed off, not silently reopen it.
          void record.wait.catch(() => {});
          this.handoffs.set(tab.id, record);
          const message = `Ask the user to take over (${target.kind === "url" ? "open the live view link shown in their terminal" : target.kind === "window" ? "use the browser window now in front" : "use their own browser tab"}) and run: cua resume ${id}`;
          this.options.onUserNotice?.(scopeId, {
            code: "USER_ACTION_REQUIRED",
            message,
          });
          return { handoffId: id, kind: target.kind, message };
        }
        if (["goto", "reload", "back", "forward"].includes(method)) {
          if (method === "goto") await policy(String(args[0]));
          await tab.navigate(method as any, args[0] as string, ctx);
          await this.checkNavigation(tab, policy);
          return;
        }
        if (method === "tab.close") {
          ctx.dispatch();
          await tab.close();
          return;
        }
        if (method === "markDeliverable")
          return tab.markDeliverable(Boolean(args[0]));
        if (method === "popups.list") return connection.popups(tab.id);
        if (method === "devLogs") return tab.devLogs(args[0] as any);
        if (method === "ax.snapshot") {
          if (!bound.ax) throw operationError("CAPABILITY_UNAVAILABLE");
          const info = await tab.info();
          const full = await bound.ax.snapshot(ctx, {
            redactEditableValues: await this.isProtected(tab),
          });
          const opts = args[0] as { since?: string; full?: boolean };
          const since = opts.full
            ? undefined
            : (opts.since ?? this.delivered.get(tab.id));
          const old = since ? this.snapshots.get(since) : undefined;
          const base =
            old?.tabId === tab.id && old.epoch === info.epoch
              ? old.snapshot
              : undefined;
          const snapshot: Snapshot = {
            observationId: randomUUID(),
            baseObservationId: base?.observationId ?? null,
            isDiff: !!base,
            title: info.title,
            url: info.url,
            nodes: full.nodes,
            removed: [],
            warnings: full.warnings,
          };
          this.snapshots.set(snapshot.observationId, {
            tabId: tab.id,
            epoch: info.epoch,
            snapshot: { ...snapshot, nodes: full.nodes },
          });
          if (this.snapshots.size > 100)
            this.snapshots.delete(this.snapshots.keys().next().value!);
          if (base) {
            const prior = new Map(
              base.nodes.map((n) => [n.id, JSON.stringify(n)]),
            );
            const ids = new Set(full.nodes.map((n) => n.id));
            snapshot.nodes = full.nodes.filter(
              (n) => prior.get(n.id) !== JSON.stringify(n),
            );
            snapshot.removed = base.nodes
              .filter((n) => !ids.has(n.id))
              .map((n) => n.id);
          }
          return snapshot;
        }
        if (method === "dom.inspect") {
          if (!bound.dom?.inspect)
            throw operationError("CAPABILITY_UNAVAILABLE");
          return bound.dom.inspect(args[0] as any, ctx);
        }
        if (method === "dom.snapshot") {
          if (!bound.dom) throw operationError("CAPABILITY_UNAVAILABLE");
          return bound.dom.snapshot(ctx);
        }
        if (method === "screenshot.capture") {
          if (!bound.screenshot) throw operationError("CAPABILITY_UNAVAILABLE");
          const image = await bound.screenshot.capture(args[0] as any, ctx);
          this.images.set(image.metadata.imageId, image);
          let total = [...this.images.values()].reduce(
            (size, item) => size + item.bytes.byteLength,
            0,
          );
          while (
            this.images.size > 100 ||
            total > (this.options.imageCacheBytes ?? 64 * 1024 * 1024)
          ) {
            const id = this.images.keys().next().value!;
            total -= this.images.get(id)!.bytes.byteLength;
            this.images.delete(id);
          }
          return image.metadata;
        }
        if (method === "evaluate" || method === "waitForFunction") {
          const opts = (method === "evaluate" ? args[2] : args[1]) as any;
          const frameId = opts?.frameId;
          if (frameId) {
            const frame = (await tab.frames()).find((f) => f.id === frameId);
            if (!frame) throw operationError("REF_STALE");
            await policy(frame.url);
          }
          const evaluate = () =>
            tab!.evaluate(
              String(args[0]),
              method === "evaluate" ? args[1] : opts?.arg,
              frameId,
              ctx,
            );
          if (method === "evaluate") return evaluate();
          while (true) {
            ctx.check();
            const result = await evaluate();
            if (result) return result;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        if (method.startsWith("actions.")) {
          if (!bound.action) throw operationError("CAPABILITY_UNAVAILABLE");
          const resolver = this.options.targetResolvers.find(
            (r) =>
              r.descriptor.bindingKind === tab!.kind &&
              (!r.descriptor.targetTypes ||
                r.descriptor.targetTypes.includes(target?.type ?? "")),
          );
          if (target && !resolver)
            throw operationError("CAPABILITY_UNAVAILABLE");
          const resolved = target
            ? await resolver!.resolve(
                target,
                {
                  binding: tab,
                  sessionId: this.sessionId,
                  generation: this.generation,
                },
                ctx,
              )
            : undefined;
          try {
            if (
              (this.options.credentials?.mode ?? "require") === "require" &&
              (method === "actions.fill" || method === "actions.press")
            ) {
              const sensitive = resolved
                ? (await bound.action.describe?.(resolved, ctx))?.sensitive
                : await bound.action.focusedSensitive?.(ctx);
              if (sensitive)
                throw operationError("SECURE_INPUT_REQUIRED", {
                  message:
                    "This is a password or one-time-code field. Use tab.auth.request(...) so the user enters the value privately; never ask for it in chat.",
                });
            }
            return await bound.action.perform(
              method.slice(8),
              resolved,
              args.slice(1),
              ctx,
            );
          } finally {
            await resolved?.dispose();
          }
        }
        throw operationError("CAPABILITY_UNAVAILABLE", {
          message: `Unsupported SDK method: ${method}`,
        });
      },
    );
  }
  private async waitHandoff(tab: TabBinding, scopeId: string) {
    this.coordinator.check(scopeId);
    const h = this.handoffs.get(tab.id);
    if (!h)
      throw operationError("INVALID_ARGUMENT", {
        message: "No handoff was requested for this tab.",
      });
    if (h.status !== "active") return { status: h.status };
    const signal = this.coordinator.scopeSignal(scopeId);
    this.options.onUserWait?.(scopeId, true);
    try {
      const status = await Promise.race([
        h.wait,
        new Promise<never>((_, reject) => {
          const stop = () => reject(operationError("OPERATION_CANCELLED"));
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        }),
      ]);
      return { status, nextAction: "observe" };
    } finally {
      this.options.onUserWait?.(scopeId, false);
    }
  }
  private reportBlocked(tab: TabBinding, args: unknown[]) {
    const reason = (args[0] as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== "string" || !BLOCK_REASONS.includes(reason))
      throw operationError("INVALID_ARGUMENT", {
        message: `reason must be one of ${BLOCK_REASONS.join(", ")}. DNS/TLS failures, timeouts and a bare 403 are not bot detection.`,
      });
    return tab.info().then((info) => {
      let hostname: string | null = null;
      try {
        hostname = new URL(info.url).hostname || null;
      } catch {}
      const report = { hostname, reason, time: Date.now() };
      this.blocked.push(report);
      if (this.blocked.length > 100) this.blocked.shift();
      try {
        this.options.onBlocked?.(report);
      } catch {}
      return { status: "reported" as const, hostname };
    });
  }
  /**
   * Validates targets without dispatch, asks the user out of band, then fills in the main process.
   * Values never enter the worker, results, errors or logs.
   */
  private async secureForm(
    tab: TabBinding,
    scopeId: string,
    raw: unknown,
    policy: (url: string, kind?: string) => Promise<void>,
    validate: () => Promise<void>,
  ) {
    this.secureFormGuard("secureForm.request");
    const channel = this.options.userChannel;
    if (
      !channel?.collectSecureForm ||
      !channel.secureFormState ||
      !channel.updateSecureForm
    )
      throw operationError("AUTH_UNAVAILABLE");
    const parsed = parseSecureForm(
      raw,
      this.sessionId,
      this.generation,
      tab.id,
    );
    if (this.coordinator.hasPendingOperations())
      throw operationError("SECURE_FORM_PROTECTED", {
        message:
          "Wait for existing browser operations before opening a private form.",
      });
    this.secureFormWaiting = true;
    const heldTargets: ResolvedTarget[] = [];
    try {
      const bound = await this.bind(tab);
      if (!bound.action?.describe || !bound.action.deliverSecureForm)
        throw operationError("CAPABILITY_UNAVAILABLE");
      const resolve = (target: Target, ctx: OperationContext) => {
        const resolver = this.options.targetResolvers.find(
          (r) =>
            r.descriptor.bindingKind === tab.kind &&
            (!r.descriptor.targetTypes ||
              r.descriptor.targetTypes.includes(target.type)),
        );
        if (!resolver) throw operationError("CAPABILITY_UNAVAILABLE");
        return resolver.resolve(
          target,
          {
            binding: tab,
            sessionId: this.sessionId,
            generation: this.generation,
          },
          ctx,
        );
      };
      let targetChanged = false;
      const invalid = () => {
        targetChanged = true;
        return operationError("AUTH_PAGE_CHANGED", {
          message:
            "Secure form target changed or unsupported; use human review.",
        });
      };
      const snapshot = await this.coordinator.run(
        {
          scopeId,
          sessionId: this.sessionId,
          generation: this.generation,
          kind: "secureForm.validate",
          private: true,
          tab,
          timeoutMs: 30000,
          policy,
          validate,
        },
        async (ctx) => {
          const info = await tab.info(),
            origin = safeOrigin(info.url),
            frames = await tab.frames();
          if (origin === "null") throw invalid();
          let frameId: string | undefined;
          const fields = [];
          for (const field of parsed.fields) {
            const frame = frames.find(
              (f) =>
                f.id ===
                ("frameId" in field.target && field.target.frameId
                  ? field.target.frameId
                  : (frames.find((f) => !f.parentId) ?? frames[0])?.id),
            );
            if (
              !frame ||
              safeOrigin(frame.url) !== origin ||
              (frameId && frame.id !== frameId)
            )
              throw invalid();
            frameId = frame.id;
            const resolved = await resolve(field.target, ctx);
            heldTargets.push(resolved);
            {
              const description = await bound.action!.describe!(resolved, ctx),
                d = description.secureForm;
              if (
                !d ||
                !d.nodeId ||
                d.control !== field.control ||
                description.count !== 1 ||
                !description.visible ||
                !description.enabled ||
                (!description.editable && d.control !== "select") ||
                description.authForm === undefined ||
                (description.authForm !== null &&
                  (description.authForm.method.toLowerCase() !== "post" ||
                    safeOrigin(description.authForm.action) !== origin))
              )
                throw invalid();
              fields.push({
                field,
                resolved,
                description: structuredClone(description),
                frameId: frame.id,
                frameEpoch: frame.epoch,
                options: d.options
                  ?.filter(
                    (o) => !o.disabled && !(d.required && o.value === ""),
                  )
                  .map((o) => ({ ...o, id: randomUUID() })),
              });
            }
          }
          if (
            new Set(fields.map((f) => f.description.secureForm!.nodeId))
              .size !== fields.length
          )
            throw invalid();
          return { origin, epoch: info.epoch, fields };
        },
      );
      const id = randomUUID(),
        request: SecureFormRequest = {
          type: "secure_form",
          id,
          sessionId: this.sessionId,
          tabId: tab.id,
          scopeId,
          executionId: this.options.executionIdForScope?.(scopeId),
          schemaRevision: parsed.schemaRevision,
          origin: snapshot.origin,
          title: parsed.title,
          groups: parsed.groups,
          delivery: { mode: "fill" },
          expiresAt: Date.now() + parsed.timeoutMs,
          fields: snapshot.fields.map(({ field, description, options }) => {
            const d = description.secureForm!;
            return {
              id: field.id,
              label: field.label,
              control: field.control,
              groupId: field.groupId,
              masked: field.masked,
              required: d.required,
              nonEmpty: d.nonEmpty,
              maxLength: d.maxLength,
              min: d.min,
              max: d.max,
              options: options?.map((o) => ({ id: o.id, label: o.label })),
            };
          }),
        };
      const signal = this.coordinator.scopeSignal(scopeId),
        abort = new AbortController();
      const stop = () => abort.abort(operationError("OPERATION_CANCELLED"));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(
        () => abort.abort(operationError("AUTH_EXPIRED")),
        parsed.timeoutMs,
      );
      this.secureFormWaiting = true;
      this.options.onUserWait?.(scopeId, true);
      let answer: Awaited<
        ReturnType<NonNullable<UserChannel["collectSecureForm"]>>
      >;
      try {
        const waiting = channel.collectSecureForm(request, abort.signal, () => {
          this.enforceSecureFormProtection();
          this.options.onSecureFormAccepted?.();
        });
        this.options.onUserNotice?.(scopeId, {
          code: "USER_ACTION_REQUIRED",
          message: `Open cua_secure_form with sessionId ${this.sessionId} and requestId ${id}. Values remain private; fill-only delivery requires human review afterward.`,
        });
        answer = await waiting;
      } catch {
        return secureFormPublicState(channel.secureFormState(id)!);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        this.options.onUserWait?.(scopeId, false);
        this.secureFormWaiting = false;
      }
      if (answer.action !== "accept")
        return secureFormPublicState(channel.secureFormState(id)!);
      this.enforceSecureFormProtection();
      const values = answer.values;
      const confirmed: string[] = [],
        uncertain: string[] = [];
      let dispatched = false;
      channel.updateSecureForm!(id, {
        status: "delivering",
        nextAction: "wait",
      });
      try {
        await this.coordinator.run(
          {
            scopeId,
            sessionId: this.sessionId,
            generation: this.generation,
            kind: "secureForm.deliver",
            private: true,
            tab,
            timeoutMs: 30000,
            policy,
            validate: async () => {
              this.coordinator.check(scopeId);
              this.checkHandoff(tab, "secureForm.deliver");
            },
          },
          async (ctx) => {
            const check = async () => {
              ctx.check();
              this.checkHandoff(tab, "secureForm.deliver");
              const info = await tab.info(),
                frames = await tab.frames();
              if (
                info.epoch !== snapshot.epoch ||
                safeOrigin(info.url) !== snapshot.origin
              )
                throw invalid();
              for (const item of snapshot.fields) {
                const f = frames.find((f) => f.id === item.frameId);
                if (
                  !f ||
                  f.epoch !== item.frameEpoch ||
                  safeOrigin(f.url) !== snapshot.origin
                )
                  throw invalid();
              }
            };
            for (const item of snapshot.fields) {
              await check();
              const target = item.resolved;
              {
                const checkTarget = async () => {
                  await check();
                  const d = await bound.action!.describe!(target, ctx);
                  if (JSON.stringify(d) !== JSON.stringify(item.description))
                    throw invalid();
                };
                await checkTarget();
                const value = values[item.field.id];
                const deliveredValue =
                  item.field.control === "select"
                    ? item.options!.find((o) => o.id === value)!.value
                    : value;
                // Conservative dispatch intent: errors after this point cannot be safely replayed.
                uncertain.push(item.field.id);
                dispatched = true;
                channel.updateSecureForm!(id, {
                  uncertainFieldIds: [...uncertain],
                });
                await bound.action!.deliverSecureForm!(
                  item.field.control === "select" ? "select" : "fill",
                  target,
                  deliveredValue,
                  {
                    ...ctx,
                    policy: async (url, kind) => {
                      await policy(url, kind);
                      await checkTarget();
                    },
                  },
                );
                confirmed.push(item.field.id);
                uncertain.pop();
                channel.updateSecureForm!(id, {
                  confirmedFieldIds: [...confirmed],
                  uncertainFieldIds: [...uncertain],
                });
              }
            }
          },
        );
        channel.updateSecureForm!(id, {
          status: "filled",
          nextAction: "human_review",
        });
      } catch {
        channel.updateSecureForm!(id, {
          status: dispatched
            ? "partial_or_unknown"
            : targetChanged
              ? "stale"
              : signal.aborted
                ? "cancelled"
                : "failed_before_write",
          nextAction: "human_review",
          reasonCode: dispatched
            ? "DELIVERY_REQUIRES_REVIEW"
            : targetChanged
              ? "TARGET_CHANGED_BEFORE_WRITE"
              : "DELIVERY_STOPPED_BEFORE_WRITE",
        });
      } finally {
        for (const key of Object.keys(values)) delete values[key];
      }
      return secureFormPublicState(channel.secureFormState(id)!);
    } finally {
      this.secureFormWaiting = false;
      await Promise.all(
        heldTargets.map((target) => target.dispose().catch(() => {})),
      );
    }
  }
  private async secureInput(
    tab: TabBinding,
    scopeId: string,
    raw: unknown,
    policy: (url: string, kind?: string) => Promise<void>,
    validate: () => Promise<void>,
  ) {
    const channel = this.options.userChannel;
    if (!channel)
      throw operationError("AUTH_UNAVAILABLE", {
        message:
          "No private credential channel is configured. Stop automated sign-in and tell the user; never ask for secrets in chat.",
      });
    const request = parseAuthRequest(
      raw,
      this.sessionId,
      this.generation,
      tab.id,
    );
    const bound = await this.bind(tab);
    if (!bound.action?.describe) throw operationError("CAPABILITY_UNAVAILABLE");
    const resolver = (target: Target) =>
      this.options.targetResolvers.find(
        (r) =>
          r.descriptor.bindingKind === tab.kind &&
          (!r.descriptor.targetTypes ||
            r.descriptor.targetTypes.includes(target.type)),
      );
    const frameOf = async (target: Target, frames: FrameInfo[]) => {
      const id =
        "frameId" in target && target.frameId ? target.frameId : undefined;
      const main = frames.find((f) => !f.parentId) ?? frames[0];
      const frame = id ? frames.find((f) => f.id === id) : main;
      if (!frame) throw operationError("AUTH_PAGE_CHANGED");
      return frame;
    };
    const items = [
      ...request.fields.map((f) => ({
        target: f.target,
        editable: true,
        type: f.type,
      })),
      ...(request.submit
        ? [{ target: request.submit.target, editable: false, type: "submit" }]
        : []),
    ];
    const checkTarget = (
      d: TargetDescription,
      item: (typeof items)[number],
      origin: string,
    ) => {
      if (
        d.count !== 1 ||
        !d.visible ||
        !d.enabled ||
        (item.editable && !d.editable) ||
        (["password", "otp"].includes(item.type) && !d.sensitive) ||
        d.authForm === undefined ||
        (d.authForm !== null &&
          (d.authForm.method.toLowerCase() !== "post" ||
            safeOrigin(d.authForm.action) !== origin))
      )
        throw operationError("AUTH_LOCATOR_INVALID", {
          message:
            "Secure input requires verified fields in one frame and a same-origin POST form or no native form. Password/OTP targets must be sensitive. Use human handoff for unsupported forms.",
        });
    };
    // Phase 1: validate under the tab lane; nothing is dispatched.
    const snapshot = await this.coordinator.run(
      {
        scopeId,
        sessionId: this.sessionId,
        generation: this.generation,
        kind: "auth.validate",
        tab,
        timeoutMs: this.options.operationTimeoutMs ?? 30000,
        policy,
        validate,
      },
      async (ctx) => {
        const info = await tab.info();
        await policy(info.url, "auth.request");
        const origin = safeOrigin(info.url);
        if (origin === "null")
          throw operationError("AUTH_ORIGIN_CHANGED", {
            message: "Sign-in needs an http(s) page.",
          });
        const frames = await tab.frames();
        const frameEpochs = new Map<string, number>();
        for (const item of items) {
          const frame = await frameOf(item.target, frames);
          if (safeOrigin(frame.url) !== origin)
            throw operationError("AUTH_ORIGIN_CHANGED", {
              message: "A credential field is in a frame from another origin.",
            });
          frameEpochs.set(frame.id, frame.epoch);
          if (frameEpochs.size !== 1)
            throw operationError("AUTH_LOCATOR_INVALID", {
              message:
                "Credential fields and submit target must share one frame.",
            });
          const r = resolver(item.target);
          if (!r) throw operationError("CAPABILITY_UNAVAILABLE");
          let resolved: ResolvedTarget;
          try {
            resolved = await r.resolve(
              item.target,
              {
                binding: tab,
                sessionId: this.sessionId,
                generation: this.generation,
              },
              ctx,
            );
          } catch {
            throw operationError("AUTH_LOCATOR_INVALID");
          }
          try {
            const d = await bound.action!.describe!(resolved, ctx);
            checkTarget(d, item, origin);
          } finally {
            await resolved.dispose();
          }
        }
        return { origin, epoch: info.epoch, frameEpochs };
      },
    );
    // Phase 2: wait for the user. Cell and idle timers pause; closing the scope cancels.
    const id = randomUUID();
    const ttl = Math.min(
      request.timeoutMs ?? this.options.credentials?.requestTtlMs ?? 300000,
      900000,
    );
    const signal = this.coordinator.scopeSignal(scopeId);
    const abort = new AbortController();
    const stop = () => abort.abort(operationError("OPERATION_CANCELLED"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(
      () => abort.abort(operationError("AUTH_EXPIRED")),
      ttl,
    );
    this.options.onUserNotice?.(scopeId, {
      code: "USER_ACTION_REQUIRED",
      message: `Private sign-in for ${snapshot.origin}. If cua_login is available, open it with sessionId ${this.sessionId} and requestId ${id}; otherwise ask the user to run in their terminal: cua auth ${id}. Values stay private.`,
    });
    this.options.onUserWait?.(scopeId, true);
    let answer;
    try {
      answer = await channel.collectCredentials(
        {
          id,
          sessionId: this.sessionId,
          origin: snapshot.origin,
          fields: request.fields.map((f) => ({
            id: f.id,
            label: f.label,
            type: f.type,
          })),
          expiresAt: Date.now() + ttl,
        },
        abort.signal,
      );
    } catch (error) {
      throw error instanceof CuaError
        ? error
        : abort.signal.reason instanceof CuaError
          ? abort.signal.reason
          : operationError("AUTH_EXPIRED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      this.options.onUserWait?.(scopeId, false);
    }
    if (answer.action !== "accept")
      throw operationError("AUTH_DECLINED", {
        message:
          "The user declined. Respect the choice and do not retry unless asked.",
      });
    const values = answer.values;
    // Phase 3: fill in the main process after re-checking that the page did not change.
    return this.coordinator.run(
      {
        scopeId,
        sessionId: this.sessionId,
        generation: this.generation,
        kind: "auth.submit",
        tab,
        timeoutMs: this.options.operationTimeoutMs ?? 30000,
        policy,
        validate,
      },
      async (ctx) => {
        const checkPage = async () => {
          ctx.check();
          this.checkHandoff(tab, "auth.submit");
          const info = await tab.info();
          if (safeOrigin(info.url) !== snapshot.origin)
            throw operationError("AUTH_ORIGIN_CHANGED");
          if (info.epoch !== snapshot.epoch)
            throw operationError("AUTH_PAGE_CHANGED");
          const frames = new Map((await tab.frames()).map((f) => [f.id, f]));
          for (const [frameId, epoch] of snapshot.frameEpochs) {
            const frame = frames.get(frameId);
            if (frame && safeOrigin(frame.url) !== snapshot.origin)
              throw operationError("AUTH_ORIGIN_CHANGED");
            if (!frame || frame.epoch !== epoch)
              throw operationError("AUTH_PAGE_CHANGED");
          }
        };
        await checkPage();
        await policy(snapshot.origin, "auth.submit");
        // Providers call policy immediately before dispatching input. Recheck here too,
        // since target resolution and actionability waits may have navigated the page.
        const guardedContext: OperationContext = {
          ...ctx,
          policy: async (url, kind) => {
            await policy(url, kind);
            await checkPage();
          },
        };
        // Protect before the first keystroke so no observation can race the fill.
        const protectedFrames =
          this.protectedFrames.get(tab.id) ?? new Map<string, number>();
        for (const [frameId, epoch] of snapshot.frameEpochs)
          protectedFrames.set(frameId, epoch);
        this.protectedFrames.set(tab.id, protectedFrames);
        const steps: { target: Target; kind: string; args: unknown[] }[] =
          request.fields.map((f) => ({
            target: f.target,
            kind: "fill",
            args: [values[f.id]],
          }));
        if (request.submit)
          steps.push({
            target: request.submit.target,
            kind: request.submit.action === "press_enter" ? "press" : "click",
            args: request.submit.action === "press_enter" ? ["Enter"] : [],
          });
        for (const step of steps) {
          let resolved: ResolvedTarget | undefined;
          try {
            await checkPage();
            resolved = await resolver(step.target)!.resolve(
              step.target,
              {
                binding: tab,
                sessionId: this.sessionId,
                generation: this.generation,
              },
              guardedContext,
            );
            await checkPage();
            const item = items.find((item) => item.target === step.target)!;
            const checkResolved = async () => {
              checkTarget(
                await bound.action!.describe!(resolved!, guardedContext),
                item,
                snapshot.origin,
              );
              await checkPage();
            };
            await checkResolved();
            await bound.action!.perform(step.kind, resolved, step.args, {
              ...guardedContext,
              policy: async (url, kind) => {
                await guardedContext.policy(url, kind);
                await checkResolved();
              },
            });
          } catch (error) {
            if (
              error instanceof CuaError &&
              error.code === "OPERATION_CANCELLED"
            )
              throw error;
            // The underlying error may echo a typed value; never surface it.
            throw operationError(
              ctx.signal.aborted
                ? "OPERATION_CANCELLED"
                : "AUTH_SUBMISSION_FAILED",
              ctx.signal.aborted
                ? { phase: "dispatch" }
                : {
                    message:
                      "Credential entry did not complete. Observe the page; some input may have occurred.",
                  },
            );
          } finally {
            await resolved?.dispose().catch(() => {});
          }
        }
        return {
          status: "submitted" as const,
          requestId: id,
          nextAction: "observe",
        };
      },
    );
  }
  private async checkNavigation(
    tab: TabBinding,
    policy: (url: string) => Promise<void>,
  ) {
    try {
      await policy((await tab.info()).url);
    } catch (e) {
      if (e instanceof CuaError && e.code === "POLICY_BLOCKED")
        throw operationError("POLICY_BLOCKED", {
          phase: "after_dispatch",
          message: e.message,
        });
      throw e;
    }
  }
}
function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}
interface ParsedAuthRequest {
  fields: { id: string; label: string; type: string; target: Target }[];
  submit?: { target: Target; action: "click" | "press_enter" };
  timeoutMs?: number;
}
function parseAuthRequest(
  raw: unknown,
  sessionId: string,
  generation: number,
  tabId: string,
): ParsedAuthRequest {
  const bad = (message: string) =>
    operationError("INVALID_ARGUMENT", { message });
  const r = raw as Record<string, any>;
  if (!r || typeof r !== "object" || !Array.isArray(r.fields))
    throw bad("auth.request needs { fields: [...] }.");
  if (r.fields.length < 1 || r.fields.length > 6)
    throw bad("Between 1 and 6 credential fields are allowed.");
  const target = (t: any): Target => {
    if (!t || typeof t !== "object" || !["ref", "locator"].includes(t.type))
      throw bad(
        "Field targets must be element refs or locators (not coordinates).",
      );
    if (
      t.sessionId !== sessionId ||
      t.generation !== generation ||
      t.tabId !== tabId
    )
      throw operationError("HANDLE_STALE");
    return t;
  };
  const ids = new Set<string>();
  const fields = r.fields.map((f: any) => {
    if (
      !f ||
      typeof f.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(f.id) ||
      ["__proto__", "constructor", "prototype"].includes(f.id)
    )
      throw bad("Field id must match [A-Za-z0-9_-]{1,48}.");
    if (ids.has(f.id)) throw bad("Field ids must be unique.");
    ids.add(f.id);
    if (typeof f.label !== "string" || !f.label.trim() || f.label.length > 60)
      throw bad("Each field needs a short label.");
    if ("value" in f)
      throw bad(
        "Never pass credential values; the user enters them privately.",
      );
    const type = typeof f.type === "string" ? f.type.toLowerCase() : "text";
    if (!["text", "email", "username", "password", "otp"].includes(type))
      throw bad("Field type must be text, email, username, password or otp.");
    return {
      id: f.id,
      label: f.label.trim(),
      type,
      target: target(f.target),
    };
  });
  let submit: ParsedAuthRequest["submit"];
  if (r.submit) {
    const action = r.submit.action ?? "click";
    if (!["click", "press_enter"].includes(action))
      throw bad("submit.action must be click or press_enter.");
    submit = { target: target(r.submit.target), action };
  }
  const timeoutMs =
    typeof r.timeoutMs === "number" && r.timeoutMs > 0
      ? r.timeoutMs
      : undefined;
  return { fields, submit, timeoutMs };
}
export function createCUA(options: CUAOptions): CUA & { engine: CUAEngine } {
  const engine = new CUAEngine(options);
  const scopeId = engine.coordinator.openScope();
  const facade = createFacade(
    (method, args, tabId) =>
      engine.dispatch({
        method,
        args,
        tabId,
        scopeId,
        sessionId: engine.sessionId,
        generation: engine.generation,
      }),
    () => ({ sessionId: engine.sessionId, generation: engine.generation }),
  );
  return Object.assign(facade, { engine });
}
