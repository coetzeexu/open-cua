import { chromium, type LaunchOptions, type Browser } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { ChromiumBinding } from "@cua/browser-chromium";
import {
  CONTRACT_VERSION,
  operationError,
  type BrowserProvider,
  type ResourceJournal,
  type ResourceRecord,
  type OperationContext,
  CuaError,
} from "@cua/contracts";
export interface LocalBrowserOptions {
  mode?: "create" | "attach";
  endpoint?: string;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  keepBrowserOnClose?: boolean;
  launchOptions?: LaunchOptions;
  journal?: ResourceJournal;
}
export async function releaseLocalProfile(path: string) {
  if (
    resolve(dirname(path)) !== resolve(tmpdir()) ||
    !/^cua-chromium-[0-9a-f-]{36}$/.test(basename(path))
  )
    throw Error(
      "Refusing to remove a path outside the owned CUA temporary profile namespace.",
    );
  await rm(path, { recursive: true, force: true });
}
export class LocalBrowserProvider implements BrowserProvider {
  get resourceKey() {
    return this.options.mode === "attach" && this.options.endpoint
      ? `cdp:${createHash("sha256").update(this.options.endpoint).digest("hex")}`
      : undefined;
  }
  readonly descriptor = {
    id: "local",
    contractVersion: CONTRACT_VERSION,
    bindingKind: "chromium",
    capabilities: ["browser"],
  };
  private retained = new Set<{
    browser: Browser;
    cleanup: () => Promise<void>;
  }>();
  constructor(readonly options: LocalBrowserOptions = {}) {}
  async connect(contextGuard?: OperationContext) {
    contextGuard?.check();
    const mode = this.options.mode ?? "create";
    if (mode === "attach" && !this.options.endpoint)
      throw operationError("CONNECT_FAILED", {
        message: "Attach mode requires a CDP endpoint.",
      });
    let browser: Browser | undefined;
    let record: ResourceRecord | undefined;
    const cleanup = async () => {
      if (record) {
        try {
          await releaseLocalProfile(record.resourceId!);
          await this.options.journal?.append({ ...record, event: "released" });
        } catch (e) {
          await this.options.journal?.append({
            ...record,
            event: "release_failed",
          });
          throw e;
        }
      }
    };
    try {
      let context;
      if (mode === "attach") {
        browser = await chromium.connectOverCDP(this.options.endpoint!, {
          timeout: 10000,
        });
        context = browser.contexts()[0] ?? (await browser.newContext());
      } else {
        const key = randomUUID();
        const profile = join(tmpdir(), `cua-chromium-${key}`);
        record = {
          event: "intent",
          key,
          kind: "local-profile",
          owned: true,
          resourceId: profile,
        };
        await this.options.journal?.append(record);
        await mkdir(profile, { mode: 0o700 });
        await this.options.journal?.append({ ...record, event: "created" });
        // PersistentContext is the public pipe-launch API that lets us journal an explicit temporary profile.
        contextGuard?.check();
        context = await chromium.launchPersistentContext(profile, {
          ...this.options.launchOptions,
          channel: this.options.channel,
          executablePath: this.options.executablePath,
          headless: this.options.headless ?? true,
        });
        browser = context.browser()!;
        for (const page of context.pages()) await page.close();
      }
      contextGuard?.check();
      const activeBrowser = browser;
      const headless = this.options.headless ?? true;
      const binding = new ChromiumBinding(browser, context, mode, {
        keepBrowserOnClose: this.options.keepBrowserOnClose,
        handoff:
          mode === "attach"
            ? async () => ({ kind: "user_browser" })
            : headless
              ? undefined
              : async (tab) => {
                  await tab.page.bringToFront();
                  return { kind: "window" };
                },
        onClose: async () => {
          if (mode === "create" && activeBrowser.isConnected()) {
            this.retained.add({ browser: activeBrowser, cleanup });
          } else await cleanup();
        },
      });
      await binding.health();
      return binding;
    } catch (error) {
      await browser?.close().catch(() => {});
      await cleanup();
      if (error instanceof CuaError) throw error;
      throw operationError("CONNECT_FAILED", {
        message:
          "Could not connect to Chromium. Check the local launch or attach configuration.",
      });
    }
  }
  async shutdown() {
    for (const retained of this.retained) {
      await retained.browser.close();
      await retained.cleanup();
      this.retained.delete(retained);
    }
  }
}
