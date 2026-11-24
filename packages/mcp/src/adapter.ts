import { SECURE_FORM_URI } from "./secure-form.js";
import { LOGIN_URI } from "./login.js";
import { MCPApps, APP_URI, APP_MIME, APP_EXTENSION } from "./apps.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CUAService, API_HELP } from "@cua/service";
import { CuaError, type ExecutionResult } from "@cua/contracts";
const session = { sessionId: z.string().optional() };
const schemas = {
  cua_exec: z
    .object({
      ...session,
      code: z.string(),
      requestId: z.string().optional(),
      timeoutMs: z.number().int().positive().max(300000).optional(),
    })
    .strict(),
  cua_poll: z
    .object({
      ...session,
      executionId: z.string(),
      cursor: z.number().int().nonnegative().optional(),
      waitMs: z.number().int().min(0).max(30000).optional(),
    })
    .strict(),
  cua_cancel: z.object({ ...session, executionId: z.string() }).strict(),
  cua_reset: z.object(session).strict(),
  cua_close: z.object(session).strict(),
  cua_describe: z.object(session).strict(),
  cua_session_status: z.object({ profile: z.string().optional() }).strict(),
  cua_session_create: z
    .object({
      profile: z.string().optional(),
      runId: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
        .optional(),
      goal: z.string().max(4000).optional(),
    })
    .strict(),
};
const inputSchemas: Record<keyof typeof schemas, Record<string, unknown>> = {
  cua_exec: {
    type: "object",
    properties: {
      code: { type: "string" },
      sessionId: { type: "string" },
      requestId: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
    },
    required: ["code"],
  },
  cua_poll: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      executionId: { type: "string" },
      cursor: { type: "integer", minimum: 0 },
      waitMs: { type: "integer", minimum: 0, maximum: 30000 },
    },
    required: ["executionId"],
  },
  cua_cancel: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      executionId: { type: "string" },
    },
    required: ["executionId"],
  },
  cua_reset: { type: "object", properties: { sessionId: { type: "string" } } },
  cua_close: { type: "object", properties: { sessionId: { type: "string" } } },
  cua_describe: {
    type: "object",
    properties: { sessionId: { type: "string" } },
  },
  cua_session_status: {
    type: "object",
    properties: { profile: { type: "string" } },
  },
  cua_session_create: {
    type: "object",
    properties: {
      profile: { type: "string" },
      runId: { type: "string" },
      goal: { type: "string" },
    },
    required: [],
  },
};
export class MCPAdapter {
  private implicit?: Promise<string>;
  private owned = new Set<string>();
  private closed = false;
  private pending = new Set<
    Promise<Awaited<ReturnType<CUAService["createSession"]>>>
  >();
  private closing?: Promise<void>;
  constructor(readonly service: CUAService) {}
  tools() {
    return Object.entries(inputSchemas).map(([name, inputSchema]) => ({
      name,
      description:
        name === "cua_exec"
          ? API_HELP
          : name === "cua_session_status"
            ? "Inspect browser lease metadata without creating a session. Includes owner status and local operator recovery instructions; does not grant access to another connection’s session."
            : name === "cua_session_create"
              ? "Create a session. Omit profile to use the configured default; returns profile, runId and supported JavaScript API. Do not guess profile names."
              : `${name}: ${name === "cua_reset" ? "Rebuild only the JavaScript REPL; browser tabs remain." : name === "cua_close" ? "Close session and release owned browser resources." : "CUA session operation. Read structured errors and nextAction."}`,
      inputSchema: { ...inputSchema, additionalProperties: false },
    }));
  }
  private createSession(
    profile?: string,
    context: { runId?: string; goal?: string } = {},
  ) {
    if (this.closed) return Promise.reject(Error("MCP connection closed."));
    const pending = this.service
      .createSession({ profile, ...context })
      .then(async (result) => {
        if (this.closed) {
          await this.service.closeSession({ sessionId: result.sessionId });
          throw Error("MCP connection closed.");
        }
        this.owned.add(result.sessionId);
        return result;
      });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  async restartPanel(profile: string) {
    const { sessionId } = await this.createSession(profile);
    try {
      let result = await this.service.execute({
        sessionId,
        code: "var browser = await cua.connect(); var tab = await browser.tabs.create(); output.text(tab.id);",
      });
      while (result.status === "running")
        result = await this.service.getExecution({
          sessionId,
          executionId: result.executionId,
          cursor: result.cursor,
          waitMs: 1000,
        });
      result = await this.service.getExecution({
        sessionId,
        executionId: result.executionId,
      });
      const tabId = result.output?.find((item) => item.type === "text")?.text;
      if (result.status !== "succeeded" || !tabId)
        throw Error("Browser recovery failed");
      this.implicit = Promise.resolve(sessionId);
      return { sessionId, tabId };
    } catch (error) {
      await this.service.closeSession({ sessionId });
      this.owned.delete(sessionId);
      throw error;
    }
  }
  private async session(id?: string) {
    if (this.closed) throw Error("MCP connection closed.");
    if (id) {
      if (!this.owned.has(id))
        throw Error("Session does not belong to this MCP connection.");
      return id;
    }
    if (this.implicit) {
      const implicit = this.implicit;
      const previous = await implicit;
      if (
        this.implicit === implicit &&
        !this.service
          .status()
          .some((s) => s.sessionId === previous && s.status !== "closing")
      ) {
        this.owned.delete(previous);
        this.implicit = undefined;
      }
    }
    this.implicit ??= this.createSession()
      .then((result) => result.sessionId)
      .catch((e) => {
        this.implicit = undefined;
        throw e;
      });
    return this.implicit;
  }
  /** Host-only ownership view for transport expiry; never exposed as an MCP tool. */
  sessionIds() {
    return [...this.owned];
  }
  async call(name: string, args: unknown = {}) {
    try {
      if (this.closed) throw Error("MCP connection closed.");
      if (!(name in schemas)) throw Error(`Unknown tool: ${name}`);
      const input = (
        schemas[name as keyof typeof schemas] as z.ZodTypeAny
      ).parse(args);
      if (name === "cua_session_status")
        return mapResult(this.service.leaseStatus(input.profile));
      if (name === "cua_session_create") {
        return mapResult(
          await this.createSession(input.profile, {
            runId: input.runId,
            goal: input.goal,
          }),
        );
      }
      const sessionId = await this.session(input.sessionId);
      let result: unknown;
      switch (name) {
        case "cua_exec":
          result = await this.service.execute({ ...input, sessionId });
          break;
        case "cua_poll":
          result = await this.service.getExecution({ ...input, sessionId });
          break;
        case "cua_cancel":
          result = await this.service.cancelExecution({ ...input, sessionId });
          break;
        case "cua_reset":
          result = await this.service.resetSession({ sessionId });
          break;
        case "cua_close":
          result = await this.service.closeSession({ sessionId });
          if ((result as any).closed) {
            this.owned.delete(sessionId);
            if (this.implicit && (await this.implicit) === sessionId)
              this.implicit = undefined;
          }
          break;
        case "cua_describe":
          result = await this.service.describe({ sessionId });
      }
      return mapResult(result);
    } catch (e) {
      const error =
        e instanceof CuaError
          ? e.toJSON()
          : {
              code: "INVALID_TOOL_ARGUMENTS",
              message: e instanceof Error ? e.message : String(e),
              nextAction: "fix_code",
            };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(error) }],
        structuredContent: { error },
      };
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.all(
        [...this.owned].map((sessionId) =>
          this.service.closeSession({ sessionId }),
        ),
      );
      this.owned.clear();
      this.implicit = undefined;
    })();
    return this.closing;
  }
}
export function mapResult(value: unknown) {
  const result = value as Partial<ExecutionResult>;
  const content: any[] = [];
  for (const item of result?.output ?? []) {
    if (item.type === "image" && item.data)
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    else if (item.path)
      content.push({ type: "text", text: `Image saved to ${item.path}` });
    else if (item.text !== undefined)
      content.push({ type: "text", text: item.text });
  }
  const structuredContent = result?.executionId
    ? { ...result, output: result.output?.map(({ data, ...item }) => item) }
    : (value as Record<string, unknown>);
  content.push({
    type: "text",
    text: JSON.stringify(
      result?.executionId ? { ...structuredContent, output: undefined } : value,
    ),
  });
  return {
    content,
    structuredContent,
    isError: result?.status === "failed" || result?.status === "timed_out",
  };
}
export function createMCPServer(
  service: CUAService,
  options: { elicitation?: boolean; apps?: boolean } = {},
) {
  const adapter = new MCPAdapter(service);
  const apps = options.apps
    ? new MCPApps(
        service,
        (id) => adapter.sessionIds().includes(id),
        undefined,
        undefined,
        (profile) => adapter.restartPanel(profile),
      )
    : undefined;
  const server = new Server(
    { name: "open-cua", version: "0.7.0" },
    { capabilities: { tools: {}, ...(apps ? { resources: {} } : {}) } },
  );
  const supportsApps = () =>
    !!apps &&
    !!(server.getClientCapabilities() as any)?.extensions?.[
      APP_EXTENSION
    ]?.mimeTypes?.includes(APP_MIME);
  if (apps) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: supportsApps()
        ? [
            { uri: APP_URI, name: "CUA Browser", mimeType: APP_MIME },
            { uri: LOGIN_URI, name: "CUA Private Login", mimeType: APP_MIME },
            {
              uri: SECURE_FORM_URI,
              name: "CUA Secure Form",
              mimeType: APP_MIME,
            },
          ]
        : [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (
        !supportsApps() ||
        ![APP_URI, LOGIN_URI, SECURE_FORM_URI].includes(request.params.uri)
      )
        throw Error("UI resource unavailable");
      return apps.resource(request.params.uri);
    });
  }
  server.oninitialized = () => {
    const capability = server.getClientCapabilities()?.elicitation;
    if (
      options.elicitation !== false &&
      capability &&
      ("form" in capability || Object.keys(capability).length === 0)
    )
      service.setElicitor(async (confirmation) => {
        const result = await server.elicitInput({
          mode: "form",
          message: `Allow ${confirmation.kind} on ${confirmation.origin} for this browser session?`,
          requestedSchema: {
            type: "object",
            properties: {
              allow: { type: "boolean", title: "Allow this origin" },
            },
            required: ["allow"],
          },
        });
        return result.action === "accept" && result.content?.allow === true;
      });
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...adapter.tools(),
      ...(supportsApps() ? apps!.tools() : []),
    ] as any,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      request.params.name === "cua_view" ||
      request.params.name === "cua_login" ||
      request.params.name === "cua_secure_form" ||
      request.params.name.startsWith("cua_ui_")
    )
      return supportsApps()
        ? (apps!.call(request.params.name, request.params.arguments) as any)
        : {
            isError: true,
            content: [
              {
                type: "text",
                text: "MCP Apps is not enabled or supported by this host.",
              },
            ],
          };
    return adapter.call(request.params.name, request.params.arguments) as any;
  });
  const close = async () => {
    await apps?.close();
    await adapter.close();
  };
  server.onclose = () => {
    void close();
  };
  return { server, adapter, close };
}
export async function serveStdio(
  service: CUAService,
  options: { apps?: boolean } = {},
) {
  const connection = createMCPServer(service, options);
  await connection.server.connect(new StdioServerTransport());
  return connection;
}
