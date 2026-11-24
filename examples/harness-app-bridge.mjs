// Run in your trusted host UI bundle. Install @modelcontextprotocol/ext-apps@1.1.2.
// The host supplies an isolated iframe transport and a private backend call route.
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
export async function attachCUAPanel({
  transport,
  viewResult,
  callPrivateTool,
}) {
  const access = viewResult._meta?.cua;
  if (!access?.token || !access.sessionId)
    throw Error("Missing panel authorization");
  const allowed = new Set([
    "cua_ui_state",
    "cua_ui_frame",
    "cua_ui_control",
    "cua_ui_input",
    "cua_ui_answer",
  ]);
  const bridge = new AppBridge(
    null,
    { name: "my-harness", version: "1.0.0" },
    { serverTools: {} },
  );
  bridge.oncalltool = async ({ name, arguments: args }) => {
    if (!allowed.has(name) || args?.sessionId !== access.sessionId)
      throw Error("Panel tool rejected");
    // Bind the view to its server-side session; do not trust a replacement token from UI arguments.
    return callPrivateTool(name, {
      ...args,
      sessionId: access.sessionId,
      token: access.token,
    });
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({
      arguments: { sessionId: access.sessionId, tabId: access.tabId },
    });
    await bridge.sendToolResult(viewResult);
  };
  await bridge.connect(transport);
  return bridge;
}

// Mount ui://cua/login.html in an isolated inline iframe in the conversation.
// This bridge grants no browser viewing/control permissions.
export async function attachCUALogin({
  transport,
  loginResult,
  callPrivateTool,
  enqueueUserMessage,
}) {
  const access = loginResult._meta?.cua;
  if (!access?.token || !access.sessionId || !access.requestId)
    throw Error("Missing login authorization");
  const bridge = new AppBridge(
    null,
    { name: "my-harness", version: "1.0.0" },
    {
      serverTools: {},
      ...(enqueueUserMessage ? { message: { text: {} } } : {}),
    },
  );
  let continuation;
  let notification;
  bridge.oncalltool = async ({ name, arguments: args }) => {
    if (
      !["cua_ui_login_state", "cua_ui_login_answer"].includes(name) ||
      args?.sessionId !== access.sessionId ||
      args?.requestId !== access.requestId
    )
      throw Error("Login tool rejected");
    const result = await callPrivateTool(name, {
      ...args,
      sessionId: access.sessionId,
      requestId: access.requestId,
      token: access.token,
    });
    const value = result._meta?.cua;
    if (!result.isError && value?.status === "submitted")
      continuation = value.continuation;
    return result;
  };
  bridge.onmessage = async (message) => {
    // Only forward the server-generated receipt, never arbitrary app text/values.
    if (
      !enqueueUserMessage ||
      !continuation ||
      JSON.stringify(message) !== JSON.stringify(continuation)
    )
      return { isError: true };
    notification ??= (async () => {
      try {
        await enqueueUserMessage(continuation, {
          idempotencyKey: `cua-login:${access.sessionId}:${access.requestId}`,
        });
        return {};
      } catch {
        // A lost acknowledgement must not enqueue a second model turn.
        return { isError: true };
      }
    })();
    return notification;
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({
      arguments: { sessionId: access.sessionId, requestId: access.requestId },
    });
    await bridge.sendToolResult(loginResult);
  };
  await bridge.connect(transport);
  return bridge;
}

// Mount ui://cua/secure-form.html. Keep raw results, option labels, and values
// inside the trusted UI route. enqueueUserMessage must persist its idempotency key
// before scheduling a turn if the host needs recovery across iframe restarts.
export async function attachCUASecureForm({
  transport,
  formResult,
  callPrivateTool,
  enqueueUserMessage,
}) {
  const access = formResult._meta?.cua;
  if (!access?.token || !access.sessionId || !access.requestId)
    throw Error("Missing secure form authorization");
  const bridge = new AppBridge(
    null,
    { name: "my-harness", version: "1.0.0" },
    {
      serverTools: {},
      ...(enqueueUserMessage ? { message: { text: {} } } : {}),
    },
  );
  let continuation;
  const notifications = new Map();
  function acceptReceipt(result) {
    const value = result._meta?.cua;
    if (
      !result.isError &&
      ["filled", "failed_before_write", "partial_or_unknown"].includes(
        value?.status,
      )
    )
      continuation = value.continuation;
  }
  acceptReceipt(formResult);
  bridge.oncalltool = async ({ name, arguments: args }) => {
    if (
      !["cua_ui_secure_form_state", "cua_ui_secure_form_answer"].includes(
        name,
      ) ||
      args?.sessionId !== access.sessionId ||
      args?.requestId !== access.requestId
    )
      throw Error("Secure form tool rejected");
    const result = await callPrivateTool(name, {
      ...args,
      sessionId: access.sessionId,
      requestId: access.requestId,
      token: access.token,
    });
    acceptReceipt(result);
    return result;
  };
  bridge.onmessage = async (message) => {
    if (
      !enqueueUserMessage ||
      !continuation ||
      JSON.stringify(message) !== JSON.stringify(continuation)
    )
      return { isError: true };
    // One request has a single submission. Even on lost acknowledgements the
    // same key is reused; scheduling exactly once requires host-side deduplication.
    const key = `cua-secure-form:${access.sessionId}:${access.requestId}`;
    if (!notifications.has(key)) {
      const receipt = continuation;
      notifications.set(
        key,
        (async () => {
          try {
            await enqueueUserMessage(receipt, { idempotencyKey: key });
            return {};
          } catch {
            return { isError: true };
          }
        })(),
      );
    }
    return notifications.get(key);
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({
      arguments: { sessionId: access.sessionId, requestId: access.requestId },
    });
    await bridge.sendToolResult(formResult);
  };
  await bridge.connect(transport);
  return bridge;
}
