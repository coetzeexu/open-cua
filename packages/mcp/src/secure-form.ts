import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SecureFormAnswer } from "@cua/contracts";
import type { CUAService } from "@cua/service";
import { z } from "zod";

export const SECURE_FORM_URI = "ui://cua/secure-form.html";
const id = z.string().min(1).max(200);
const identity = { sessionId: id, requestId: id };
const access = { ...identity, token: z.string().regex(/^[a-f0-9]{64}$/) };
const openSchema = z.object(identity).strict();
const stateSchema = z.object(access).strict();
const answerSchema = z.discriminatedUnion("action", [
  z.object({ ...access, action: z.literal("decline") }).strict(),
  z
    .object({
      ...access,
      action: z.literal("submit"),
      schemaRevision: id,
      submissionId: id,
      values: z.record(z.string().max(4096)),
    })
    .strict(),
]);
type Grant = {
  sessionId: string;
  requestId: string;
  token: string;
  expiresAt: number;
  executionId?: string;
};
const denied = (): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: "Secure form unavailable or request rejected. Reopen the current form to check its state; do not replay a submission whose outcome is unknown.",
    },
  ],
});

/** Host-only grants and form data; never serialize these results into model context. */
export class SecureFormApps {
  private grants = new Map<string, Grant>();
  private closed = false;
  constructor(
    private service: CUAService,
    private owns: (id: string) => boolean,
    private ttlMs = 15 * 60_000,
  ) {}

  tools() {
    return [
      "cua_secure_form",
      "cua_ui_secure_form_state",
      "cua_ui_secure_form_answer",
    ].map((name) => ({
      name,
      description:
        name === "cua_secure_form"
          ? "Open or recover a private secure form for an existing tab.secureForm.request. Use the sessionId and requestId from USER_ACTION_REQUIRED. Do not request values in chat or model code. The card fills verified page fields and reports value-free status; fill completion does not prove website success. Follow nextAction; never replay unknown input. Unsupported controls or verification challenges require human takeover."
          : "Private secure form operation. Withhold arguments, _meta, tokens and field data from model tools, conversation history and ordinary logs.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          requestId: { type: "string" },
          ...(name === "cua_secure_form" ? {} : { token: { type: "string" } }),
          ...(name === "cua_ui_secure_form_answer"
            ? {
                action: { type: "string", enum: ["submit", "decline"] },
                schemaRevision: { type: "string" },
                submissionId: { type: "string" },
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
          ...(name === "cua_secure_form" ? [] : ["token"]),
          ...(name === "cua_ui_secure_form_answer" ? ["action"] : []),
        ],
        additionalProperties: false,
      },
      _meta: {
        ui: {
          resourceUri: SECURE_FORM_URI,
          ...(name === "cua_secure_form" ? {} : { visibility: ["app"] }),
        },
        "ui/resourceUri": SECURE_FORM_URI,
      },
    }));
  }

  async resource() {
    return {
      contents: [
        {
          uri: SECURE_FORM_URI,
          mimeType: "text/html;profile=mcp-app",
          text: await readFile(
            new URL("./secure-form.html", import.meta.url),
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

  private read(g: Grant) {
    const state = this.service.secureFormState(g.sessionId, g.requestId);
    if (!state) throw Error("Unavailable");
    const executionId = state.executionId ?? g.executionId;
    const done = state.status === "filled";
    const attention = ["failed_before_write", "partial_or_unknown"].includes(
      state.status,
    );
    return {
      ...state,
      ...(done || attention
        ? {
            continuation: {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `安全表单${done ? "已完成字段写入" : "需要检查处理结果"}（sessionId=${g.sessionId}，requestId=${g.requestId}${executionId ? `，executionId=${executionId}` : ""}）。请查询原执行及安全表单状态，按 nextAction 继续原任务。不要重新提交填写值；不要读取受保护页面原始内容。字段写入不代表网站业务成功。`,
                },
              ],
            },
          }
        : {}),
    };
  }

  async call(name: string, args: unknown): Promise<CallToolResult> {
    try {
      if (this.closed) return denied();
      for (const [key, g] of this.grants)
        if (g.expiresAt <= Date.now() || !this.owns(g.sessionId))
          this.grants.delete(key);
      if (name === "cua_secure_form") {
        const a = openSchema.parse(args);
        if (!this.owns(a.sessionId)) return denied();
        // Read the state before rotating an existing grant; failed opens keep it usable.
        const g: Grant = {
          ...a,
          token: randomBytes(32).toString("hex"),
          expiresAt: Date.now() + this.ttlMs,
          executionId: this.service
            .status()
            .find((s) => s.sessionId === a.sessionId)?.executionId,
        };
        const state = this.read(g);
        for (const [key, old] of this.grants)
          if (old.sessionId === a.sessionId && old.requestId === a.requestId)
            this.grants.delete(key);
        this.grants.set(g.token, g);
        return {
          content: [
            {
              type: "text",
              text: "Secure form opened. Values remain in the private input channel; follow the form's execution status before continuing.",
            },
          ],
          structuredContent: { ...a, status: state.status },
          _meta: { cua: { ...g, ...state } },
        };
      }
      if (
        name !== "cua_ui_secure_form_state" &&
        name !== "cua_ui_secure_form_answer"
      )
        return denied();
      const a =
        name === "cua_ui_secure_form_answer"
          ? answerSchema.parse(args)
          : stateSchema.parse(args);
      const g = this.grants.get(a.token);
      if (
        !g ||
        !this.owns(a.sessionId) ||
        g.sessionId !== a.sessionId ||
        g.requestId !== a.requestId ||
        !timingSafeEqual(Buffer.from(g.token), Buffer.from(a.token))
      )
        return denied();
      if (name === "cua_ui_secure_form_answer") {
        const submitted = answerSchema.parse(args);
        const answer: SecureFormAnswer =
          submitted.action === "submit"
            ? {
                action: "submit",
                schemaRevision: submitted.schemaRevision,
                submissionId: submitted.submissionId,
                values: submitted.values,
              }
            : { action: "decline" };
        await this.service.answerSecureForm(a.sessionId, a.requestId, answer);
      }
      return { content: [], _meta: { cua: this.read(g) } };
    } catch {
      // Provider/schema errors can contain input. Return only a fixed diagnostic.
      return denied();
    }
  }

  close() {
    this.closed = true;
    this.grants.clear();
  }
}
