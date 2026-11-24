import { SecureFormApps, SECURE_FORM_URI } from "./secure-form.js";
import { LoginApps, LOGIN_URI } from "./login.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CUAService } from "@cua/service";
import type { HumanBrowserView, HumanInput } from "@cua/contracts";
export const APP_URI = "ui://cua/browser.html";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_EXTENSION = "io.modelcontextprotocol/ui";
const id = z.string().min(1).max(200);
const access = { sessionId: id, token: z.string().length(64) };
const point = { x: z.number().finite(), y: z.number().finite() };
const input = z.intersection(
  z.object({ frameId: z.number().int().positive() }),
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("pointer"),
      phase: z.enum(["down", "move", "up", "cancel"]),
      ...point,
    }),
    z.object({ type: z.literal("click"), ...point }),
    z.object({
      type: z.literal("wheel"),
      ...point,
      deltaX: z.number().min(-2000).max(2000),
      deltaY: z.number().min(-2000).max(2000),
    }),
    z.object({ type: z.literal("text"), text: z.string().max(2000) }),
    z.object({
      type: z.literal("key"),
      key: z.string().max(20),
      modifiers: z.number().int().min(0).max(15).optional(),
    }),
    z.object({ type: z.literal("selectAll") }),
  ]),
);
const schemas = {
  cua_ui_recover: z.object(access).strict(),
  cua_ui_state: z.object(access).strict(),
  cua_ui_frame: z.object(access).strict(),
  cua_ui_control: z
    .object({
      ...access,
      action: z.enum(["take", "interrupt", "resume", "release", "close"]),
    })
    .strict(),
  cua_ui_input: z.object({ ...access, input }).strict(),
  cua_ui_answer: z
    .object({
      ...access,
      requestId: id,
      action: z.enum(["submit", "decline", "resume"]),
      values: z.record(z.string().max(4096)).optional(),
    })
    .strict(),
};
type Grant = {
  sessionId: string;
  tabId: string;
  token: string;
  expiresAt: number;
  view: HumanBrowserView;
  capture?: ReturnType<HumanBrowserView["capture"]>;
  queue: Promise<unknown>;
  closed: boolean;
};
const privateResult = (value: unknown) => ({
  content: [],
  _meta: { cua: value },
});
const denied = () => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: "CUA panel unavailable or request rejected. Reopen the panel, refresh its frame, and check control ownership.",
    },
  ],
});
/** The trusted host must withhold _meta and all app-only arguments/results from the model. */
export class MCPApps {
  private login: LoginApps;
  private secureForm: SecureFormApps;
  private grants = new Map<string, Grant>();
  private recovering = new Set<string>();
  private recoveries = new Map<
    string,
    { token: string; tabId: string; profile: string }
  >();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private service: CUAService,
    private owns: (id: string) => boolean,
    private ttlMs = 15 * 60_000,
    private frameTimeoutMs = 5000,
    private restart?: (
      profile: string,
    ) => Promise<{ sessionId: string; tabId: string }>,
  ) {
    this.login = new LoginApps(service, owns);
    this.secureForm = new SecureFormApps(service, owns);
    this.timer = setInterval(
      () => {
        const live = new Set(service.status().map((s) => s.sessionId));
        for (const g of this.grants.values())
          if (g.expiresAt <= Date.now() || !live.has(g.sessionId))
            void this.revoke(g).catch(() => {});
      },
      Math.min(ttlMs, 30000),
    );
    this.timer.unref();
  }
  tools() {
    const property = {
      sessionId: { type: "string" },
      token: { type: "string" },
      action: { type: "string" },
      input: { type: "object" },
      requestId: { type: "string" },
      values: { type: "object", additionalProperties: { type: "string" } },
    };
    return [
      ...this.login.tools(),
      ...this.secureForm.tools(),
      {
        name: "cua_view",
        description:
          "Open the human browser panel for an existing CUA session and tab. Requires an MCP Apps host; does not grant the model human control.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            tabId: { type: "string" },
          },
          required: ["sessionId", "tabId"],
          additionalProperties: false,
        },
        _meta: { ui: { resourceUri: APP_URI }, "ui/resourceUri": APP_URI },
      },
      ...Object.keys(schemas).map((name) => ({
        name,
        description:
          "Private human panel operation. Never expose to model tools or conversation history.",
        inputSchema: {
          type: "object",
          properties: property,
          required: ["sessionId", "token"],
        },
        _meta: {
          ui: { visibility: ["app"], resourceUri: APP_URI },
          "ui/resourceUri": APP_URI,
        },
      })),
    ];
  }
  async resource(uri = APP_URI) {
    if (uri === SECURE_FORM_URI) return this.secureForm.resource();
    if (uri === LOGIN_URI) return this.login.resource();
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME,
          text: await readFile(
            new URL("./browser.html", import.meta.url),
            "utf8",
          ),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    };
  }
  private async revoke(g: Grant) {
    if (g.closed) return;
    g.closed = true;
    if (this.grants.get(g.sessionId) === g) this.grants.delete(g.sessionId);
    await g.queue.catch(() => {});
    await g.view.close();
  }
  private validate(g: Grant) {
    if (
      this.closed ||
      g.closed ||
      g.expiresAt <= Date.now() ||
      !this.owns(g.sessionId)
    )
      throw Error();
  }
  private async capture(g: Grant) {
    // Keep one underlying capture in flight even after a request times out.
    // A timeout does not imply that the provider cancelled its CDP operation.
    const pending = (g.capture ??= g.view.capture().finally(() => {
      g.capture = undefined;
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Frame unavailable")),
            this.frameTimeoutMs,
          );
        }),
      ]);
      this.validate(g);
      return privateResult(frame);
    } finally {
      clearTimeout(timer);
    }
  }
  async call(name: string, args: unknown): Promise<CallToolResult> {
    try {
      if (this.closed) throw Error();
      if (name === "cua_secure_form" || name.startsWith("cua_ui_secure_form_"))
        return await this.secureForm.call(name, args);
      if (name === "cua_login" || name.startsWith("cua_ui_login_"))
        return await this.login.call(name, args);
      if (name === "cua_ui_recover") {
        const a = schemas.cua_ui_recover.parse(args);
        const saved = this.recoveries.get(a.sessionId);
        if (
          !saved ||
          !this.owns(a.sessionId) ||
          !timingSafeEqual(Buffer.from(saved.token), Buffer.from(a.token)) ||
          this.recovering.has(a.sessionId)
        )
          throw Error();
        this.recovering.add(a.sessionId);
        let target = { sessionId: a.sessionId, tabId: saved.tabId };
        const recreated = !this.service
          .status()
          .some((s) => s.sessionId === a.sessionId);
        try {
          if (recreated) {
            if (!this.restart) throw Error();
            target = await this.restart(saved.profile);
          }
          const result = await this.call("cua_view", target);
          if (!result.isError) {
            if (target.sessionId !== a.sessionId)
              this.recoveries.delete(a.sessionId);
            return privateResult({ ...(result as any)._meta.cua, recreated });
          }
          return result;
        } finally {
          this.recovering.delete(a.sessionId);
        }
      }
      if (name === "cua_view") {
        const { sessionId, tabId } = z
          .object({ sessionId: id, tabId: id })
          .strict()
          .parse(args);
        if (!this.owns(sessionId)) throw Error();
        // Reserve before awaiting so concurrent panels cannot leak a second controller.
        if (this.opening.has(sessionId)) throw Error();
        this.opening.add(sessionId);
        try {
          const old = this.grants.get(sessionId);
          if (old) await this.revoke(old);
          const view = await this.service.openHumanView(sessionId, tabId);
          if (this.closed || !this.owns(sessionId)) {
            await view.close();
            throw Error();
          }
          const g: Grant = {
            sessionId,
            tabId,
            view,
            token: randomBytes(32).toString("hex"),
            expiresAt: Date.now() + this.ttlMs,
            queue: Promise.resolve(),
            closed: false,
          };
          this.grants.set(sessionId, g);
          const recoveryToken = randomBytes(32).toString("hex");
          this.recoveries.set(sessionId, {
            token: recoveryToken,
            tabId,
            profile: this.service
              .status()
              .find((s) => s.sessionId === sessionId)!.profile,
          });
          return {
            content: [
              { type: "text" as const, text: "Human browser panel opened." },
            ],
            structuredContent: { sessionId, tabId },
            _meta: {
              cua: {
                sessionId,
                tabId,
                token: g.token,
                recoveryToken,
                expiresAt: g.expiresAt,
              },
            },
          };
        } finally {
          this.opening.delete(sessionId);
        }
      }
      if (!Object.hasOwn(schemas, name)) throw Error();
      const a = (schemas[name as keyof typeof schemas] as z.ZodTypeAny).parse(
        args,
      );
      const g = this.grants.get(a.sessionId);
      if (
        !g ||
        !this.owns(a.sessionId) ||
        !timingSafeEqual(Buffer.from(g.token), Buffer.from(a.token))
      )
        throw Error();
      this.validate(g);
      const state = () => ({
        sessionId: g.sessionId,
        tabId: g.tabId,
        expiresAt: g.expiresAt,
        status: this.service.status().find((s) => s.sessionId === g.sessionId),
        requests: this.service.humanRequests(g.sessionId),
      });
      // Observation must never hold up cancellation or human control.
      if (name === "cua_ui_state") return privateResult(state());
      if (name === "cua_ui_frame") return await this.capture(g);
      const result = g.queue.then(async () => {
        this.validate(g);
        if (name === "cua_ui_input")
          await this.service.runHumanAction(g.sessionId, () =>
            g.view.input(a.input as HumanInput),
          );
        if (name === "cua_ui_answer")
          this.service.answerHumanRequest(
            g.sessionId,
            a.requestId,
            a.action,
            a.values,
          );
        if (name === "cua_ui_control") {
          if (a.action === "take" || a.action === "interrupt")
            await this.service.interruptSession({
              sessionId: g.sessionId,
              takeControl: a.action === "take",
            });
          // Gate model work before awaiting a potentially slow pointer release.
          await g.view.release();
          if (a.action === "resume")
            await this.service.resumeSession({ sessionId: g.sessionId });
          if (a.action === "close") {
            this.recoveries.delete(g.sessionId);
            g.closed = true;
            this.grants.delete(g.sessionId);
            await g.view.close();
          }
        }
        return privateResult(state());
      });
      g.queue = result.catch(() => {});
      return await result;
    } catch {
      return denied();
    }
  }
  private opening = new Set<string>();
  async close() {
    this.closed = true;
    this.login.close();
    this.secureForm.close();
    clearInterval(this.timer);
    this.recoveries.clear();
    await Promise.allSettled(
      [...this.grants.values()].map((g) => this.revoke(g)),
    );
  }
}
