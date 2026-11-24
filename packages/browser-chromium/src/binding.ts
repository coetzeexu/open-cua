import { openChromiumHumanView } from "./human-view.js";
import { randomUUID } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  Page,
  Frame,
  Dialog,
  ElementHandle,
} from "playwright";
import {
  operationError,
  type BrowserConnection,
  type TabBinding,
  type TabInfo,
  type FrameInfo,
  type OperationContext,
  type DialogInfo,
  type Warning,
  type ElementRef,
  type HandoffTarget,
} from "@cua/contracts";
import { ChromiumCDPTransport } from "./transport.js";
import { ChromiumTargetResolver } from "./capabilities.js";
export interface FrameRecord {
  id: string;
  frame: Frame;
  epoch: number;
  /** Document identity is separate from reference invalidation on URL changes. */
  documentEpoch: number;
  loaderId?: string;
  registry: string;
  cdp?: ChromiumCDPTransport;
  contextId?: number;
  protocolFrameId?: string;
}
export interface RefRecord {
  ref: ElementRef;
  backendId: number;
  registry: string;
  usedAt: number;
  sensitive?: boolean;
}
export class ChromiumTab implements TabBinding {
  readonly kind = "chromium";
  readonly id = randomUUID();
  epoch = 0;
  viewportRevision = 0;
  deliverable = false;
  state: TabInfo["state"] = "ready";
  readonly framesById = new Map<string, FrameRecord>();
  readonly refs = new Map<string, RefRecord>();
  readonly expired = new Set<string>();
  private frameIds = new WeakMap<Frame, string>();
  private pending?: { info: DialogInfo; dialog: Dialog };
  private dialogListeners = new Set<(dialog: DialogInfo | undefined) => void>();
  private logs: Record<string, unknown>[] = [];
  private logSequence = 0;
  private navigationDepth = 0;
  private viewportSignature = "";
  private cachedTitle = "";
  private scrollKey = `__cua_scroll_${randomUUID().replaceAll("-", "")}`;
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    public source: TabInfo["source"],
    readonly cloudOwned = false,
  ) {
    for (const frame of page.frames()) this.registerFrame(frame);
    page.on("frameattached", (frame) => this.registerFrame(frame));
    page.on("framenavigated", (frame) => {
      const record = this.registerFrame(frame);
      record.epoch++;
      record.contextId = undefined;
      record.protocolFrameId = undefined;
      record.registry = `__cua_${randomUUID().replaceAll("-", "")}`;
      if (frame === page.mainFrame()) {
        this.epoch++;
        this.viewportRevision++;
      }
      this.removeFrameRefs(record.id);
    });
    page.on("framedetached", (frame) => {
      const id = this.frameIds.get(frame);
      if (id) {
        this.framesById.delete(id);
        this.removeFrameRefs(id);
      }
    });
    page.on("close", () => {
      this.state = "closed";
      this.refs.clear();
    });
    page.on("crash", () => this.quarantine());
    page.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload" && this.navigationDepth > 0) {
        void dialog.accept().catch(() => {});
        return;
      }
      const info = {
        id: randomUUID(),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        appearedAt: Date.now(),
      };
      this.pending = { info, dialog };
      this.state = "dialog_open";
      for (const listener of this.dialogListeners) listener(info);
    });
    page.on("console", (message) => this.log(message.type(), message.text()));
    page.on("pageerror", (error) => this.log("error", error.message));
  }
  private log(level: string, text: string) {
    this.logs.push({
      sequence: ++this.logSequence,
      time: Date.now(),
      level,
      text: text.slice(0, 2000),
    });
    if (this.logs.length > 500) this.logs.shift();
  }
  registerFrame(frame: Frame): FrameRecord {
    let id = this.frameIds.get(frame);
    if (id) return this.framesById.get(id)!;
    id = randomUUID();
    const record = {
      id,
      frame,
      epoch: 0,
      documentEpoch: 0,
      registry: `__cua_${randomUUID().replaceAll("-", "")}`,
    };
    this.frameIds.set(frame, id);
    this.framesById.set(id, record);
    return record;
  }
  frame(id?: string): FrameRecord {
    const r = id
      ? this.framesById.get(id)
      : this.registerFrame(this.page.mainFrame());
    if (!r || r.frame.isDetached()) throw operationError("REF_STALE");
    return r;
  }
  async frameCDP(record: FrameRecord): Promise<ChromiumCDPTransport> {
    if (record.cdp && record.contextId !== undefined) return record.cdp;
    await record.frame.evaluate((key) => {
      if (!(globalThis as any)[key])
        Object.defineProperty(globalThis, key, {
          value: new Map(),
          enumerable: false,
          configurable: true,
        });
    }, record.registry);
    const cdp =
      record.cdp ??
      new ChromiumCDPTransport(async () => {
        // Same-process iframes share their ancestor's CDP target. Keep resolving
        // the child's own execution context below, even when the session is shared.
        let owner: Frame | null = record.frame;
        while (owner) {
          try {
            return await this.context.newCDPSession(owner);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes("does not have a separate CDP session")
            )
              throw error;
            owner = owner.parentFrame();
          }
        }
        throw operationError("CAPABILITY_UNAVAILABLE");
      });
    if (!record.cdp)
      cdp.on("close", () => {
        record.contextId = undefined;
        record.protocolFrameId = undefined;
      });
    record.cdp = cdp;
    const contexts: {
      id: number;
      auxData?: { isDefault?: boolean; frameId?: string };
    }[] = [];
    const listener = (event: any) => contexts.push(event.context);
    cdp.on("Runtime.executionContextCreated", listener);
    await cdp.send("Runtime.disable").catch(() => {});
    await cdp.send("Runtime.enable");
    cdp.off("Runtime.executionContextCreated", listener);
    for (const candidate of contexts.filter((c) => c.auxData?.isDefault)) {
      const result = await cdp
        .send("Runtime.evaluate", {
          expression: `!!globalThis[${JSON.stringify(record.registry)}]`,
          contextId: candidate.id,
          returnByValue: true,
        })
        .catch(() => undefined);
      if (result?.result.value) {
        record.contextId = candidate.id;
        record.protocolFrameId = candidate.auxData?.frameId;
        return cdp;
      }
    }
    throw operationError("CAPABILITY_UNAVAILABLE", {
      message:
        "Unable to resolve the frame main world for identity references.",
    });
  }
  async info(): Promise<TabInfo> {
    if (!this.pending && !this.page.isClosed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.cachedTitle = await Promise.race([
          this.page.title(),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve(this.cachedTitle), 500);
          }),
        ]);
      } catch {
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      id: this.id,
      url: this.page.url(),
      title: this.cachedTitle,
      source: this.source,
      state: this.page.isClosed() ? "closed" : this.state,
      epoch: this.epoch,
      viewportRevision: this.viewportRevision,
      deliverable: this.deliverable,
    };
  }
  async frames(): Promise<FrameInfo[]> {
    // Playwright emits framenavigated for hash/history changes too. Only a
    // different CDP loader proves a new document and may lift input protection.
    for (const r of this.framesById.values()) {
      const cdp = await this.frameCDP(r);
      const tree = await cdp.send("Page.getFrameTree");
      const find = (node: any): string | undefined =>
        node.frame.id === r.protocolFrameId
          ? node.frame.loaderId
          : node.childFrames?.map(find).find(Boolean);
      const loaderId = find(tree.frameTree);
      if (!loaderId)
        throw operationError("CAPABILITY_UNAVAILABLE", {
          message: "Cannot verify frame document identity.",
        });
      if (r.loaderId !== undefined && r.loaderId !== loaderId)
        r.documentEpoch++;
      r.loaderId = loaderId;
    }
    return [...this.framesById.values()].map((r) => ({
      id: r.id,
      url: r.frame.url(),
      epoch: r.documentEpoch,
      parentId: r.frame.parentFrame()
        ? this.frameIds.get(r.frame.parentFrame()!)
        : undefined,
    }));
  }
  dialog() {
    return this.pending?.info;
  }
  onDialog(listener: (dialog: DialogInfo | undefined) => void) {
    this.dialogListeners.add(listener);
    return () => {
      this.dialogListeners.delete(listener);
    };
  }
  async respondDialog(
    id: string,
    { accept, promptText }: { accept: boolean; promptText?: string },
  ) {
    if (this.pending?.info.id !== id) throw operationError("HANDLE_STALE");
    const { dialog } = this.pending;
    if (accept) await dialog.accept(promptText);
    else await dialog.dismiss();
    this.pending = undefined;
    this.state = "ready";
    for (const l of this.dialogListeners) l(undefined);
  }
  async navigate(
    kind: "goto" | "reload" | "back" | "forward",
    url: string | undefined,
    ctx: OperationContext,
  ) {
    ctx.dispatch();
    this.navigationDepth++;
    try {
      const opts = {
        waitUntil: "domcontentloaded" as const,
        timeout: ctx.timeoutMs + 5000,
      };
      if (kind === "goto") await this.page.goto(url!, opts);
      else if (kind === "reload") await this.page.reload(opts);
      else if (kind === "back") await this.page.goBack(opts);
      else await this.page.goForward(opts);
      ctx.afterDispatch();
    } finally {
      this.navigationDepth--;
    }
  }
  async evaluate(
    source: string,
    args: unknown,
    frameId: string | undefined,
    ctx: OperationContext,
  ) {
    const frame = this.frame(frameId);
    const handles: { dispose(): Promise<void> }[] = [];
    const seen = new WeakMap<object, unknown>();
    const prepare = async (value: unknown): Promise<unknown> => {
      if (!value || typeof value !== "object") return value;
      if ((value as ElementRef).type === "ref") {
        const ref = value as ElementRef;
        if (ref.frameId !== frame.id)
          throw operationError("ACTION_UNSUPPORTED_FOR_TARGET", {
            message: "ElementRef arguments must belong to the evaluate frame.",
          });
        await ctx.policy(frame.frame.url());
        const resolved = await new ChromiumTargetResolver().resolve(
          ref,
          {
            binding: this,
            sessionId: ctx.sessionId,
            generation: ctx.generation,
          },
          ctx,
        );
        handles.push(resolved);
        return (resolved.value as { element: ElementHandle }).element;
      }
      if (seen.has(value)) return seen.get(value);
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        seen.set(value, result);
        for (const item of value) result.push(await prepare(item));
        return result;
      }
      const result: Record<string, unknown> = {};
      seen.set(value, result);
      for (const [key, item] of Object.entries(value))
        result[key] = await prepare(item);
      return result;
    };
    let prepared: unknown;
    try {
      prepared = await prepare(args);
    } catch (error) {
      await Promise.all(handles.map((h) => h.dispose()));
      throw error;
    }
    ctx.dispatch();
    this.viewportRevision++;
    const task = frame.frame.evaluate(
      ({ source, args }) => {
        const fn = (0, eval)(`(${source})`);
        return fn(args);
      },
      { source, args: prepared },
    );
    const aborted = new Promise<never>((_, reject) => {
      const stop = () => reject(operationError("EVALUATE_ABANDONED"));
      if (ctx.signal.aborted) stop();
      else ctx.signal.addEventListener("abort", stop, { once: true });
      task
        .finally(() => ctx.signal.removeEventListener("abort", stop))
        .catch(() => {});
    });
    try {
      const value = await Promise.race([task, aborted]);
      structuredClone(value);
      ctx.afterDispatch();
      return value;
    } catch (e) {
      if (ctx.signal.aborted) {
        await this.recoverEvaluation();
        throw operationError("EVALUATE_ABANDONED");
      }
      throw operationError("PAGE_SCRIPT_ERROR", {
        message: `Page script failed: ${String((e as Error).message).slice(0, 500)}`,
      });
    } finally {
      await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
    }
  }
  async recoverEvaluation(): Promise<"ready" | "quarantined"> {
    this.invalidate();
    const r = this.frame();
    const cdp =
      r.cdp ??
      new ChromiumCDPTransport(() => this.context.newCDPSession(this.page));
    const probe = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          cdp
            .send("Runtime.evaluate", { expression: "1", returnByValue: true })
            .then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 3000);
          }),
        ]);
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };
    if (await probe()) return "ready";
    await Promise.race([
      cdp.send("Runtime.terminateExecution").catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (await probe()) return "ready";
    this.quarantine();
    return "quarantined";
  }
  async revision(ctx?: OperationContext) {
    const signatures: unknown[] = [];
    for (const frame of this.framesById.values()) {
      try {
        if (ctx) await ctx.policy(frame.frame.url());
        signatures.push(
          await frame.frame.evaluate((key) => {
            if (!(globalThis as any)[key]) {
              const state = { revision: 0 };
              Object.defineProperty(globalThis, key, {
                value: state,
                enumerable: false,
              });
              addEventListener("scroll", () => state.revision++, true);
              addEventListener("resize", () => state.revision++);
            }
            return [
              innerWidth,
              innerHeight,
              devicePixelRatio,
              scrollX,
              scrollY,
              (globalThis as any)[key].revision,
            ];
          }, this.scrollKey),
        );
      } catch (error) {
        if (frame.frame === this.page.mainFrame()) throw error;
      }
    }
    const signature = JSON.stringify(signatures);
    if (signature !== this.viewportSignature) {
      this.viewportSignature = signature;
      this.viewportRevision++;
    }
    return this.viewportRevision;
  }
  devLogs(options: Record<string, unknown> = {}) {
    return this.logs
      .filter(
        (l) =>
          Number(l.sequence) > Number(options.since ?? 0) &&
          (!options.levels ||
            (options.levels as string[]).includes(String(l.level))),
      )
      .slice(-Math.min(500, Number(options.limit ?? 100)));
  }
  private removeFrameRefs(frameId: string) {
    for (const [id, ref] of this.refs)
      if (ref.ref.frameId === frameId) this.refs.delete(id);
  }
  invalidate() {
    this.epoch++;
    for (const r of this.framesById.values()) {
      // Frame epochs identify documents. Clearing refs must not lift credential protection.
      void r.frame
        .evaluate((key) => (globalThis as any)[key]?.clear(), r.registry)
        .catch(() => {});
    }
    this.refs.clear();
  }
  quarantine() {
    this.state = "quarantined";
  }
  markDeliverable(value: boolean): Warning | undefined {
    if (this.cloudOwned)
      return {
        code: "DELIVERABLE_IGNORED",
        message: "Owned AgentBay browsers are deleted at session close.",
      };
    this.deliverable = value;
  }
  async close() {
    if (this.source === "claimed" && this.state === "quarantined")
      throw operationError("TAB_QUARANTINED");
    await this.page.close({ runBeforeUnload: false });
  }
}
export class ChromiumBinding implements BrowserConnection {
  readonly kind = "chromium";
  readonly id = randomUUID();
  private pages = new Map<string, ChromiumTab>();
  private pageMap = new WeakMap<Page, ChromiumTab>();
  private users = new Map<string, ChromiumTab>();
  private popupParents = new Map<string, string>();
  private disconnected = false;
  private creating = 0;
  constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly mode: "create" | "attach",
    readonly options: {
      keepBrowserOnClose?: boolean;
      cloudOwned?: boolean;
      onClose?: () => Promise<void>;
      /** Supplies how a person can reach this browser; absent means handoff is unsupported. */
      handoff?: (tab: ChromiumTab) => Promise<HandoffTarget>;
    } = {},
  ) {
    for (const page of context.pages()) {
      const tab = this.wrap(page, mode === "attach" ? "user" : "created");
      if (mode === "attach") {
        this.pages.delete(tab.id);
        this.users.set(tab.id, tab);
      }
    }
    context.on("page", (page) => {
      const tab = this.wrap(page, this.creating ? "created" : "popup");
      if (tab.source === "popup")
        void page.opener().then((opener) => {
          const parent = opener && this.pageMap.get(opener);
          if (parent) this.popupParents.set(tab.id, parent.id);
        });
    });
    browser.on("disconnected", () => {
      this.disconnected = true;
    });
  }
  private wrap(page: Page, source: TabInfo["source"]) {
    const existing = this.pageMap.get(page);
    if (existing) return existing;
    const tab = new ChromiumTab(
      page,
      this.context,
      source,
      this.options.cloudOwned,
    );
    this.pageMap.set(page, tab);
    this.pages.set(tab.id, tab);
    return tab;
  }
  async health() {
    if (this.disconnected || !this.browser.isConnected())
      throw operationError("BROWSER_DISCONNECTED");
    try {
      const cdp = await this.browser.newBrowserCDPSession();
      try {
        await cdp.send("Browser.getVersion");
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      if (this.disconnected || !this.browser.isConnected())
        throw operationError("BROWSER_DISCONNECTED");
      throw error;
    }
  }
  async tabs() {
    return [...this.pages.values()].filter(
      (t) => !t.page.isClosed() && t.source !== "popup",
    );
  }
  async create(url?: string) {
    this.creating++;
    try {
      const page = await this.context.newPage();
      const tab = this.wrap(page, "created");
      tab.source = "created";
      if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
      return tab;
    } finally {
      this.creating--;
    }
  }
  async openHumanView(tabId: string) {
    return openChromiumHumanView((await this.get(tabId)).page);
  }
  async userTabs() {
    return Promise.all(
      [...this.users.values()]
        .filter((t) => !t.page.isClosed())
        .map((t) => t.info()),
    );
  }
  async claim(expected: TabInfo) {
    const tab = this.users.get(expected.id);
    if (!tab) throw operationError("HANDLE_STALE");
    const actual = await tab.info();
    if (
      actual.url !== expected.url ||
      actual.title !== expected.title ||
      actual.state === "closed"
    )
      throw operationError("HANDLE_STALE", {
        message: "The user tab changed; inspect the user tab list again.",
      });
    tab.source = "claimed";
    this.users.delete(tab.id);
    this.pages.set(tab.id, tab);
    return tab;
  }
  async popups(tabId: string) {
    return Promise.all(
      [...this.pages.values()]
        .filter(
          (t) => this.popupParents.get(t.id) === tabId && !t.page.isClosed(),
        )
        .map((t) => t.info()),
    );
  }
  async get(id: string) {
    if (this.disconnected || !this.browser.isConnected())
      throw operationError("BROWSER_DISCONNECTED");
    const t = this.pages.get(id);
    if (!t || t.page.isClosed()) throw operationError("HANDLE_STALE");
    if (t.source === "popup") t.source = "created";
    return t;
  }
  get handoff() {
    const provide = this.options.handoff;
    if (!provide) return undefined;
    return async (tabId: string) => {
      const tab = await this.get(tabId);
      return provide(tab);
    };
  }
  async close() {
    const failures: unknown[] = [];
    for (const tab of this.pages.values()) {
      if (tab.source === "claimed" || tab.deliverable) continue;
      await tab.close().catch((e) => failures.push(e));
    }
    // connectOverCDP Browser.close disconnects the client; Playwright launch closes its owned process.
    if (
      this.mode === "attach" ||
      !this.options.keepBrowserOnClose ||
      ![...this.pages.values()].some(
        (tab) => tab.deliverable && !tab.page.isClosed(),
      ) ||
      this.options.cloudOwned
    )
      await this.browser.close().catch((e) => failures.push(e));
    await this.options.onClose?.().catch((e) => failures.push(e));
    if (failures.length)
      throw new AggregateError(failures, "Browser cleanup incomplete");
  }
}
