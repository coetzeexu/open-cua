import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { FileHistoryStore, safeId, type HistoryConfig } from "@cua/history";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SecureFormProtectionStore } from "./secure-form-protection.js";
import {
  CUAEngine,
  PendingUserChannel,
  secureFormPublicState,
  DefaultPolicyProvider,
  type Confirmation,
  type CUAOptions,
} from "@cua/core";
import { launchWorker, type WorkerHandle } from "@cua/repl";
import {
  CuaError,
  aggregate,
  executionError,
  operationError,
  operationErrorTable,
  executionErrorTable,
  type ExecutionResult,
  type WorkerMessage,
  type Warning,
  type OutputItem,
  type UserChannel,
  type SecureFormAnswer,
} from "@cua/contracts";
export interface ServiceOptions {
  history?: HistoryConfig;
  historyStore?: FileHistoryStore;
  profiles: Record<string, () => CUAOptions>;
  defaultProfile?: string;
  maxSessions?: number;
  executeWaitMs?: number;
  cellTimeoutMs?: number;
  maxCellTimeoutMs?: number;
  terminationGraceMs?: number;
  idleMs?: number;
  resultTtlMs?: number;
  maxResults?: number;
  maxDedup?: number;
  maxTextChars?: number;
  maxImageBytes?: number;
  maxOutputBytes?: number;
  maxSessionOutputBytes?: number;
  imageOutput?: "inline" | "file";
  /** Shared human channel for secure input and handoff (CLI wires it to the Unix socket). */
  userChannel?: UserChannel;
  /** Persist conservative protection for stable browser resource keys; never stores input. */
  secureFormProtectionDirectory?: string;
}
interface Execution {
  result: ExecutionResult;
  scopeId: string;
  moduleEnded: boolean;
  terminating?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve: () => void;
  changed: EventEmitter;
  created: number;
  finished?: number;
  bytes: number;
  generation: number;
  outputQueue: Promise<void>;
  delivered: Set<string>;
  remainingMs: number;
  deadline: number;
  pauses: number;
}
interface Session {
  id: string;
  runId: string;
  stopHistory?: () => void;
  profile: string;
  engine: CUAEngine;
  worker?: WorkerHandle;
  generation: number;
  directory: string;
  results: Map<string, Execution>;
  dedup: Map<
    string,
    { hash: string; id: string; status: ExecutionResult["status"] }
  >;
  active?: Execution;
  warnings: Warning[];
  lastFinished: number;
  pollers: number;
  outputBytes: number;
  closing: boolean;
  intentionalExit: boolean;
  resourceKey?: string;
  userWaits: { count: number };
  control: "agent" | "interrupting" | "paused" | "human";
  humanActions: number;
}
export const API_REFERENCE = {
  navigation:
    "await tab.goto(url); await tab.reload(); await tab.back(); await tab.forward(); output.json(await tab.info());",
  observation:
    "await tab.ax.snapshot({since?: observationId,full?: boolean}); await tab.dom.snapshot(); await tab.dom.inspect({selector?: string,limit?: number,maxTextLength?: number,frameId?: string}); await tab.screenshot.capture();",
  inspect:
    'dom.inspect returns {page:{url,title,readyState},frameId,capturedAt,coordinateSystem:"frame-viewport-css",elements:[{text,href,bounds:{x,y,width,height}}],matched,truncated,textTruncated}. It is a separate observation from screenshots, not a shared frame.',
  targets:
    "tab.locator(selector,{frameId?}); tab.getByRole(role,{name?,exact?,frameId?}); tab.getByText(text,{exact?,frameId?}); locator.click(options?)/fill(value,options?)/hover(options?)/press(key,options?)/selectOption(values)/setInputFiles(paths); locator.target can be passed to tab.actions.",
  actions:
    "await tab.actions.scroll(targetOrUndefined,{x,y}); await tab.actions.click(target); await tab.actions.fill(target,value); await tab.actions.press(targetOrUndefined,key); await tab.actions.select(target,values); await tab.actions.hover(target); await tab.actions.drag(source,destination);",
  files:
    'await tab.locator("input[type=file]",{frameId}).setInputFiles("/absolute/path/file.xlsx"); await tab.actions.setInputFiles(target,["/absolute/a.csv","/absolute/b.csv"]); pass [] to clear. Paths refer to files on the CUA service host, including when Chromium is remote. Only upload files authorized by the user. Up to 20 regular files, 50 MiB total. Supports hidden inputs and iframe targets; no native picker or directory upload. Selection dispatches input/change events and may trigger site auto-upload; observe input.files and page state before retrying. It does not prove server import success.',
  evaluation:
    "await tab.evaluate(fnOrString,arg?,{frameId?,timeoutMs?}); await tab.waitForFunction(fnOrString,{arg?,frameId?,timeoutMs?}); evaluate may mutate the page. Prefer dom.inspect for structured reads and condition waits over sleeps.",
  sessions:
    "var browser=await cua.connect(); var tab=await browser.tabs.create({url}); await browser.tabs.list(); await browser.tabs.get(id); await tab.close(); await browser.close(); Reacquire handles after reset. Omit profile in cua_session_create to use the configured default.",
};
export const API_HELP = `CUA is not Playwright. Common API: await tab.info() -> {url,title}; await tab.goto(url); await tab.actions.scroll(undefined,{x:0,y:600}); await tab.dom.inspect({selector:"a",limit:30}) -> text/href/bounds/page/time/truncation; await tab.evaluate(() => document.title); await tab.waitForFunction(() => document.readyState === "complete",{timeoutMs:5000}). Locator supports click/fill/hover/press/selectOption/setInputFiles, not first/boundingBox/scrollIntoViewIfNeeded. File upload: locator.setInputFiles(absolutePathOrPaths) selects files from the CUA service host; [] clears. Only user-authorized files; max 20 regular files / 50 MiB total; supports iframe and hidden file inputs. No native picker needed. Selection may trigger automatic upload; observe input.files and site result. No tab.url/title/navigate/scroll members. cua_describe returns apiReference with signatures and examples. CUA JavaScript: var browser=await cua.connect(); var tab=await browser.tabs.create({url:"https://example.com"}); output.json(await tab.ax.snapshot()); await tab.getByRole("button",{name:"Save",exact:true}).click(); output.json(await tab.ax.snapshot()); output.image(await tab.screenshot.capture()). Use output.text/json/image; final expressions are not printed. Cells retain initialized bindings, support top-level await and await import(), and drain SDK calls. Static imports, exports and top-level destructuring are unsupported. References identify original nodes; navigation, replacement or reset makes them stale. Point targets come from tab.point(screenshot,x,y). Read error.nextAction; outcome unknown means observe, do not repeat the action. Handle dialogs with tab.dialogs.pending/respond. Site confirmations require the user terminal cua approve command. Private user data: use tab.secureForm.request({title,groups?,fields:[{id,label,groupId?,control,masked?,target}],delivery:{mode:"fill"}}) for supported native text/email/tel/password/date/single-select fields. Never include values/defaults/options in model code. The service verifies targets; if unsupported use human takeover. On USER_ACTION_REQUIRED open cua_secure_form with sessionId/requestId. Poll the original execution and use tab.secureForm.status(requestId); accepted is not filled, and filled is not website success. All values use app-only delivery. This first version is fill-only and nextAction human_review: secure form protection persists through navigation/reset and blocks raw page reads and actions; use cua_view for review, never retry unknown input. If the host lacks the private card, request human takeover, not chat input. Sign-in compatibility: never ask for or type passwords/OTP in chat or model code. For account/password login call tab.auth.request({fields:[{id,label,type,target}],submit:{target}}); when execution returns running with USER_ACTION_REQUIRED, use cua_login (if available) with the sessionId and request ID from the warning to display a private login card, the card sends a credential-free continuation message after private submission. On that message poll the original execution and observe the page; do not ask for a manual chat confirmation unless the card reports automatic continuation unavailable. Without MCP Apps tell the user to run the cua auth command shown in warnings. For phone/SMS login, image codes, sliders or other human verification, explain the obstacle and open cua_view for human takeover; do not build an OTP form. result "submitted" is not proof of login, observe again. CREDENTIAL_PROTECTED: navigate to a new document. CAPTCHA or manual step: tab.handoff.request({reason}) then await tab.handoff.wait() and observe with full snapshot; SDK never solves CAPTCHAs. tab.reportBlocked({reason}) records bot blocks (captcha_failed|access_denied|challenge_loop|unexpected_bot_error). Timeout may restart REPL; reacquire browser.tabs.list() handles. Browser persists across cua_reset. On BROWSER_DISCONNECTED, call cua.connect() again: sandbox profiles retry the same CDP endpoint within connectTimeoutMs without closing the MCP session. Reacquire browser and tab handles, then observe; old handles become stale and interrupted actions are never replayed. On browser_leased/SESSION_BUSY do not blindly retry or reuse another connection’s sessionId. Call cua_session_status without a session to inspect lease metadata; a local operator can run cua status and cua session-close <sessionId> on the service host (explicit --force cancels active/human work). Retry after release; reacquire handles and observe. Call cua_close to release resources.`;
export class CUAService {
  private readonly sdkHistoryContext = new AsyncLocalStorage<{
    executionId?: string;
    callId: string;
  }>();
  private sessions = new Map<string, Session>();
  readonly history: FileHistoryStore;
  private janitor: ReturnType<typeof setInterval>;
  private leases = new Set<string>();
  private sessionClosures = new Map<
    string,
    Promise<{
      sessionId: string;
      closed: boolean;
      error?: ReturnType<CuaError["toJSON"]>;
    }>
  >();
  private creating = 0;
  private protectedResources = new Set<string>();
  private protectionStore?: SecureFormProtectionStore;
  private elicitor?: (confirmation: Confirmation) => Promise<boolean>;
  setElicitor(handler?: (confirmation: Confirmation) => Promise<boolean>) {
    this.elicitor = handler;
  }
  constructor(readonly options: ServiceOptions) {
    this.history =
      options.historyStore ?? new FileHistoryStore(options.history);
    if (options.secureFormProtectionDirectory)
      this.protectionStore = new SecureFormProtectionStore(
        options.secureFormProtectionDirectory,
      );
    this.janitor = setInterval(
      () => {
        void this.reap().catch(() => {});
      },
      Math.min(options.idleMs ?? 900000, 30000),
    );
    this.janitor.unref();
  }
  async createSession({
    runId = randomUUID(),
    goal,
    profile = this.options.defaultProfile ??
      Object.keys(this.options.profiles)[0],
  }: { profile?: string; runId?: string; goal?: string } = {}) {
    safeId(runId);
    const factory = this.options.profiles[profile];
    if (!factory)
      throw executionError(
        "USER_CODE_ERROR",
        "none",
        `Unknown profile: ${profile}`,
      );
    const settings = factory();
    const resourceKey = settings.browser.resourceKey;
    if (resourceKey && this.leases.has(resourceKey))
      throw new CuaError({
        ...executionError(
          "SESSION_BUSY",
          "none",
          "This browser is already leased. Use cua_session_status to inspect it. On the service host, run cua status then cua session-close <sessionId>, and retry. Another MCP connection's sessionId cannot be reused.",
          {
            reason: "browser_leased",
            ...this.leaseDetails(profile, resourceKey),
          },
        ).toJSON(),
        nextAction: "request_user",
        retryable: false,
      });
    if (this.sessions.size + this.creating >= (this.options.maxSessions ?? 4))
      throw executionError("SESSION_LIMIT");
    if (resourceKey) this.leases.add(resourceKey);
    const id = randomUUID();
    const userWaits = { count: 0 };
    this.creating++;
    let directory: string;
    try {
      if (this.protectionStore) {
        await this.protectionStore.prepare();
        if (resourceKey && this.protectionStore.has(resourceKey))
          this.protectedResources.add(resourceKey);
      }
      directory = await mkdtemp(join(tmpdir(), "cua-session-"));
    } catch (error) {
      if (resourceKey) this.leases.delete(resourceKey);
      throw error;
    } finally {
      this.creating--;
    }
    let session!: Session;
    const engine = new CUAEngine({
      userChannel: this.options.userChannel,
      ...settings,
      sessionId: id,
      onSecureFormAccepted: () => {
        this.restrictHistory(session);
        if (resourceKey) {
          this.protectedResources.add(resourceKey);
          this.protectionStore?.mark(resourceKey);
        }
        settings.onSecureFormAccepted?.();
      },
      executionIdForScope: (scopeId) =>
        [...(session?.results.values() ?? [])].find(
          (e) => e.scopeId === scopeId,
        )?.result.executionId,
      onUserWait: (scopeId, waiting) => {
        userWaits.count += waiting ? 1 : -1;
        const e = session?.active;
        if (e && e.scopeId === scopeId) this.pause(session, e, waiting);
      },
      onUserNotice: (scopeId, warning) => {
        const e = [...(session?.results.values() ?? [])].find(
          (x) => x.scopeId === scopeId,
        );
        if (e && e.result.status === "running") {
          e.result.warnings.push(warning);
          e.changed.emit("change");
        } else session?.warnings.push(warning);
      },
    });
    if (resourceKey && this.protectedResources.has(resourceKey))
      engine.enforceSecureFormProtection();
    session = {
      id,
      runId,
      profile,
      engine,
      generation: 0,
      directory,
      results: new Map(),
      dedup: new Map(),
      warnings: [],
      lastFinished: Date.now(),
      pollers: 0,
      outputBytes: 0,
      closing: false,
      intentionalExit: false,
      resourceKey,
      userWaits,
      control: "agent",
      humanActions: 0,
    };
    session.stopHistory = engine.coordinator.observe((scopeId, operation) => {
      const execution = [...session.results.values()].find(
        (e) => e.scopeId === scopeId,
      );
      if (execution)
        this.record(session, "operation.changed", operation, {
          executionId: execution.result.executionId,
          callId:
            this.sdkHistoryContext.getStore()?.executionId ===
            execution.result.executionId
              ? this.sdkHistoryContext.getStore()?.callId
              : undefined,
        });
    });
    this.sessions.set(id, session);
    let historyReady = false;
    try {
      this.history.append(
        runId,
        "session.created",
        { profile, goal },
        { sessionId: id },
      );
      if (engine.isSecureFormProtected()) this.restrictHistory(session);
      historyReady = true;
      await this.startWorker(session);
    } catch (e) {
      session.stopHistory?.();
      this.sessions.delete(id);
      if (resourceKey) this.leases.delete(resourceKey);
      await rm(directory, { recursive: true, force: true });
      throw executionError(
        historyReady ? "WORKER_EXITED" : "HISTORY_WRITE_FAILED",
        "none",
        historyReady
          ? "Worker failed its startup ping."
          : "Cannot create durable execution history.",
      );
    }
    return {
      sessionId: id,
      runId,
      profile,
      provider: settings.browser.descriptor.id,
      capabilities: engine.describe().capabilities,
      api: API_HELP,
      apiReference: API_REFERENCE,
    };
  }
  /** Metadata only: does not create a session, connect, or disclose browser state. */
  leaseStatus(
    profile = this.options.defaultProfile ??
      Object.keys(this.options.profiles)[0],
  ) {
    const factory = this.options.profiles[profile];
    if (!factory)
      throw executionError("USER_CODE_ERROR", "none", "Unknown profile");
    return this.leaseDetails(profile, factory().browser.resourceKey);
  }
  private leaseDetails(profile: string, key?: string) {
    const owner = key
      ? [...this.sessions.values()].find((s) => s.resourceKey === key)
      : undefined;
    return {
      profile,
      leased: !!key && this.leases.has(key),
      owner: owner
        ? this.status().find((s) => s.sessionId === owner.id)
        : undefined,
      recovery:
        "On the service host: cua status, then cua session-close <sessionId>. Active or human-controlled sessions require an explicit --force.",
    };
  }
  /** Local operator endpoint only; MCP connections cannot close another owner's session. */
  async releaseSession({
    sessionId,
    force = false,
  }: {
    sessionId: string;
    force?: boolean;
  }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw executionError("RESULT_EXPIRED");
    if (
      !force &&
      (s.active ||
        s.pollers ||
        s.control !== "agent" ||
        s.humanActions ||
        s.userWaits.count ||
        s.engine.waitingForUser())
    )
      throw executionError(
        "SESSION_BUSY",
        "none",
        "Session is active or waiting for human input. Use --force only to intentionally cancel it.",
      );
    return this.closeSession({ sessionId });
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.closing)
      throw executionError(
        "RESULT_EXPIRED",
        "none",
        "Session is closed or unavailable.",
      );
    return s;
  }
  private async startWorker(s: Session) {
    s.intentionalExit = false;
    const generation = s.engine.generation;
    s.generation = generation;
    const worker = launchWorker({
      cwd: s.directory,
      onMessage: (m) => {
        if (s.worker === worker)
          void this.onMessage(s, m).catch(() => this.fault(s, "WORKER_FAULT"));
      },
      onExit: () => {
        if (s.worker === worker && !s.intentionalExit && !s.closing)
          this.fault(s, "WORKER_EXITED");
      },
    });
    s.worker = worker;
    await worker.ready;
  }
  private fault(s: Session, code: "WORKER_FAULT" | "WORKER_EXITED") {
    const active = s.active;
    if (active) {
      s.engine.coordinator.closeScope(active.scopeId);
      active.result.stateImpact = "repl_restarted";
      active.result.error = executionError(
        code,
        aggregate(active.result.operations),
      ).toJSON();
      this.finish(s, active, "failed");
    }
    s.intentionalExit = true;
    void s.worker?.kill();
    s.worker = undefined;
    s.engine.reset();
  }
  private async onMessage(s: Session, m: WorkerMessage) {
    if (m.type === "warning") {
      if (s.engine.isSecureFormProtected()) return;
      const e = [...s.results.values()].find(
        (e) => e.scopeId === m.warning.scopeId,
      );
      if (e && e.result.status === "running") e.result.warnings.push(m.warning);
      else s.warnings.push(m.warning);
      return;
    }
    if (m.type === "fault") {
      this.fault(s, "WORKER_FAULT");
      return;
    }
    if (m.type === "sdk") {
      const worker = s.worker;
      const execution = [...s.results.values()].find(
        (e) => e.scopeId === m.request.scopeId,
      );
      const context = {
        sessionId: s.id,
        executionId: execution?.result.executionId,
        callId: m.id,
      };

      try {
        if (
          m.request.sessionId !== s.id ||
          m.request.generation !== s.engine.generation
        )
          throw operationError("HANDLE_STALE");
        if (s.control !== "agent") throw operationError("TAB_HANDED_OFF");
        if (
          ["auth.request", "secureForm.request", "handoff.request"].includes(
            m.request.method,
          )
        ) {
          this.restrictHistory(s);
        }
        this.record(
          s,
          "sdk.started",
          {
            method: m.request.method,
            tabId: m.request.tabId,
            args: m.request.args,
          },
          context,
        );
        let value: unknown;
        try {
          value = await this.sdkHistoryContext.run(context, () =>
            s.engine.dispatch(m.request),
          );
        } catch (error) {
          const active = s.active;
          const policy = s.engine.policy;
          if (
            !(error instanceof CuaError) ||
            error.code !== "POLICY_CONFIRMATION_REQUIRED" ||
            !this.elicitor ||
            !(policy instanceof DefaultPolicyProvider) ||
            !active ||
            active.scopeId !== m.request.scopeId
          )
            throw error;
          const confirmation = policy.confirmation(
            String(error.diagnostics?.confirmationId),
          );
          if (!confirmation) throw error;
          this.pause(s, active, true);
          try {
            const approved = await this.elicitor(confirmation);
            if (!policy.decide(confirmation.id, approved) || !approved)
              throw operationError("POLICY_BLOCKED", {
                message:
                  "User did not approve this origin. Do not bypass policy using indirect access.",
              });
          } finally {
            this.pause(s, active, false);
          }
          s.engine.coordinator.check(m.request.scopeId);
          value = await this.sdkHistoryContext.run(context, () =>
            s.engine.dispatch(m.request),
          );
        }
        let evidence: unknown;
        if (
          m.request.method === "screenshot.capture" &&
          !s.engine.isSecureFormProtected()
        ) {
          const shot = s.engine.images.get(
            (value as { imageId: string }).imageId,
          );
          if (shot) {
            try {
              evidence = this.historyWork(s, () =>
                this.history.artifact(
                  s.runId,
                  s.id,
                  shot.bytes,
                  shot.metadata.mimeType,
                ),
              );
            } catch {
              this.historyWarning(s);
            }
          }
        }
        this.record(
          s,
          "sdk.finished",
          {
            method: m.request.method,
            tabId: m.request.tabId,
            status: "succeeded",
            value,
            evidence,
          },
          context,
        );
        worker?.send({
          type: "sdkResult",
          id: m.id,
          value,
          generation: s.engine.generation,
        });
      } catch (e) {
        const error =
          e instanceof CuaError ? e : operationError("ACTION_OUTCOME_UNKNOWN");
        if (
          [
            "SECURE_INPUT_REQUIRED",
            "CREDENTIAL_PROTECTED",
            "SECURE_FORM_PROTECTED",
          ].includes(error.code)
        ) {
          try {
            this.restrictHistory(s);
          } catch {
            this.historyWarning(s);
          }
        }
        this.record(
          s,
          "sdk.finished",
          {
            method: m.request.method,
            tabId: m.request.tabId,
            status: "failed",
            error: error.toJSON(),
            phase: error.phase,
            outcome: error.outcome,
          },
          context,
        );
        if (
          this.history.config.captureOnFailure &&
          execution &&
          m.request.tabId &&
          !s.engine.isSecureFormProtected()
        ) {
          try {
            const shot = (await s.engine.dispatch({
              ...m.request,
              method: "screenshot.capture",
              args: [m.request.args[0], {}],
            })) as { imageId: string };
            const image = s.engine.images.get(shot.imageId);
            if (image)
              this.record(
                s,
                "failure.evidence",
                {
                  evidence: this.historyWork(s, () =>
                    this.history.artifact(
                      s.runId,
                      s.id,
                      image.bytes,
                      image.metadata.mimeType,
                    ),
                  ),
                },
                context,
              );
          } catch {
            this.record(s, "failure.evidence", { unavailable: true }, context);
          }
        }
        worker?.send({
          type: "sdkResult",
          id: m.id,
          error: s.engine.isSecureFormProtected()
            ? this.privateError(error.toJSON(), "operation")
            : error.toJSON(),
        });
      }
      return;
    }
    if (m.type === "output") {
      const e = [...s.results.values()].find((e) => e.scopeId === m.scopeId);
      if (!e || e.result.status !== "running") return;
      e.outputQueue = e.outputQueue.then(() => this.output(s, e, m));
      await e.outputQueue;
      return;
    }
    if (m.type === "moduleEnded" || m.type === "drained") {
      const e = [...s.results.values()].find((e) => e.scopeId === m.scopeId);
      if (!e) return;
      if (m.type === "moduleEnded") {
        e.moduleEnded = true;
        return;
      }
      if (e.terminating || e.result.status !== "running") return;
      await e.outputQueue;
      if (m.error) {
        const agg = aggregate(e.result.operations);
        const code = [
          "SYNTAX_ERROR",
          "SYNTAX_INCOMPLETE",
          "STATIC_IMPORT_UNSUPPORTED",
        ].includes(m.error.code)
          ? m.error.code
          : "USER_CODE_ERROR";
        e.result.error = executionError(
          code,
          agg,
          s.engine.isSecureFormProtected() ? undefined : m.error.message,
        ).toJSON();
      }
      this.finish(s, e, m.error ? "failed" : "succeeded");
    }
  }
  private async output(
    s: Session,
    e: Execution,
    m: Extract<WorkerMessage, { type: "output" }>,
  ) {
    // Check both before interpreting worker data and after asynchronous file writes.
    // Protected state can start while an older output is queued or being persisted.
    if (s.engine.isSecureFormProtected()) {
      const value = (m.value as { value?: unknown })?.value;
      const text =
        m.kind === "json" ? this.secureStateOutput(s, value) : undefined;
      if (text !== undefined) {
        const bytes = Buffer.byteLength(text);
        if (
          e.bytes + bytes <=
            (this.options.maxOutputBytes ?? 16 * 1024 * 1024) &&
          s.outputBytes + bytes <=
            (this.options.maxSessionOutputBytes ?? 64 * 1024 * 1024)
        ) {
          e.result.output.push({
            sequence: e.result.output.length,
            type: "json",
            text,
          });
          e.bytes += bytes;
          s.outputBytes += bytes;
          e.changed.emit("change");
        }
      }
      return;
    }
    const wrapped = m.value as { value: unknown; observationId?: string };
    const item: OutputItem = { sequence: e.result.output.length, type: m.kind };
    let bytes = 0;
    let fileBytes: Uint8Array | undefined;
    if (m.kind === "image") {
      const id = (wrapped.value as { imageId?: string })?.imageId;
      const image = id ? s.engine.images.get(id) : undefined;
      if (!image) {
        e.result.warnings.push({
          code: "OUTPUT_EXPIRED",
          message: "Image handle is no longer available.",
        });
        return;
      }
      bytes = image.bytes.length;
      if (bytes > (this.options.maxImageBytes ?? 5 * 1024 * 1024)) {
        e.result.warnings.push({
          code: "OUTPUT_TRUNCATED",
          message: "Image exceeded the configured size limit.",
        });
        return;
      }
      item.imageId = id;
      item.mimeType = image.metadata.mimeType;
      if (this.options.imageOutput === "file") {
        item.path = join(s.directory, `${e.result.executionId}-${id}.jpg`);
        fileBytes = image.bytes;
      } else item.data = Buffer.from(image.bytes).toString("base64");
    } else {
      let text =
        typeof wrapped.value === "string"
          ? wrapped.value
          : (JSON.stringify(wrapped.value) ?? String(wrapped.value));
      const max = this.options.maxTextChars ?? 100000;
      if (text.length > max) {
        text = text.slice(0, max);
        item.truncated = true;
      }
      item.text = text;
      bytes = Buffer.byteLength(text);
      if (!item.truncated) item.observationId = wrapped.observationId;
    }
    if (
      e.bytes + bytes > (this.options.maxOutputBytes ?? 16 * 1024 * 1024) ||
      s.outputBytes + bytes >
        (this.options.maxSessionOutputBytes ?? 64 * 1024 * 1024)
    ) {
      e.result.warnings.push({
        code: "OUTPUT_TRUNCATED",
        message: "Output storage limit reached.",
      });
      return;
    }
    if (item.path && fileBytes)
      await writeFile(item.path, fileBytes, { mode: 0o600 });
    if (s.engine.isSecureFormProtected()) {
      if (item.path) await rm(item.path, { force: true }).catch(() => {});
      return;
    }
    e.bytes += bytes;
    s.outputBytes += bytes;
    e.result.output.push(item);
    this.record(
      s,
      "execution.output",
      m.kind === "image"
        ? { type: "image", evidence: "see sdk.finished" }
        : item,
      { executionId: e.result.executionId },
    );
    e.changed.emit("change");
  }
  async execute({
    sessionId,
    code,
    requestId = randomUUID(),
    timeoutMs = this.options.cellTimeoutMs ?? 60000,
  }: {
    sessionId: string;
    code: string;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<ExecutionResult> {
    const s = this.session(sessionId);
    if (s.control !== "agent")
      throw executionError(
        "SESSION_BUSY",
        "none",
        "The host has paused model execution for human control.",
      );
    const hash = createHash("sha256").update(code).digest("hex");
    const prior = s.dedup.get(requestId);
    if (prior) {
      if (prior.hash !== hash) throw executionError("REQUEST_ID_CONFLICT");
      const e = s.results.get(prior.id);
      if (!e)
        throw executionError(
          "RESULT_EXPIRED",
          "none",
          "The original execution result expired.",
          { executionId: prior.id, status: prior.status },
        );
      return this.result(s, e);
    }
    if (s.active) throw executionError("SESSION_BUSY");
    if (s.dedup.size >= (this.options.maxDedup ?? 10000))
      throw executionError("DEDUP_LIMIT");
    // Reserve the session before the async worker startup; concurrent calls cannot start two workers.
    const executionId = randomUUID(),
      scopeId = s.engine.coordinator.openScope();
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const e: Execution = {
      result: {
        executionId,
        runId: s.runId,
        status: "running",
        operations: s.engine.coordinator.operations(scopeId),
        aggregateOutcome: "none",
        stateImpact: "none",
        output: [],
        warnings: s.warnings.splice(0),
      },
      scopeId,
      moduleEnded: false,
      done,
      resolve,
      changed: new EventEmitter(),
      created: Date.now(),
      bytes: 0,
      generation: s.engine.generation,
      outputQueue: Promise.resolve(),
      delivered: new Set(),
      remainingMs: Math.max(
        1,
        Math.min(timeoutMs, this.options.maxCellTimeoutMs ?? 300000),
      ),
      deadline: 0,
      pauses: 0,
    };
    try {
      if (s.engine.isSecureFormProtected()) this.restrictHistory(s);
      this.history.append(
        s.runId,
        "execution.started",
        { code, codeHash: hash, requestId, timeoutMs },
        { sessionId: s.id, executionId },
      );
    } catch {
      s.engine.coordinator.closeScope(scopeId);
      s.engine.coordinator.forget(scopeId);
      throw executionError("HISTORY_WRITE_FAILED");
    }
    s.active = e;
    s.results.set(executionId, e);
    s.dedup.set(requestId, { hash, id: executionId, status: "running" });
    try {
      if (!s.worker) await this.startWorker(s);
      if (s.control !== "agent" || e.result.status !== "running")
        return this.result(s, e);
      this.armTimeout(s, e);
      s.worker!.send({
        type: "execute",
        scopeId,
        code,
        sessionId: s.id,
        generation: s.engine.generation,
      });
    } catch {
      this.fault(s, "WORKER_EXITED");
    }
    await this.wait(e, this.options.executeWaitMs ?? 20000);
    return this.result(s, e);
  }
  private armTimeout(s: Session, e: Execution) {
    e.deadline = Date.now() + e.remainingMs;
    e.timer = setTimeout(() => {
      void this.terminate(s, e, "timed_out");
    }, e.remainingMs);
  }
  /** Stops the cell deadline while a person is answering; nested waits are counted. */
  private pause(s: Session, e: Execution, paused: boolean) {
    if (paused) {
      if (e.pauses++ === 0) {
        clearTimeout(e.timer);
        e.remainingMs = Math.max(1, e.deadline - Date.now());
      }
    } else if (
      --e.pauses === 0 &&
      e.result.status === "running" &&
      !e.terminating
    )
      this.armTimeout(s, e);
  }
  private async wait(e: Execution, ms: number) {
    if (e.result.status !== "running" || ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        e.done,
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private secureStateOutput(s: Session, value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const requestId = (value as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    try {
      // The worker supplies only a lookup key. Never echo its state or extras.
      return JSON.stringify(
        secureFormPublicState(this.secureFormState(s.id, requestId)),
      );
    } catch {
      return;
    }
  }
  private privateError(
    error: NonNullable<ExecutionResult["error"]>,
    level: "operation" | "execution",
  ): NonNullable<ExecutionResult["error"]> {
    const table =
      level === "operation" ? operationErrorTable : executionErrorTable;
    return {
      code: table.some((row) => row.code === error.code)
        ? error.code
        : level === "operation"
          ? "ACTION_OUTCOME_UNKNOWN"
          : "USER_CODE_ERROR",
      level,
      layer: "service",
      nextAction: "request_user",
      retryable: false,
      message:
        "Private workflow details are restricted. Use the secure form receipt or human review; do not replay input.",
    };
  }
  private result(s: Session, e: Execution, cursor = 0): ExecutionResult {
    e.result.aggregateOutcome = aggregate(e.result.operations);
    if (s.engine.isSecureFormProtected()) {
      // Polls and deduplicated executions must not resurrect output cached before
      // protection. Forget all cached raw output and unlink prior file images.
      for (const cached of s.results.values()) {
        const oldBytes = cached.bytes;
        cached.bytes = 0;
        cached.result.output = cached.result.output.map((item) => {
          if (item.path) void rm(item.path, { force: true }).catch(() => {});
          let text: string | undefined;
          if (item.type === "json" && item.text && !item.truncated) {
            try {
              text = this.secureStateOutput(s, JSON.parse(item.text));
            } catch {}
          }
          if (text !== undefined) {
            cached.bytes += Buffer.byteLength(text);
            return { sequence: item.sequence, type: "json", text };
          }
          // Preserve sequence/cursor positions without retaining raw payloads.
          return { sequence: item.sequence, type: "text" };
        });
        cached.delivered.clear();
        s.outputBytes += cached.bytes - oldBytes;
      }
      const safeKinds = new Set([
        "connect",
        "close",
        "describe",
        "tabs.list",
        "tabs.get",
        "tabs.create",
        "tab.close",
        "goto",
        "reload",
        "back",
        "forward",
        "info",
        "frames",
        "ax.snapshot",
        "dom.snapshot",
        "dom.inspect",
        "screenshot.capture",
        "evaluate",
        "waitForFunction",
        "actions.click",
        "actions.fill",
        "actions.press",
        "actions.select",
        "actions.hover",
        "secureForm.request",
        "secureForm.deliver",
        "secureForm.status",
        "auth.request",
        "handoff.request",
        "handoff.wait",
        "handoff.status",
      ]);
      const operations = e.result.operations.map((operation, index) => ({
        operationId: /^[a-f0-9-]{36}$/.test(operation.operationId)
          ? operation.operationId
          : `protected-operation-${index}`,
        kind: safeKinds.has(operation.kind)
          ? operation.kind
          : "private_operation",
        status: operation.status,
        phase: operation.phase,
        outcome: operation.outcome,
        ...(operation.error
          ? { error: this.privateError(operation.error, "operation") }
          : {}),
      }));
      return structuredClone({
        executionId: e.result.executionId,
        runId: s.runId,
        status: e.result.status,
        ...(e.result.error
          ? { error: this.privateError(e.result.error, "execution") }
          : {}),
        operations,
        aggregateOutcome: aggregate(operations),
        stateImpact: e.result.stateImpact,
        output: e.result.output
          .slice(cursor)
          .filter((item) => item.type === "json" && item.text !== undefined),
        cursor: e.result.output.length,
        warnings: [
          {
            code: "SECURE_FORM_PROTECTED",
            message:
              "Raw output and diagnostics are withheld for this private workflow. Query the private secure form receipt or request human review; do not replay input.",
          },
        ],
      });
    }
    const output = e.result.output.slice(cursor);
    for (const item of output)
      if (item.observationId && !item.truncated)
        e.delivered.add(item.observationId);
    if (e.result.status === "succeeded")
      for (const id of e.delivered) s.engine.markDelivered(id);
    return structuredClone({
      ...e.result,
      output,
      cursor: e.result.output.length,
    });
  }
  async getExecution({
    sessionId,
    executionId,
    cursor = 0,
    waitMs = 20000,
  }: {
    sessionId: string;
    executionId: string;
    cursor?: number;
    waitMs?: number;
  }) {
    const s = this.session(sessionId);
    const e = s.results.get(executionId);
    if (!e) throw executionError("RESULT_EXPIRED");
    s.pollers++;
    try {
      if (e.result.output.length <= cursor && e.result.status === "running") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake!: () => void;
        try {
          await new Promise<void>((resolve) => {
            wake = resolve;
            e.changed.once("change", wake);
            timer = setTimeout(resolve, Math.max(0, Math.min(waitMs, 30000)));
          });
        } finally {
          clearTimeout(timer);
          e.changed.off("change", wake);
        }
      }
      return this.result(s, e, cursor);
    } finally {
      s.pollers--;
    }
  }
  /** Host UI access never connects a new browser or claims an unrelated tab. */
  async openHumanView(sessionId: string, tabId: string) {
    return this.session(sessionId).engine.openHumanView(tabId);
  }
  humanRequests(sessionId: string) {
    this.session(sessionId);
    return this.options.userChannel instanceof PendingUserChannel
      ? this.options.userChannel.listForSession(sessionId)
      : [];
  }
  /** Private host-only views. They never traverse worker IPC. */
  secureFormState(sessionId: string, id: string) {
    const session = this.session(sessionId),
      channel = this.options.userChannel;
    if (!(channel instanceof PendingUserChannel))
      throw Error("Secure form unavailable.");
    const state = channel.secureFormState(id);
    if (!state || state.sessionId !== sessionId)
      throw Error("Secure form unavailable.");
    const executionId =
      state.executionId ??
      [...session.results.values()].find((e) => e.scopeId === state.scopeId)
        ?.result.executionId;
    return { ...state, executionId };
  }
  answerSecureForm(sessionId: string, id: string, answer: SecureFormAnswer) {
    this.secureFormState(sessionId, id);
    (this.options.userChannel as PendingUserChannel).answerSecureForm(
      id,
      answer,
    );
    return this.secureFormState(sessionId, id);
  }
  answerHumanRequest(
    sessionId: string,
    id: string,
    action: "submit" | "decline" | "resume",
    values?: Record<string, string>,
  ) {
    const request = this.humanRequests(sessionId).find((r) => r.id === id);
    const channel = this.options.userChannel;
    if (!request || !(channel instanceof PendingUserChannel))
      throw Error("Human request expired or unavailable.");
    const accepted =
      action === "decline"
        ? channel.decline(id)
        : action === "submit" && request.type === "credentials"
          ? channel.submitCredentials(id, values)
          : action === "resume" && request.type === "handoff"
            ? channel.resume(id)
            : false;
    if (!accepted) throw Error("Human request expired or invalid.");
  }
  /** Host-only control plane; these methods are never exposed to model code. */
  async interruptSession({
    sessionId,
    takeControl = false,
    settleMs = 10000,
  }: {
    sessionId: string;
    takeControl?: boolean;
    settleMs?: number;
  }) {
    const s = this.session(sessionId);
    if (s.control === "interrupting" || s.humanActions)
      throw executionError("SESSION_BUSY");
    // Gate new executions synchronously, before yielding to cancellation.
    this.restrictHistory(s);
    s.control = "interrupting";
    this.record(s, "control.changed", { control: s.control });
    try {
      if (s.active) await this.terminate(s, s.active, "cancelled");
      const deadline = Date.now() + Math.max(0, Math.min(settleMs, 10000));
      while (
        s.engine.coordinator.hasPendingOperations() &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 10));
      if (s.engine.coordinator.hasPendingOperations())
        throw executionError(
          "SESSION_BUSY",
          "none",
          "Browser actions are still settling. Control remains paused; retry after they finish.",
        );
      await s.engine.protectHumanPages();
      s.control = takeControl ? "human" : "paused";
      this.record(s, "control.changed", { control: s.control });
      return { sessionId, control: s.control };
    } catch (e) {
      s.control = "paused";
      throw e;
    }
  }
  async resumeSession({ sessionId }: { sessionId: string }) {
    const s = this.session(sessionId);
    if (s.control === "agent") return { sessionId, control: s.control };
    if (
      s.control === "interrupting" ||
      s.humanActions ||
      s.engine.coordinator.hasPendingOperations()
    )
      throw executionError("SESSION_BUSY");
    this.restrictHistory(s);
    s.control = "interrupting";
    this.record(s, "control.changed", { control: s.control });
    try {
      // Include any documents opened during human control, then discard stale model handles.
      await s.engine.protectHumanPages();
      await this.resetSession({ sessionId });
      s.control = "agent";
      this.record(s, "control.changed", { control: s.control });
      return { sessionId, control: s.control };
    } catch (e) {
      s.control = "paused";
      throw e;
    }
  }
  async runHumanAction<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const s = this.session(sessionId);
    if (s.control !== "human")
      throw executionError(
        "SESSION_BUSY",
        "none",
        "Acquire human control before sending input.",
      );
    s.humanActions++;
    try {
      return await action();
    } finally {
      s.humanActions--;
    }
  }
  async cancelExecution({
    sessionId,
    executionId,
  }: {
    sessionId: string;
    executionId: string;
  }) {
    const s = this.session(sessionId);
    const e = s.results.get(executionId);
    if (!e) throw executionError("RESULT_EXPIRED");
    if (e.result.status === "running") await this.terminate(s, e, "cancelled");
    return this.result(s, e);
  }
  private terminate(
    s: Session,
    e: Execution,
    status: "cancelled" | "timed_out",
  ): Promise<void> {
    if (e.terminating) return e.terminating;
    // Synchronous, irreversible closure happens before cancellation is delivered to the worker.
    s.engine.coordinator.closeScope(e.scopeId);
    clearTimeout(e.timer);
    e.terminating = (async () => {
      s.worker?.send({ type: "closeScope", scopeId: e.scopeId });
      const deadline = Date.now() + (this.options.terminationGraceMs ?? 2000);
      while (
        Date.now() < deadline &&
        (!e.moduleEnded || !s.engine.coordinator.isSettled(e.scopeId))
      )
        await new Promise((r) => setTimeout(r, 5));
      const agg = aggregate(e.result.operations);
      await e.outputQueue.catch(() => {});
      if (!e.moduleEnded) {
        s.intentionalExit = true;
        await s.worker?.kill();
        s.worker = undefined;
        s.engine.reset();
        e.result.stateImpact = "repl_restarted";
        e.result.error = executionError("WORKER_UNRESPONSIVE", agg).toJSON();
      } else
        e.result.error = executionError(
          status === "cancelled" ? "EXECUTION_CANCELLED" : "EXECUTION_TIMEOUT",
          agg,
        ).toJSON();
      this.finish(s, e, status);
    })();
    return e.terminating;
  }
  private finish(s: Session, e: Execution, status: ExecutionResult["status"]) {
    if (e.result.status !== "running") return;
    s.engine.coordinator.closeScope(e.scopeId);
    clearTimeout(e.timer);
    e.result.status = status;
    e.result.aggregateOutcome = aggregate(e.result.operations);
    e.finished = Date.now();
    s.lastFinished = e.finished;
    for (const d of s.dedup.values())
      if (d.id === e.result.executionId) d.status = status;
    this.record(
      s,
      "execution.finished",
      {
        ...e.result,
        output: e.result.output.map(({ data, path, ...item }) => ({
          ...item,
          ...(data || path ? { image: "see sdk.finished evidence" } : {}),
        })),
      },
      { executionId: e.result.executionId },
    );
    if (s.active === e) s.active = undefined;
    e.resolve();
    e.changed.emit("change");
    this.prune(s);
  }
  /** Recorder I/O is host overhead, not part of the user code deadline. */
  private historyWork<T>(s: Session, work: () => T): T {
    const e = s?.active;
    const paused =
      !!e && e.result.status === "running" && e.deadline > 0 && !e.terminating;
    if (paused) this.pause(s, e, true);
    try {
      return work();
    } finally {
      if (paused) this.pause(s, e, false);
    }
  }
  private restrictHistory(s: Session) {
    return this.historyWork(s, () =>
      this.history.restrictSession(s.runId, s.id),
    );
  }
  private historyWarning(s: Session) {
    const warnings = s.active?.result.warnings ?? s.warnings;
    if (!warnings.some((w) => w.code === "HISTORY_WRITE_FAILED"))
      warnings.push({
        code: "HISTORY_WRITE_FAILED",
        message:
          "Execution may have occurred, but part of its history could not be saved. Do not replay automatically.",
      });
  }
  private record(
    s: Session,
    type: string,
    data: unknown,
    context: { executionId?: string; callId?: string } = {},
  ) {
    try {
      if (s.engine.isSecureFormProtected()) this.restrictHistory(s);
      this.historyWork(s, () =>
        this.history.append(s.runId, type, data, {
          sessionId: s.id,
          ...context,
        }),
      );
    } catch {
      this.historyWarning(s);
    }
  }
  private prune(s: Session) {
    const entries = [...s.results];
    for (const [id, e] of entries) {
      if (e.result.status === "running") continue;
      if (
        Date.now() - (e.finished ?? e.created) >
          (this.options.resultTtlMs ?? 1800000) ||
        s.results.size > (this.options.maxResults ?? 100)
      ) {
        s.results.delete(id);
        for (const item of e.result.output)
          if (item.path) void rm(item.path, { force: true }).catch(() => {});
        s.outputBytes -= e.bytes;
        s.engine.coordinator.forget(e.scopeId);
      }
    }
  }
  async resetSession({ sessionId }: { sessionId: string }) {
    const s = this.session(sessionId);
    if (s.active) throw executionError("SESSION_BUSY");
    s.intentionalExit = true;
    await s.worker?.kill();
    s.worker = undefined;
    s.engine.reset();
    await this.startWorker(s);
    this.record(s, "session.reset", { generation: s.engine.generation });
    return {
      sessionId,
      stateImpact: "repl_restarted",
      nextAction: "reacquire_handle",
    };
  }
  async closeSession({ sessionId }: { sessionId: string }) {
    const pending = this.sessionClosures.get(sessionId);
    if (pending) return pending;
    const s = this.sessions.get(sessionId);
    if (!s) return { sessionId, closed: true };
    // Revoke authority before any await; concurrent cleanup must share one task.
    s.closing = true;
    const closing = (async () => {
      if (s.active) await this.terminate(s, s.active, "cancelled");
      s.intentionalExit = true;
      await s.worker?.kill();
      try {
        await s.engine.close();
      } catch {
        return {
          sessionId,
          closed: false,
          error: executionError("CLEANUP_INCOMPLETE").toJSON(),
        };
      }
      await rm(s.directory, { recursive: true, force: true });
      this.record(s, "session.closed", { closed: true });
      s.stopHistory?.();
      this.sessions.delete(sessionId);
      if (s.resourceKey) this.leases.delete(s.resourceKey);
      return { sessionId, closed: true };
    })();
    this.sessionClosures.set(sessionId, closing);
    try {
      return await closing;
    } finally {
      this.sessionClosures.delete(sessionId);
    }
  }
  async describe({ sessionId }: { sessionId: string }) {
    const s = this.session(sessionId);
    // No health probe is needed for a restricted summary: provider errors and
    // blocked-site history can contain page URLs, titles, or user information.
    const restricted = () => {
      const description = s.engine.describe();
      return {
        sessionId: s.id,
        generation: s.engine.generation,
        connected: description.connected,
        capabilities: description.capabilities.filter((name) =>
          ["ax", "dom", "screenshot", "action"].includes(name),
        ),
        profile: s.profile,
        workerAlive: !!s.worker?.process.connected,
        secureFormProtected: true,
        health: { browser: "restricted", cdp: "restricted" },
        api: API_HELP,
        apiReference: API_REFERENCE,
      };
    };
    if (s.engine.isSecureFormProtected()) return restricted();
    const health = await s.engine.health();
    if (s.engine.isSecureFormProtected()) return restricted();
    return {
      ...s.engine.describe(),
      profile: s.profile,
      workerAlive: !!s.worker?.process.connected,
      health,
      api: API_HELP,
      apiReference: API_REFERENCE,
    };
  }
  status() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      runId: s.runId,
      profile: s.profile,
      status: s.closing ? "closing" : s.active ? "busy" : "idle",
      control: s.control,
      executionId: s.active?.result.executionId,
      waitingForUser:
        s.control !== "agent" ||
        s.userWaits.count > 0 ||
        s.engine.waitingForUser(),
      lastFinished: s.lastFinished,
    }));
  }
  private async reap() {
    for (const s of this.sessions.values()) {
      this.prune(s);
      if (
        s.control === "agent" &&
        !s.active &&
        !s.pollers &&
        !s.userWaits.count &&
        !s.engine.waitingForUser() &&
        Date.now() - s.lastFinished > (this.options.idleMs ?? 900000)
      )
        await this.closeSession({ sessionId: s.id });
    }
  }
  async close() {
    clearInterval(this.janitor);
    return Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        this.closeSession({ sessionId }),
      ),
    );
  }
}
