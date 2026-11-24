import { EventEmitter } from "node:events";
import type { CDPSession } from "playwright";
import { operationError, type CDPTransport } from "@cua/contracts";
/** Reattaches only when closure was observed before dispatch. A failed send is never replayed. */
export class ChromiumCDPTransport extends EventEmitter implements CDPTransport {
  private session?: CDPSession;
  private opening?: Promise<CDPSession>;
  private disposed = false;
  constructor(
    private factory: () => Promise<CDPSession>,
    private timeoutMs = 5000,
  ) {
    super();
  }
  private async connection() {
    if (this.disposed) throw operationError("BROWSER_DISCONNECTED");
    if (this.session) return this.session;
    this.opening ??= this.factory()
      .then((session) => {
        this.session = session;
        session.on("event", ({ method, params }) => this.emit(method, params));
        session.once("close", () => {
          if (this.session === session) this.session = undefined;
          this.emit("close");
        });
        return session;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }
  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    const session = await this.connection();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (session.send as (method: string, params?: object) => Promise<unknown>)(
          method,
          params,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                operationError("OPERATION_TIMEOUT", {
                  layer: "cdp",
                  phase: "dispatch",
                }),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  readonly send: CDPSession["send"] = ((
    method: string,
    params?: Record<string, unknown>,
  ) => this.request(method, params)) as CDPSession["send"];
  subscribe(event: string, listener: (payload: unknown) => void) {
    this.on(event, listener);
    return () => {
      this.off(event, listener);
    };
  }
  async close() {
    this.disposed = true;
    const session = this.session;
    this.session = undefined;
    await session?.detach().catch(() => {});
    this.removeAllListeners();
  }
}
