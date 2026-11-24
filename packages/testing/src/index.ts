import { randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  operationError,
  type BrowserProvider,
  type BrowserConnection,
  type TabBinding,
  type TabInfo,
  type FrameInfo,
  type OperationContext,
  type DialogInfo,
  type Capabilities,
  type TargetResolver,
  type ProviderDescriptor,
  type SecureFormDescriptor,
} from "@cua/contracts";
export const descriptor = (
  id: string,
  capabilities: string[] = [],
  kind = "fake",
): ProviderDescriptor => ({
  id,
  contractVersion: CONTRACT_VERSION,
  bindingKind: kind,
  capabilities,
});
export class FakeTab implements TabBinding {
  readonly kind = "fake";
  readonly id = randomUUID();
  state: TabInfo["state"] = "ready";
  epoch = 0;
  documentEpoch = 0;
  viewportRevision = 0;
  url = "about:blank";
  title = "Fake";
  source: TabInfo["source"] = "created";
  deliverable = false;
  inputEvents: string[] = [];
  /** Values written by fill, keyed by target selector; used to verify secure input. */
  filled = new Map<string, string>();
  /** Selectors the fake page treats as password fields. */
  sensitive = new Set<string>();
  /** Native secure input metadata; null marks unsupported controls. */
  secureForms = new Map<string, SecureFormDescriptor | null>();
  focused?: string;
  pendingDialog?: DialogInfo;
  listeners = new Set<(d: DialogInfo | undefined) => void>();
  async info(): Promise<TabInfo> {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      source: this.source,
      state: this.state,
      epoch: this.epoch,
      viewportRevision: this.viewportRevision,
      deliverable: this.deliverable,
    };
  }
  async frames(): Promise<FrameInfo[]> {
    return [{ id: this.id, url: this.url, epoch: this.documentEpoch }];
  }
  dialog() {
    return this.pendingDialog;
  }
  onDialog(listener: (d: DialogInfo | undefined) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  openDialog() {
    this.pendingDialog = {
      id: randomUUID(),
      type: "alert",
      message: "test",
      defaultValue: "",
      appearedAt: Date.now(),
    };
    this.state = "dialog_open";
    for (const l of this.listeners) l(this.pendingDialog);
  }
  async respondDialog(id: string) {
    if (id !== this.pendingDialog?.id) throw operationError("HANDLE_STALE");
    this.pendingDialog = undefined;
    this.state = "ready";
    for (const l of this.listeners) l(undefined);
  }
  async navigate(kind: string, url: string | undefined, ctx: OperationContext) {
    ctx.dispatch();
    this.url = url ?? this.url;
    this.epoch++;
    this.documentEpoch++;
    ctx.afterDispatch();
  }
  async evaluate(
    source: string,
    args: unknown,
    frameId: string | undefined,
    ctx: OperationContext,
  ) {
    ctx.dispatch();
    this.viewportRevision++;
    return { source, args };
  }
  async recoverEvaluation() {
    return "ready" as const;
  }
  devLogs() {
    return [];
  }
  invalidate() {
    this.epoch++;
  }
  quarantine() {
    this.state = "quarantined";
  }
  markDeliverable(value: boolean) {
    this.deliverable = value;
    return undefined;
  }
  async close() {
    this.state = "closed";
  }
}
export class FakeBrowser implements BrowserConnection {
  readonly kind = "fake";
  readonly id = randomUUID();
  readonly mode = "create";
  connected = true;
  pages: FakeTab[] = [];
  handoffSupported = true;
  get handoff() {
    return this.handoffSupported
      ? async () => ({ kind: "url" as const, url: "https://live.test/view" })
      : undefined;
  }
  async health() {
    if (!this.connected) throw operationError("BROWSER_DISCONNECTED");
  }
  async tabs() {
    return this.pages.filter((p) => p.state !== "closed");
  }
  async create(url?: string) {
    const t = new FakeTab();
    t.url = url ?? "about:blank";
    this.pages.push(t);
    return t;
  }
  async userTabs() {
    return [];
  }
  async claim(info: TabInfo) {
    return this.get(info.id);
  }
  async popups() {
    return [];
  }
  async get(id: string) {
    const tab = this.pages.find((t) => t.id === id);
    if (!tab) throw operationError("HANDLE_STALE");
    return tab;
  }
  async close() {
    this.connected = false;
    await Promise.all(this.pages.map((p) => p.close()));
  }
}
export class FakeBrowserProvider implements BrowserProvider {
  readonly descriptor = descriptor("fake-browser");
  connection = new FakeBrowser();
  async connect() {
    if (!this.connection.connected) this.connection = new FakeBrowser();
    return this.connection;
  }
}
export function fakeCapabilities(
  options: { stepDelayMs?: number; steps?: number; fail?: boolean } = {},
): Capabilities {
  return {
    ax: {
      descriptor: descriptor("fake-ax", ["ax"]),
      async bind({ binding }) {
        return {
          async snapshot() {
            return { nodes: [], warnings: [] };
          },
        };
      },
    },
    dom: {
      descriptor: descriptor("fake-dom", ["dom"]),
      async bind() {
        return {
          async snapshot() {
            return { text: "fake" };
          },
        };
      },
    },
    action: {
      descriptor: descriptor("fake-action", ["action"]),
      async bind({ binding }) {
        const tab = binding as FakeTab;
        const key = (target: any) =>
          String(target?.value?.selector ?? target?.value?.refId ?? "");
        return {
          async describe(target) {
            const k = key(target);
            return {
              count: k === "#missing" ? 0 : 1,
              visible: true,
              enabled: true,
              editable: true,
              sensitive: tab.sensitive.has(k),
              secureForm: tab.secureForms.has(k)
                ? (tab.secureForms.get(k) ?? undefined)
                : {
                    nodeId: `${tab.id}:${tab.documentEpoch}:${k}`,
                    bindingRevision: "fake-native-v1",
                    control: tab.sensitive.has(k)
                      ? ("password" as const)
                      : ("text" as const),
                    required: false,
                    nonEmpty: !!tab.filled.get(k),
                  },
              authForm: null,
            };
          },
          async deliverSecureForm(kind, target, value, ctx) {
            for (let i = 0; i < (options.steps ?? 1); i++) {
              await new Promise((r) => setTimeout(r, options.stepDelayMs ?? 0));
              ctx.dispatch();
              tab.inputEvents.push(kind);
            }
            tab.filled.set(key(target), value);
            if (options.fail) throw operationError("ACTION_OUTCOME_UNKNOWN");
            ctx.afterDispatch();
          },
          async focusedSensitive() {
            return !!tab.focused && tab.sensitive.has(tab.focused);
          },
          async perform(kind, target, args, ctx) {
            for (let i = 0; i < (options.steps ?? 1); i++) {
              await new Promise((r) => setTimeout(r, options.stepDelayMs ?? 0));
              ctx.dispatch();
              tab.inputEvents.push(kind);
            }
            if (kind === "fill") tab.filled.set(key(target), String(args[0]));
            if (kind === "select")
              tab.filled.set(key(target), String((args[0] as string[])[0]));
            if (kind === "click") tab.focused = key(target);
            if (options.fail) throw operationError("ACTION_OUTCOME_UNKNOWN");
            ctx.afterDispatch();
          },
        };
      },
    },
  };
}
export const fakeResolver: TargetResolver = {
  descriptor: descriptor("fake-resolver", [], "fake"),
  async resolve(target) {
    return { value: target, async dispose() {} };
  },
};
