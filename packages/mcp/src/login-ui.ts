import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "CUA Private Login", version: "0.7.0" });
const form = document.getElementById("login") as HTMLFormElement;
const fields = document.getElementById("fields")!;
const status = document.getElementById("status")!;
const submit = document.getElementById("submit") as HTMLButtonElement;
const cancel = document.getElementById("cancel") as HTMLButtonElement;
let access: { sessionId: string; requestId: string; token: string } | undefined;
let expiresAt = 0;
let busy = false,
  ended = false,
  polling = false;
const notified = new Set<string>();
let disposed = false;
const inputs = new Map<string, HTMLInputElement>();
function clear() {
  for (const input of inputs.values()) input.value = "";
}
function finish(message: string) {
  ended = true;
  clear();
  form.hidden = true;
  fields.replaceChildren();
  inputs.clear();
  status.textContent = message;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({
    name,
    arguments: { ...access, ...args },
  });
  if (result.isError) throw Error("Login unavailable");
  return (result._meta as any)?.cua;
}
async function state(value: any) {
  if (value?.status === "submitted") {
    finish("已提交，正在通知任务继续…");
    const key = access && `${access.sessionId}:${access.requestId}`;
    if (!key || notified.has(key) || disposed) return;
    notified.add(key);
    try {
      if (!value.continuation) throw Error("Continuation unavailable");
      const result = await app.sendMessage(value.continuation, {
        timeout: 10000,
      });
      if (result.isError) throw Error("Continuation rejected");
      if (!disposed)
        status.textContent = "已提交并通知任务继续，正在确认登录结果。";
    } catch {
      if (!disposed)
        status.textContent =
          "已提交，但未能确认任务自动继续。请在会话回复“继续检查登录结果”，无需重新输入账号密码。";
    }
  } else if (value?.status === "cancelled") finish("已取消登录请求。");
  else if (value?.status === "expired")
    finish("请求已结束或过期，请让任务重新检查页面。");
}
async function answer(action: "submit" | "decline") {
  if (!access || busy || ended) return;
  if (Date.now() >= expiresAt) {
    finish("登录请求已过期。");
    return;
  }
  busy = true;
  submit.disabled = cancel.disabled = true;
  const values = Object.fromEntries(
    [...inputs].map(([id, input]) => [id, input.value]),
  );
  clear();
  let response;
  try {
    response = await call("cua_ui_login_answer", {
      action,
      ...(action === "submit" ? { values } : {}),
    });
  } catch {
    // Do not replay a credential submission whose outcome is unknown.
    finish("未能确认提交结果，请让任务检查页面或重新打开登录卡片。");
  } finally {
    for (const key of Object.keys(values)) values[key] = "";
  }
  if (response && !disposed) await state(response);
  busy = false;
  submit.disabled = cancel.disabled = ended;
}
form.onsubmit = (e) => {
  e.preventDefault();
  void answer("submit");
};
cancel.onclick = () => void answer("decline");
app.ontoolresult = (result) => {
  const v = (result._meta as any)?.cua;
  if (!v?.token || !v.request || disposed) return;
  if (access && access.token === v.token && access.requestId === v.requestId)
    return;
  clear();
  fields.replaceChildren();
  inputs.clear();
  access = { sessionId: v.sessionId, requestId: v.requestId, token: v.token };
  expiresAt = v.expiresAt;
  ended = false;
  document.getElementById("origin")!.textContent =
    `登录站点：${v.request.origin}`;
  for (const field of v.request.fields) {
    const label = document.createElement("label");
    label.append(document.createTextNode(field.label));
    const input = document.createElement("input");
    input.type = field.type === "password" ? "password" : "text";
    input.autocomplete = "off";
    input.required = true;
    input.maxLength = 4096;
    label.append(input);
    fields.append(label);
    inputs.set(field.id, input);
  }
  status.textContent = "等待你填写并提交。";
  form.hidden = false;
  submit.disabled = cancel.disabled = false;
};
const timer = setInterval(async () => {
  if (!access || ended || busy || polling) return;
  if (Date.now() >= expiresAt) {
    finish("登录请求已过期。");
    return;
  }
  if (document.hidden) return;
  polling = true;
  try {
    const value = await call("cua_ui_login_state");
    if (!busy && !ended && !disposed) await state(value);
  } catch {
    if (!busy && !ended) finish("登录请求已失效，请重新打开卡片。");
  } finally {
    polling = false;
  }
}, 1000);
app.onteardown = async () => {
  disposed = true;
  clearInterval(timer);
  finish("登录卡片已关闭。");
  access = undefined;
  return {};
};
void app
  .connect()
  .catch(() => finish("宿主不支持登录卡片，请使用 CLI 私密输入通道。"));
