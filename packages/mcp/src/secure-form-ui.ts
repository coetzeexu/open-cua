import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "CUA Secure Form", version: "0.7.0" });
const element = (id: string) => document.getElementById(id)!;
const form = element("secure-form") as HTMLFormElement;
const fields = element("fields");
const status = element("status");
const open = element("open") as HTMLButtonElement;
const submit = element("submit") as HTMLButtonElement;
const cancel = element("cancel") as HTMLButtonElement;
const check = element("check") as HTMLButtonElement;
const resume = element("resume") as HTMLButtonElement;
const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
let access: { sessionId: string; requestId: string; token: string } | undefined;
let request: any;
let latest: any;
let busy = false,
  polling = false,
  disposed = false,
  attempted = false;
let submissionId: string | undefined;
let failures = 0,
  queries = 0;
let notification: "none" | "sending" | "sent" | "unknown" = "none";
function clear() {
  for (const input of inputs.values()) input.value = "";
}
function hideForm() {
  clear();
  fields.replaceChildren();
  inputs.clear();
  form.hidden = true;
}
function isSettled(value: any) {
  return ["filled", "partial_or_unknown", "failed_before_write"].includes(
    value?.status,
  );
}
function validRequest(value: any) {
  if (
    !value ||
    typeof value.schemaRevision !== "string" ||
    !value.schemaRevision ||
    typeof value.origin !== "string" ||
    typeof value.title !== "string" ||
    !Number.isFinite(value.expiresAt) ||
    value.delivery?.mode !== "fill" ||
    !Array.isArray(value.fields) ||
    value.fields.length < 1 ||
    value.fields.length > 20 ||
    !Array.isArray(value.groups)
  )
    return false;
  const groupIds = new Set<string>();
  for (const group of value.groups) {
    if (
      typeof group?.id !== "string" ||
      !group.id ||
      typeof group.label !== "string" ||
      groupIds.has(group.id)
    )
      return false;
    groupIds.add(group.id);
  }
  const ids = new Set<string>();
  for (const field of value.fields) {
    if (
      typeof field?.id !== "string" ||
      !field.id ||
      ids.has(field.id) ||
      typeof field.label !== "string" ||
      typeof field.required !== "boolean" ||
      !["text", "email", "tel", "password", "date", "select"].includes(
        field.control,
      ) ||
      (field.groupId !== undefined && !groupIds.has(field.groupId))
    )
      return false;
    ids.add(field.id);
    if (field.control === "select") {
      if (!Array.isArray(field.options) || !field.options.length) return false;
      const optionIds = new Set<string>();
      for (const option of field.options) {
        if (
          typeof option?.id !== "string" ||
          !option.id ||
          typeof option.label !== "string" ||
          optionIds.has(option.id)
        )
          return false;
        optionIds.add(option.id);
      }
    }
  }
  return true;
}
function validateInputs() {
  for (const field of request.fields) {
    const input = inputs.get(field.id);
    if (!input) return false;
    const value = input.value;
    let message = "";
    if (field.required && !value.trim()) message = "请填写此项。";
    else if (value.length > Math.min(field.maxLength ?? 4096, 4096))
      message = "内容超过允许长度。";
    else if (
      value &&
      field.control === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      message = "请输入有效邮箱。";
    else if (
      value &&
      field.control === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value ||
        (field.min && value < field.min) ||
        (field.max && value > field.max))
    )
      message = "请按 YYYY-MM-DD 填写有效范围内的日期。";
    else if (
      field.control === "select" &&
      !field.options.some((option: any) => option.id === value)
    )
      message = "请选择网页提供的选项。";
    input.setCustomValidity(message);
  }
  return form.reportValidity();
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool(
    { name, arguments: { ...access, ...args } },
    { timeout: 10000 },
  );
  if (result.isError || !(result._meta as any)?.cua)
    throw Error("Secure form unavailable");
  return (result._meta as any).cua;
}
async function notify() {
  if (
    !latest?.continuation ||
    !isSettled(latest) ||
    disposed ||
    notification === "sending" ||
    notification === "sent"
  )
    return;
  notification = "sending";
  resume.disabled = true;
  try {
    const result = await app.sendMessage(latest.continuation, {
      timeout: 10000,
    });
    if (result.isError) throw Error("Continuation unavailable");
    notification = "sent";
    if (!disposed) element("notice").textContent = "已通知任务继续检查结果。";
  } catch {
    notification = "unknown";
    if (!disposed)
      element("notice").textContent =
        "未能确认通知送达。可点击“继续任务”重查通知；无需重新填写。宿主未支持续接时，请在会话回复“继续检查安全表单结果”。";
  } finally {
    resume.disabled = false;
    resume.hidden = notification === "sent";
  }
}
async function state(value: any) {
  if (disposed) return;
  latest = value;
  if (value.request) request = value.request;
  let phase = value.status;
  if (phase === "pending" && !validRequest(request)) {
    hideForm();
    open.hidden = cancel.hidden = resume.hidden = true;
    check.hidden = false;
    status.textContent = "表单配置不可用，请重新检查页面或使用人工接管。";
    return;
  }
  if (phase === "pending" && Date.now() >= request.expiresAt) {
    phase = "expired";
    latest = { ...value, status: "expired" };
  }
  open.hidden = true;
  check.hidden = true;
  cancel.disabled = busy;
  if (phase === "pending" && !attempted) {
    status.textContent = "等待私密填写。";
    open.hidden = !form.hidden;
    cancel.hidden = false;
    return;
  }
  hideForm();
  cancel.hidden = true;
  if (isSettled(value)) {
    status.textContent =
      phase === "failed_before_write"
        ? "交付前检查失败，未确认任何字段写入；请按下一步重新核验。"
        : phase === "partial_or_unknown"
          ? "交付需要人工检查，不能重试整张表单。"
          : "填写动作已完成；网站业务结果仍需核验。";
    element("next-action").textContent =
      value.nextAction === "human_review"
        ? "请在浏览器面板接管并检查已填内容；继续任务将只通知检查，不重复交付。"
        : "继续任务将读取允许的状态，不会再次填写。";
    if (value.nextAction === "new_request")
      element("next-action").textContent =
        "请让任务重新核验目标并建立新请求，不会复用此前填写内容。";
    resume.textContent =
      value.nextAction === "human_review" ? "通知任务安排人工检查" : "继续任务";
    resume.hidden = !value.continuation || notification === "sent";
    if (notification === "none") await notify();
  } else if (["accepted", "delivering"].includes(phase)) {
    status.textContent = "正在交付，请勿重复提交。";
    check.hidden = false;
  } else if (phase === "pending" && attempted) {
    status.textContent =
      "此前提交结果待确认，不会自动重复提交。请检查网页或重新建立请求。";
    check.hidden = false;
  } else {
    const messages: Record<string, string> = {
      cancelled: "请求已取消。",
      expired: "请求已过期，请让任务重新检查页面。",
      stale: "页面已变化，请让任务重新核验目标。",
      "failed-before-write": "交付前检查失败，请重新检查页面。",
      failed_before_write: "交付前检查失败，请重新检查页面。",
    };
    status.textContent =
      messages[phase] ?? "无法确认结果，请检查网页后继续处理。";
    element("next-action").textContent =
      "可在会话中继续检查，或在浏览器面板人工接管。";
  }
}
async function query(manual = false) {
  if (!access || disposed || busy || polling) return;
  if (manual) failures = queries = 0;
  if (failures >= 3 || queries >= 30) return;
  polling = true;
  if (attempted || latest?.status !== "pending") queries++;
  try {
    const value = await call("cua_ui_secure_form_state");
    failures = 0;
    await state(value);
  } catch {
    failures++;
    status.textContent =
      failures >= 3
        ? "无法确认交付状态。请检查网页，或重新连接后检查原请求；不要重复填写。"
        : "正在确认结果，不会重复交付。";
    check.hidden = false;
  } finally {
    polling = false;
  }
  if (queries >= 30 && !isSettled(latest)) {
    status.textContent = "结果尚未确认。请检查网页，或点击“检查状态”继续查询。";
    check.hidden = false;
  }
}
async function answer(action: "submit" | "decline") {
  if (
    !access ||
    busy ||
    disposed ||
    latest?.status !== "pending" ||
    (action === "submit" && attempted)
  )
    return;
  if (
    action === "submit" &&
    (form.hidden || !validRequest(request) || !validateInputs())
  )
    return;
  if (
    action === "submit" &&
    Date.now() >= (request?.expiresAt ?? latest?.expiresAt ?? Infinity)
  ) {
    await state({ ...latest, status: "expired" });
    return;
  }
  busy = true;
  submit.disabled = cancel.disabled = true;
  let values: Record<string, string> = {};
  if (action === "submit") {
    values = Object.fromEntries(
      [...inputs].map(([id, input]) => [id, input.value]),
    );
    attempted = true;
    submissionId ??= crypto.randomUUID();
  }
  hideForm();
  open.hidden = true;
  status.textContent = "正在确认交付状态…";
  try {
    const value = await call("cua_ui_secure_form_answer", {
      action,
      ...(action === "submit"
        ? { values, submissionId, schemaRevision: request.schemaRevision }
        : {}),
    });
    await state(value);
  } catch {
    // A failed acknowledgement is not proof that the browser was untouched.
    status.textContent = "未能确认结果，正在查询原操作；不会重复交付。";
    check.hidden = false;
  } finally {
    for (const key of Object.keys(values)) values[key] = "";
    values = {};
    busy = false;
    submit.disabled = cancel.disabled = false;
  }
  await query();
}
function renderFields() {
  hideForm();
  const groups = new Map<string, HTMLElement>();
  for (const group of request.groups ?? []) {
    const section = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = group.label;
    section.append(legend);
    fields.append(section);
    groups.set(group.id, section);
  }
  for (const field of request.fields) {
    const label = document.createElement("label");
    label.append(
      document.createTextNode(`${field.label}${field.required ? " *" : ""}`),
    );
    const input =
      field.control === "select"
        ? document.createElement("select")
        : document.createElement("input");
    input.id = `field-${field.id}`;
    input.required = !!field.required;
    input.autocomplete = "off";
    input.oninput = () => input.setCustomValidity("");
    if (input instanceof HTMLSelectElement) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "请选择";
      input.append(blank);
      for (const option of field.options ?? []) {
        const item = document.createElement("option");
        item.value = option.id;
        item.textContent = option.label;
        input.append(item);
      }
    } else {
      input.type =
        field.masked || field.control === "password"
          ? "password"
          : field.control;
      input.maxLength = field.maxLength ?? 4096;
      if (field.min) input.min = field.min;
      if (field.max) input.max = field.max;
      if (field.control === "date")
        input.setAttribute("aria-description", "日期格式 YYYY-MM-DD");
    }
    label.append(input);
    if (field.masked || field.control === "password") {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = "显示";
      reveal.setAttribute("aria-label", `显示或隐藏${field.label}`);
      reveal.onclick = () => {
        const textInput = input as HTMLInputElement;
        textInput.type = textInput.type === "password" ? "text" : "password";
        reveal.textContent = textInput.type === "password" ? "显示" : "隐藏";
      };
      label.append(reveal);
    }
    if (field.nonEmpty) {
      const warning = document.createElement("small");
      warning.textContent = "网页已有内容，本次将覆盖。";
      label.append(warning);
    }
    (groups.get(field.groupId) ?? fields).append(label);
    inputs.set(field.id, input);
  }
  form.hidden = false;
  open.hidden = true;
}
open.onclick = () => {
  if (
    !validRequest(request) ||
    attempted ||
    busy ||
    latest?.status !== "pending"
  )
    return;
  if (Date.now() >= request.expiresAt) {
    void state({ ...latest, status: "expired" });
    return;
  }
  renderFields();
};
element("back").onclick = () => {
  hideForm();
  open.hidden = attempted;
};
element("fullscreen").onclick = () => {
  if (app.getHostContext()?.availableDisplayModes?.includes("fullscreen"))
    void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
};
form.onsubmit = (event) => {
  event.preventDefault();
  void answer("submit");
};
cancel.onclick = () => void answer("decline");
check.onclick = () => void query(true);
resume.onclick = () => void notify();
app.ontoolresult = (result) => {
  const value = (result._meta as any)?.cua;
  if (!value?.token || !value.requestId || disposed) return;
  if (access?.token === value.token) return;
  hideForm();
  access = {
    sessionId: value.sessionId,
    requestId: value.requestId,
    token: value.token,
  };
  request = value.request;
  latest = value;
  attempted = ![undefined, "pending"].includes(value.status);
  submissionId = undefined;
  notification = "none";
  failures = queries = 0;
  element("origin").textContent = request?.origin ?? "已绑定站点";
  element("title").textContent = request?.title ?? "安全表单";
  element("summary").textContent = request
    ? `安全表单 · ${Array.isArray(request.fields) ? request.fields.length : 0} 项`
    : "安全表单 · 查看处理状态";
  submit.textContent = "填入网页";
  element("delivery").textContent = "填写可能触发网页自动保存，请核对站点。";
  element("fullscreen").hidden = !app
    .getHostContext()
    ?.availableDisplayModes?.includes("fullscreen");
  void state(value);
};
const timer = setInterval(() => {
  if (disposed || document.hidden || !access || isSettled(latest)) return;
  if (!["pending", "accepted", "delivering"].includes(latest?.status)) return;
  void query();
}, 2000);
app.onteardown = async () => {
  disposed = true;
  clearInterval(timer);
  hideForm();
  access = request = latest = undefined;
  return {};
};
void app.connect().catch(() => {
  hideForm();
  status.textContent = "宿主不支持安全表单。请使用浏览器面板人工接管。";
});
