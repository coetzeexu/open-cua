// Reusable model-side MCP client. Use a separate UI route for cua_ui_* calls.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export function modelTools(tools) {
  return tools
    .filter(
      (tool) =>
        !tool._meta?.ui?.visibility ||
        tool._meta.ui.visibility.includes("model"),
    )
    .map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
}
export function modelResult(result) {
  // _meta may contain a private panel capability. Never serialize the raw result to a model/log.
  return {
    content: result.content,
    ...(result.structuredContent
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}
export async function connectCUA({ url, token, apps = false, sessionId } = {}) {
  const client = new Client(
    { name: "my-harness", version: "1.0.0" },
    {
      capabilities: apps
        ? {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          }
        : {},
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    sessionId,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const allTools = (await client.listTools()).tools;
  const tools = modelTools(allTools);
  const allowed = new Set(tools.map((t) => t.name));
  return {
    client,
    transport,
    tools,
    async callModelTool(
      name,
      args,
      { openPanel, openLogin, openSecureForm } = {},
    ) {
      if (!allowed.has(name)) throw Error("Not a model-visible CUA tool");
      const result = await client.callTool({ name, arguments: args });
      // Give the raw result only to your trusted UI integration; it contains _meta.
      if (name === "cua_view" && !result.isError && openPanel)
        await openPanel(result);
      if (name === "cua_login" && !result.isError && openLogin)
        await openLogin(result);
      if (name === "cua_secure_form" && !result.isError && openSecureForm)
        await openSecureForm(result);
      return modelResult(result);
    },
    async close() {
      try {
        await transport.terminateSession();
      } finally {
        await client.close();
      }
    },
  };
}
