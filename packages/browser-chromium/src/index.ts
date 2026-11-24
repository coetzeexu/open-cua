export * from "./binding.js";
export * from "./capabilities.js";
import { chromium, type Browser } from "playwright";
import { ChromiumBinding } from "./binding.js";
export async function connectChromiumEndpoint(
  endpoint: string,
  options: {
    mode: "create" | "attach";
    cloudOwned?: boolean;
    onClose?: () => Promise<void>;
    timeoutMs?: number;
    /** Sandbox attachment must use the browser's existing persistent context. */
    existingContextOnly?: boolean;
    handoff?: (
      tab: import("./binding.js").ChromiumTab,
    ) => Promise<import("@cua/contracts").HandoffTarget>;
  },
) {
  let browser: Browser | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? 10000;
  // Bound the full handshake, including Browser.getVersion. A CDP server can
  // accept a socket but stop answering before the health check finishes.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      void browser?.close().catch(() => {});
      reject(Error("Chromium connection timed out."));
    }, timeoutMs);
  });
  const connect = async () => {
    browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
    if (expired) {
      await browser.close();
      throw Error("Chromium connection timed out.");
    }
    let context = browser.contexts()[0];
    if (!context && options.existingContextOnly)
      throw Error("The sandbox browser has no existing context.");
    context ??= await browser.newContext();
    const binding = new ChromiumBinding(
      browser,
      context,
      options.mode,
      options,
    );
    await binding.health();
    return binding;
  };
  try {
    return await Promise.race([connect(), deadline]);
  } catch (error) {
    // connectOverCDP close disconnects this client, leaving the browser alive.
    await browser?.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export * from "./transport.js";
