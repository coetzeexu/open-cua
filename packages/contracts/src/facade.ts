import type {
  ElementRef,
  LocatorTarget,
  PointTarget,
  Screenshot,
  Snapshot,
  TabInfo,
  DialogInfo,
  Target,
  Handle,
} from "./index.js";
export type Invoke = (
  method: string,
  args: unknown[],
  tabId?: string,
) => Promise<any>;
export interface Locator {
  target: LocatorTarget;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  hover(options?: Record<string, unknown>): Promise<void>;
  press(key: string, options?: Record<string, unknown>): Promise<void>;
  selectOption(values: string | string[]): Promise<void>;
  /** Absolute file paths on the CUA service host; [] clears the file input. */
  setInputFiles(paths: string | string[]): Promise<void>;
}
export interface Tab {
  id: string;
  info(): Promise<TabInfo>;
  close(): Promise<void>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  markDeliverable(value?: boolean): Promise<unknown>;
  ax: {
    snapshot(options?: { since?: string; full?: boolean }): Promise<Snapshot>;
  };
  dom: {
    snapshot(): Promise<unknown>;
    inspect(
      options?: import("./index.js").DOMInspectOptions,
    ): Promise<import("./index.js").DOMObservation>;
  };
  screenshot: {
    capture(options?: Record<string, unknown>): Promise<Screenshot>;
  };
  dialogs: {
    pending(): Promise<DialogInfo | undefined>;
    respond(
      id: string,
      response: { accept: boolean; promptText?: string },
    ): Promise<void>;
  };
  popups: { list(): Promise<TabInfo[]> };
  actions: {
    click(target: Target, options?: Record<string, unknown>): Promise<void>;
    fill(
      target: Target,
      value: string,
      options?: Record<string, unknown>,
    ): Promise<void>;
    select(target: Target, values: string | string[]): Promise<void>;
    setInputFiles(target: Target, paths: string | string[]): Promise<void>;
    press(target: Target | undefined, key: string): Promise<void>;
    hover(target: Target): Promise<void>;
    scroll(
      target: Target | undefined,
      delta: { x: number; y: number },
    ): Promise<void>;
    drag(source: Target, destination: Target): Promise<void>;
  };
  locator(selector: string, options?: { frameId?: string }): Locator;
  getByRole(
    role: string,
    options?: { name?: string; exact?: boolean; frameId?: string },
  ): Locator;
  getByText(
    text: string,
    options?: { exact?: boolean; frameId?: string },
  ): Locator;
  point(screenshot: Screenshot, x: number, y: number): PointTarget;
  evaluate<T = unknown>(
    fn: ((arg: any) => T) | string,
    arg?: unknown,
    options?: { frameId?: string; timeoutMs?: number },
  ): Promise<Awaited<T>>;
  waitForFunction(
    fn: ((arg: any) => unknown) | string,
    options?: { timeoutMs?: number; frameId?: string; arg?: unknown },
  ): Promise<unknown>;
  devLogs(options?: {
    since?: number;
    levels?: string[];
    limit?: number;
  }): Promise<unknown[]>;
  secureForm: {
    request(options: {
      title: string;
      groups?: { id: string; label: string }[];
      fields: {
        id: string;
        label: string;
        control: import("./index.js").SecureFormControl;
        target: Target | Locator;
        groupId?: string;
        masked?: boolean;
      }[];
      delivery?: { mode: "fill" };
      timeoutMs?: number;
    }): Promise<import("./index.js").SecureFormState>;
    status(
      requestId: string,
    ): Promise<import("./index.js").SecureFormState | undefined>;
  };
  auth: {
    /** Collects credentials from the user out of band; values never reach this code. */
    request(options: {
      fields: {
        id: string;
        label: string;
        type?: string;
        target: Target | Locator;
      }[];
      submit?: { target: Target | Locator; action?: "click" | "press_enter" };
      timeoutMs?: number;
    }): Promise<{ status: "submitted"; requestId: string }>;
  };
  handoff: {
    request(options?: { reason?: string; timeoutMs?: number }): Promise<{
      handoffId: string;
      kind: "window" | "url" | "user_browser";
      message: string;
    }>;
    wait(): Promise<{ status: "resumed" | "expired" | "cancelled" }>;
    status(): Promise<unknown>;
  };
  reportBlocked(options: {
    reason:
      | "captcha_failed"
      | "access_denied"
      | "challenge_loop"
      | "unexpected_bot_error";
  }): Promise<{ status: "reported"; hostname: string | null }>;
}
export interface Browser {
  id: string;
  tabs: {
    create(options?: { url?: string }): Promise<Tab>;
    list(): Promise<Tab[]>;
    get(id: string): Promise<Tab>;
  };
  userTabs: { list(): Promise<TabInfo[]>; claim(tab: TabInfo): Promise<Tab> };
  close(): Promise<void>;
}
export interface CUA {
  connect(): Promise<Browser>;
  describe(): Promise<unknown>;
}
export function createFacade(
  invoke: Invoke,
  identity: () => { sessionId: string; generation: number },
): CUA {
  const browser = (h: Handle): Browser => {
    const call = (method: string, args: unknown[]) =>
      invoke(method, [{ __browser: h }, ...args]);
    return {
      id: h.id,
      tabs: {
        create: async (options) =>
          tab(await call("tabs.create", [options ?? {}])),
        list: async () => (await call("tabs.list", [])).map(tab),
        get: async (id) => tab(await call("tabs.get", [id])),
      },
      userTabs: {
        list: () => call("userTabs.list", []),
        claim: async (info) => tab(await call("userTabs.claim", [info])),
      },
      close: () => call("close", []),
    };
  };
  const tab = (h: Handle): Tab => {
    const call = (method: string, args: unknown[] = []) =>
      invoke(method, [{ __handle: h }, ...args], h.id);
    const locator = (description: Partial<LocatorTarget>): Locator => {
      const target: LocatorTarget = {
        type: "locator",
        ...identity(),
        tabId: h.id,
        ...description,
      };
      return usageGuard<Locator>(
        {
          target,
          click: (options) => call("actions.click", [target, options]),
          fill: (value, options) =>
            call("actions.fill", [target, value, options]),
          hover: (options) => call("actions.hover", [target, options]),
          press: (key, options) =>
            call("actions.press", [target, key, options]),
          selectOption: (values) => call("actions.select", [target, values]),
          setInputFiles: (paths) =>
            call("actions.setInputFiles", [target, paths]),
        },
        {
          first: "Use a unique selector or exact role/name.",
          boundingBox: "Use tab.dom.inspect({selector}) for bounds.",
          scrollIntoViewIfNeeded:
            "Use tab.actions.scroll(target,{x,y}); actions already resolve targets.",
        },
      );
    };
    return usageGuard<Tab>(
      {
        id: h.id,
        info: () => call("info"),
        close: () => call("tab.close"),
        goto: (url) => call("goto", [url]),
        reload: () => call("reload"),
        back: () => call("back"),
        forward: () => call("forward"),
        markDeliverable: (value = true) => call("markDeliverable", [value]),
        ax: { snapshot: (options) => call("ax.snapshot", [options ?? {}]) },
        dom: {
          snapshot: () => call("dom.snapshot"),
          inspect: (options) => call("dom.inspect", [options ?? {}]),
        },
        screenshot: {
          capture: (options) => call("screenshot.capture", [options ?? {}]),
        },
        dialogs: {
          pending: () => call("dialogs.pending"),
          respond: (id, response) => call("dialogs.respond", [id, response]),
        },
        popups: { list: () => call("popups.list") },
        actions: {
          click: (target, options) => call("actions.click", [target, options]),
          fill: (target, value, options) =>
            call("actions.fill", [target, value, options]),
          select: (target, values) => call("actions.select", [target, values]),
          setInputFiles: (target, paths) =>
            call("actions.setInputFiles", [target, paths]),
          press: (target, key) => call("actions.press", [target, key]),
          hover: (target) => call("actions.hover", [target]),
          scroll: (target, delta) => call("actions.scroll", [target, delta]),
          drag: (source, destination) =>
            call("actions.drag", [source, destination]),
        },
        locator: (selector, options) => locator({ selector, ...options }),
        getByRole: (role, options) => locator({ role, ...options }),
        getByText: (text, options) => locator({ text, ...options }),
        point: (shot, x, y) => ({
          type: "point",
          sessionId: shot.sessionId,
          generation: shot.generation,
          tabId: shot.tabId,
          screenshotId: shot.imageId,
          epoch: shot.epoch,
          viewportRevision: shot.viewportRevision,
          x,
          y,
        }),
        evaluate: (fn, arg, options) =>
          call("evaluate", [String(fn), arg, options ?? {}]),
        waitForFunction: (fn, options) =>
          call("waitForFunction", [String(fn), options ?? {}]),
        devLogs: (options) => call("devLogs", [options ?? {}]),
        secureForm: {
          request: (options) =>
            call("secureForm.request", [
              {
                ...options,
                fields: options.fields.map((f) => ({
                  ...f,
                  target: "target" in f.target ? f.target.target : f.target,
                })),
              },
            ]),
          status: (id) => call("secureForm.status", [id]),
        },
        auth: {
          request: (options) => {
            const target = (t: Target | Locator) =>
              "target" in t && (t as Locator).target
                ? (t as Locator).target
                : t;
            return call("auth.request", [
              {
                ...options,
                fields: options.fields.map((f) => ({
                  ...f,
                  target: target(f.target),
                })),
                submit: options.submit
                  ? { ...options.submit, target: target(options.submit.target) }
                  : undefined,
              },
            ]);
          },
        },
        handoff: {
          request: (options) => call("handoff.request", [options ?? {}]),
          wait: () => call("handoff.wait"),
          status: () => call("handoff.status"),
        },
        reportBlocked: (options) => call("reportBlocked", [options]),
      },
      {
        url: "Use await tab.info() for url/title.",
        title: "Use await tab.info() for url/title.",
        navigate: "Use await tab.goto(url).",
        scroll: "Use await tab.actions.scroll(undefined,{x,y}).",
      },
    );
  };
  return {
    connect: async () => browser(await invoke("connect", [])),
    describe: () => invoke("describe", []),
  };
}

function usageGuard<T extends object>(
  value: T,
  hints: Record<string, string>,
): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(hints, key))
        throw new TypeError(
          `Unsupported CUA API '${key}'. ${hints[key]} Read cua_describe.apiReference. No action was retried.`,
        );
      return Reflect.get(target, key, receiver);
    },
  });
}
