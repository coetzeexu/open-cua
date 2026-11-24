import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CUAService } from "@cua/service";

export const LOGIN_URI = "ui://cua/login.html";
const id = z.string().min(1).max(200);
const request = { sessionId: id, requestId: id };
const access = { ...request, token: z.string().length(64) };
const schemas = {
  cua_login: z.object(request).strict(),
  cua_ui_login_state: z.object(access).strict(),
  cua_ui_login_answer: z
    .object({
      ...access,
      action: z.enum(["submit", "decline"]),
      values: z.record(z.string().max(4096)).optional(),
    })
    .strict(),
};
type Grant = {
  sessionId: string;
  requestId: string;
  token: string;
  executionId?: string;
  expiresAt: number;
  status: "pending" | "submitted" | "cancelled";
};

/** Request-scoped credentials; these grants cannot control or observe a browser. */
export class LoginApps {
  private grants = new Map<string, Grant>();
  constructor(
    private service: CUAService,
    private owns: (id: string) => boolean,
  ) {}
  tools() {
    return Object.keys(schemas)
      .map((name) => ({
        name,
        description:
          name === "cua_login"
            ? "Show a private account/password login card for a pending tab.auth.request. Call after cua_exec/cua_poll reports USER_ACTION_REQUIRED, using its sessionId and the request ID in the warning. Do not ask for credentials in chat. After successful private submission, the card sends a credential-free user message to resume the task. On that message poll the original execution and observe login outcome; do not ask the user to type a confirmation unless automatic continuation is unavailable. For SMS/OTP or CAPTCHA, explain the obstacle and open cua_view for human takeover instead."
            : "Private login card operation. Never expose arguments, results or tokens to model tools, conversation history or logs.",
        _meta: {
          ui: {
            resourceUri: LOGIN_URI,
            ...(name === "cua_login" ? {} : { visibility: ["app"] }),
          },
          "ui/resourceUri": LOGIN_URI,
        },
      }))
      .map((tool) => ({
        ...tool,
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            requestId: { type: "string" },
            ...(tool.name === "cua_login" ? {} : { token: { type: "string" } }),
            ...(tool.name === "cua_ui_login_answer"
              ? {
                  action: { type: "string", enum: ["submit", "decline"] },
                  values: {
                    type: "object",
                    additionalProperties: { type: "string" },
                  },
                }
              : {}),
          },
          required: [
            "sessionId",
            "requestId",
            ...(tool.name === "cua_login" ? [] : ["token"]),
            ...(tool.name === "cua_ui_login_answer" ? ["action"] : []),
          ],
          additionalProperties: false,
        },
      }));
  }
  async resource() {
    return {
      contents: [
        {
          uri: LOGIN_URI,
          mimeType: "text/html;profile=mcp-app",
          text: await readFile(
            new URL("./login.html", import.meta.url),
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
  private pending(sessionId: string, requestId: string) {
    const r = this.service
      .humanRequests(sessionId)
      .find((r) => r.id === requestId);
    if (
      r?.type !== "credentials" ||
      r.expiresAt <= Date.now() ||
      !r.fields.some((f) => f.type === "password") ||
      r.fields.some((f) => f.type === "otp")
    )
      return;
    return r;
  }
  async call(name: string, args: unknown) {
    try {
      for (const [token, grant] of this.grants)
        if (grant.expiresAt <= Date.now() || !this.owns(grant.sessionId))
          this.grants.delete(token);
      if (!Object.hasOwn(schemas, name)) throw Error();
      const a = (schemas[name as keyof typeof schemas] as z.ZodTypeAny).parse(
        args,
      );
      if (!this.owns(a.sessionId)) throw Error();
      if (name === "cua_login") {
        const r = this.pending(a.sessionId, a.requestId);
        if (!r) throw Error();
        for (const [token, g] of this.grants)
          if (g.sessionId === a.sessionId && g.requestId === a.requestId)
            this.grants.delete(token);
        const g: Grant = {
          ...a,
          token: randomBytes(32).toString("hex"),
          expiresAt: r.expiresAt,
          status: "pending",
          executionId: this.service
            .status()
            .find((s) => s.sessionId === a.sessionId)?.executionId,
        };
        this.grants.set(g.token, g);
        return {
          content: [
            {
              type: "text" as const,
              text: "Private login card opened. Waiting for the user; submission does not prove login succeeded.",
            },
          ],
          structuredContent: { sessionId: a.sessionId, requestId: a.requestId },
          _meta: { cua: { ...g, request: r } },
        };
      }
      const g = this.grants.get(a.token);
      if (
        !g ||
        g.sessionId !== a.sessionId ||
        g.requestId !== a.requestId ||
        !timingSafeEqual(Buffer.from(g.token), Buffer.from(a.token))
      )
        throw Error();
      const r = this.pending(g.sessionId, g.requestId);
      if (name === "cua_ui_login_answer") {
        if (g.status !== "pending" || !r) throw Error();
        this.service.answerHumanRequest(
          g.sessionId,
          g.requestId,
          a.action,
          a.values,
        );
        g.status = a.action === "submit" ? "submitted" : "cancelled";
      }
      return {
        content: [],
        _meta: {
          cua: {
            status: g.status === "pending" && !r ? "expired" : g.status,
            ...(g.status === "pending" && r ? { request: r } : {}),
            ...(g.status === "submitted"
              ? {
                  continuation: {
                    role: "user" as const,
                    content: [
                      {
                        type: "text" as const,
                        text: `登录卡片已私密提交（sessionId=${g.sessionId}，requestId=${g.requestId}${g.executionId ? `，executionId=${g.executionId}` : ""}）。请继续轮询${g.executionId ? "该" : "原"}执行并观察页面确认登录结果，然后继续原任务。提交不代表登录成功；不要重新提交凭据。`,
                      },
                    ],
                  },
                }
              : {}),
          },
        },
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Login request unavailable or rejected. Use a current account/password request, or open the browser panel for human takeover.",
          },
        ],
      };
    }
  }
  close() {
    this.grants.clear();
  }
}
