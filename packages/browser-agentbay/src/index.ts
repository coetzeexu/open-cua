import { randomUUID } from "node:crypto";
import {
  AgentBay,
  GetCdpLinkRequest,
  LifecyclePolicy,
  setupLogger,
  type CreateSessionParams,
} from "wuying-agentbay-sdk";
import { connectChromiumEndpoint } from "@cua/browser-chromium";
import {
  CONTRACT_VERSION,
  operationError,
  type BrowserProvider,
  type BrowserConnection,
  type ResourceJournal,
  type Warning,
  type ResourceRecord,
  type OperationContext,
  type HandoffTarget,
} from "@cua/contracts";
export interface CloudSession {
  sessionId: string;
  /** Live viewing URL from the official SDK; shown only to the user, never to the model. */
  resourceUrl?: string;
  browser: {
    initializeAsync(options: Record<string, unknown>): Promise<boolean>;
    getEndpointUrl(): Promise<string>;
  };
  keepAlive(): Promise<CloudResult>;
}
export interface CloudResult {
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}
export interface AgentBayClient {
  /** SDK accessors used for read-only endpoint discovery when attaching. */
  getAPIKey?(): string;
  getClient?(): Pick<ReturnType<AgentBay["getClient"]>, "getCdpLink">;
  create(
    params: CreateSessionParams,
  ): Promise<CloudResult & { session?: CloudSession }>;
  get(id: string): Promise<CloudResult & { session?: CloudSession }>;
  delete(session: CloudSession): Promise<CloudResult>;
  list(
    labels?: Record<string, string>,
    page?: number,
    limit?: number,
  ): Promise<
    CloudResult & { sessionIds: { sessionId: string }[]; totalCount?: number }
  >;
}
export interface AgentBayOptions {
  apiKey?: string;
  client?: AgentBayClient;
  mode?: "create" | "attach";
  sessionId?: string;
  imageId?: string;
  instanceId?: string;
  cuaSessionId?: string;
  journal?: ResourceJournal;
  /** server-default omits API lifecycle overrides; cloud expiry follows console policy. */
  lifecycleMode?: "managed" | "server-default";
  idleReleaseTimeout?: number;
  maxRuntime?: number;
  keepAliveMs?: number;
  warning?: (warning: Warning) => void;
  connect?: (
    endpoint: string,
    options: {
      mode: "create" | "attach";
      cloudOwned?: boolean;
      onClose?: () => Promise<void>;
      handoff?: (tab: any) => Promise<HandoffTarget>;
    },
  ) => Promise<BrowserConnection>;
}
async function retry<T>(fn: () => Promise<T>) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw last;
}
const absent = (result: CloudResult) =>
  ["SessionNotFound", "ResourceNotFound", "InvalidSessionId.NotFound"].includes(
    result.errorCode ?? "",
  );
export class AgentBayBrowserProvider implements BrowserProvider {
  get resourceKey() {
    return this.options.mode === "attach"
      ? `agentbay:${this.options.sessionId}`
      : undefined;
  }
  readonly descriptor = {
    id: "agentbay",
    contractVersion: CONTRACT_VERSION,
    bindingKind: "chromium",
    capabilities: ["browser"],
  };
  readonly client: AgentBayClient;
  constructor(readonly options: AgentBayOptions) {
    if (!options.client) setupLogger({ enableConsole: false, level: "ERROR" });
    this.client =
      options.client ??
      (new AgentBay({ apiKey: options.apiKey }) as unknown as AgentBayClient);
  }
  async connect(context?: OperationContext): Promise<BrowserConnection> {
    context?.check();
    const owned = (this.options.mode ?? "create") === "create";
    const key = randomUUID();
    const labels = {
      cuaInstance: this.options.instanceId ?? "sdk",
      cuaSession:
        this.options.cuaSessionId ?? context?.sessionId ?? randomUUID(),
    };
    const record: ResourceRecord = {
      event: "intent",
      key,
      kind: "agentbay",
      owned,
      labels,
    };
    let session: CloudSession | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const started = Date.now();
    let closing = false;
    const cleanup = async () => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      if (owned && session) {
        try {
          await this.release(session.sessionId, session);
          await this.options.journal?.append({
            ...record,
            event: "released",
            resourceId: session.sessionId,
          });
        } catch (e) {
          closing = false;
          await this.options.journal?.append({
            ...record,
            event: "release_failed",
            resourceId: session.sessionId,
          });
          throw e;
        }
      }
    };
    if (owned) await this.options.journal?.append(record);
    try {
      if (owned) {
        let created;
        context?.check();
        try {
          created = await this.client.create({
            imageId: this.options.imageId,
            labels,
            ...(this.options.lifecycleMode === "server-default"
              ? {}
              : {
                  lifecyclePolicy: new LifecyclePolicy({
                    idleReleaseTimeout: this.options.idleReleaseTimeout ?? 10,
                    maxRuntime: this.options.maxRuntime ?? 240,
                  }),
                }),
          });
        } catch {
          throw operationError("AGENTBAY_CREATE_UNKNOWN", {
            message:
              "AgentBay creation response was lost. Resource recovery will search the recorded labels; do not create again blindly.",
          });
        }
        if (
          !created.success &&
          !created.session &&
          /InvalidParameter\.(?:maxRuntime|idleReleaseTimeout)\(/.test(
            created.errorMessage ?? "",
          )
        )
          throw operationError("CONNECT_FAILED", {
            message:
              "AgentBay rejected the lifecycle override. Configure a supported cloud policy or explicitly select lifecycleMode: server-default. No automatic create retry was attempted.",
          });
        if (!created.success || !created.session)
          throw operationError("AGENTBAY_CREATE_UNKNOWN", {
            message: created.errorMessage?.includes(
              "No available instance in hot pool",
            )
              ? "AgentBay reported no available instance in the image hot pool. Creation was not confirmed; inspect the recorded labels and wait for pool capacity before a new attempt. No automatic create retry was attempted."
              : "AgentBay did not confirm whether creation completed; resource recovery will inspect its labels.",
          });
        session = created.session;
        await this.options.journal?.append({
          ...record,
          event: "created",
          resourceId: session.sessionId,
        });
        context?.check();
        if (!(await session.browser.initializeAsync({})))
          throw operationError("CONNECT_FAILED", {
            message: "AgentBay browser initialization failed.",
          });
      } else {
        if (!this.options.sessionId)
          throw operationError("CONNECT_FAILED", {
            message: "AgentBay attach requires sessionId.",
          });
        const result = await retry(() =>
          this.client.get(this.options.sessionId!),
        );
        if (!result.success || !result.session)
          throw operationError("CONNECT_FAILED");
        session = result.session;
      }
      context?.check();
      const endpoint = await retry(async () => {
        // SDK 0.22 get() returns a Browser with a fresh local initialized flag.
        // Query the existing CDP link without reinitializing caller resources.
        if (!owned && this.client.getClient && this.client.getAPIKey) {
          const response = await this.client.getClient().getCdpLink(
            new GetCdpLinkRequest({
              authorization: `Bearer ${this.client.getAPIKey()}`,
              sessionId: session!.sessionId,
            }),
          );
          const url = response.body?.data?.url;
          if (!response.body?.success || !url)
            throw operationError("CONNECT_FAILED", {
              message:
                "AgentBay did not return an existing browser CDP endpoint.",
            });
          return url;
        }
        return session!.browser.getEndpointUrl();
      });
      context?.check();
      const connection = await (
        this.options.connect ?? connectChromiumEndpoint
      )(endpoint, {
        mode: owned ? "create" : "attach",
        cloudOwned: owned,
        onClose: cleanup,
        handoff: session.resourceUrl
          ? async () => ({ kind: "url", url: session!.resourceUrl })
          : undefined,
      });
      if (owned) {
        timer = setInterval(() => {
          if (
            Date.now() - started >
            ((this.options.maxRuntime ?? 240) - 15) * 60000
          )
            this.options.warning?.({
              code: "BROWSER_MAX_RUNTIME_NEAR",
              message:
                "AgentBay browser is within 15 minutes of its maximum lifetime.",
            });
          void retry(async () => {
            const result = await session!.keepAlive();
            if (!result.success) throw Error("keepAlive failed");
          }).catch(() =>
            this.options.warning?.({
              code: "AGENTBAY_KEEPALIVE_FAILED",
              message:
                "AgentBay keepAlive failed; the cloud session may expire.",
            }),
          );
        }, this.options.keepAliveMs ?? 180000);
        timer.unref();
      }
      const health = connection.health.bind(connection);
      connection.health = async () => {
        if (
          owned &&
          Date.now() - started > (this.options.maxRuntime ?? 240) * 60000
        )
          throw operationError("BROWSER_MAX_RUNTIME_EXCEEDED");
        await health();
      };
      return connection;
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
  async release(id: string, known?: CloudSession) {
    await retry(async () => {
      let session = known;
      if (!session) {
        const result = await this.client.get(id);
        if (
          absent(result) ||
          result.errorMessage ===
            `Failed to get session ${id}: Session ${id} not found`
        )
          return;
        if (!result.success || !result.session)
          throw Error("Unable to establish whether AgentBay session exists");
        session = result.session;
      }
      const result = await this.client.delete(session);
      if (!result.success && !absent(result))
        throw Error("AgentBay resource deletion was not confirmed");
    });
  }
  async lookup(labels: Record<string, string>): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; page <= 10000; page++) {
      const result = await retry(async () => {
        const result = await this.client.list(labels, page, 100);
        if (!result.success) throw Error("AgentBay lookup failed");
        return result;
      });
      ids.push(...result.sessionIds.map((s) => s.sessionId));
      if (
        result.sessionIds.length < 100 ||
        (result.totalCount !== undefined && ids.length >= result.totalCount)
      )
        return ids;
    }
    throw Error("AgentBay lookup pagination exceeded safety limit");
  }
}
