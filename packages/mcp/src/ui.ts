import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "CUA Browser", version: "0.7.0" });
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const screen = $<HTMLImageElement>("screen");
let access: { sessionId: string; token: string } | undefined;
let recoveryToken: string | undefined;
let recovering = false;
let disconnected = false;
let frame: { id: number; width: number; height: number } | undefined;
let frameAt = 0;
const freshFrame = () => !!frame && Date.now() - frameAt < 4000;
let human = false,
  ended = false,
  polling = false,
  held = false,
  signature = "";
let chain = Promise.resolve();
let pendingText = "";
let textTimer: ReturnType<typeof setTimeout> | undefined;
let controlRevision = 0;
function flushText() {
  clearTimeout(textTimer);
  if (!pendingText) return;
  const text = pendingText;
  pendingText = "";
  chain = chain.then(() => send({ type: "text", text })).catch(error);
}
const error = () => {
  $("error").textContent = "操作失败，请刷新画面后重试。";
};
function disconnect() {
  disconnected = true;
  human = false;
  held = false;
  drag = undefined;
  clearTimeout(press?.timer);
  press = undefined;
  clearTimeout(textTimer);
  pendingText = "";
  frame = undefined;
  screen.removeAttribute("src");
  screen.hidden = true;
  $("empty").hidden = true;
  $("viewport").classList.add("disconnected");
  $("wake-overlay").hidden = false;
  $("status").textContent = recovering ? "正在唤醒…" : "连接已断开";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "button[data-action], #insert, #enter, #select, #refresh",
  ))
    button.disabled = true;
  $("requests").replaceChildren();
  signature = "";
  $<HTMLButtonElement>("recover").disabled = recovering || !recoveryToken;
}
function wakeLoading(active: boolean) {
  $("wake-overlay").setAttribute("aria-busy", String(active));
  $("wake-spinner").hidden = !active;
  $("wake-label").textContent = active ? "正在唤醒…" : "唤醒";
  $<HTMLButtonElement>("recover").disabled = active || !recoveryToken;
}
const enqueue = (work: () => Promise<void>) => {
  flushText();
  chain = chain.then(work).catch(error);
  return chain;
};
async function call(name: string, args: Record<string, unknown> = {}) {
  if (!access || ended) throw Error("Panel unavailable");
  if (name !== "cua_ui_state" && name !== "cua_ui_frame") controlRevision++;
  const result = await app.callServerTool({
    name,
    arguments: { ...access, ...args },
  });
  if (result.isError) throw Error("Panel rejected");
  return (result._meta as any)?.cua;
}
function state(value: any) {
  const control = value?.status?.control;
  human = control === "human";
  $("status").textContent =
    control === "agent"
      ? "模型控制中"
      : control === "human"
        ? "人工控制中"
        : control === "paused"
          ? "已中断，模型暂停"
          : control === "interrupting"
            ? "正在停止模型…"
            : "会话已结束";
  if (!control) {
    ended = true;
    disconnect();
  }
  screen.classList.toggle("active", human && freshFrame());
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    "button[data-action]",
  ))
    b.disabled =
      !control ||
      control === "interrupting" ||
      (b.dataset.action === "resume" && control === "agent");
  for (const id of ["insert", "enter", "select"])
    $<HTMLButtonElement>(id).disabled = !human || !freshFrame();
  $<HTMLButtonElement>("refresh").disabled = !control;
  const requests = (value?.requests ?? []).filter(
    (r: any) => r.type === "handoff",
  );
  const next = JSON.stringify(requests.map((r: any) => r.id));
  if (next === signature) return;
  signature = next;
  $("requests").replaceChildren();
  for (const r of requests) {
    const form = document.createElement("form");
    const p = document.createElement("p");
    p.textContent = `人工请求：${r.reason ?? r.origin}`;
    form.append(p);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "已完成，恢复等待任务";
    form.append(submit);
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "取消请求";
    form.append(decline);
    form.onsubmit = (e) => {
      e.preventDefault();
      submit.disabled = true;
      void enqueue(async () => {
        try {
          state(
            await call("cua_ui_answer", {
              requestId: r.id,
              action: "resume",
            }),
          );
        } finally {
          submit.disabled = false;
        }
      });
    };
    decline.onclick = () =>
      void enqueue(async () =>
        state(
          await call("cua_ui_answer", { requestId: r.id, action: "decline" }),
        ),
      );
    $("requests").append(form);
  }
}
async function refresh(waking = false) {
  if (
    polling ||
    ended ||
    !access ||
    (!waking && (document.hidden || disconnected || recovering))
  ) {
    if (waking) throw Error("Refresh unavailable");
    return;
  }
  polling = true;
  try {
    const revision = controlRevision;
    const [statusResult, frameResult] = await Promise.allSettled([
      call("cua_ui_state"),
      call("cua_ui_frame"),
    ]);
    if (statusResult.status === "rejected") throw statusResult.reason;
    if (revision === controlRevision) state(statusResult.value);
    if (ended) throw Error("Session ended");
    if (frameResult.status === "rejected") {
      // A slow/backgrounded tab can time out while the control session is
      // healthy. Do not revoke human control or ask the user to wake it.
      if (waking) throw frameResult.reason;
      $("error").textContent = "画面更新暂时失败，正在自动重试。";
      return;
    }
    const shot = frameResult.value;
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        screen.src = img.src;
        screen.hidden = false;
        frame = shot;
        frameAt = Date.now();
        screen.classList.toggle("active", human);
        $("empty").hidden = true;
        resolve();
      };
      img.onerror = reject;
      img.src = `data:image/jpeg;base64,${shot.data}`;
    });
    disconnected = false;
    $("viewport").classList.remove("disconnected");
    $("wake-overlay").hidden = true;
    for (const id of ["insert", "enter", "select"])
      $<HTMLButtonElement>(id).disabled = !human;
    $("error").textContent = "";
  } catch (cause) {
    disconnect();
    if (waking) throw cause;
    $("error").textContent = "";
  } finally {
    polling = false;
  }
}
async function send(input: Record<string, unknown>) {
  if (!human || !frame || !freshFrame()) {
    void refresh();
    throw Error("Wait for a fresh frame");
  }
  state(await call("cua_ui_input", { input: { frameId: frame.id, ...input } }));
  void refresh();
}
function point(e: MouseEvent) {
  const box = screen.getBoundingClientRect();
  if (!frame || !box.width || !box.height) return;
  return {
    x: Math.max(
      0,
      Math.min(
        frame.width - 1,
        ((e.clientX - box.left) * frame.width) / box.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        frame.height - 1,
        ((e.clientY - box.top) * frame.height) / box.height,
      ),
    ),
  };
}
screen.ondragstart = (e) => e.preventDefault();
type Drag = { next?: { x: number; y: number }; queued: boolean };
let drag: Drag | undefined;
let press:
  | {
      point: { x: number; y: number };
      started: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
function startPress() {
  if (!press || press.started) return;
  clearTimeout(press.timer);
  press.started = true;
  const p = press.point;
  void enqueue(() => send({ type: "pointer", phase: "down", ...p }));
}
async function flushMoves(current: Drag) {
  while (current.next) {
    const p = current.next;
    current.next = undefined;
    await send({ type: "pointer", phase: "move", ...p });
  }
}
screen.onpointerdown = (e) => {
  if (!human || !frame || e.button !== 0) return;
  e.preventDefault();
  const p = point(e);
  if (!p) return;
  held = true;
  drag = { queued: false };
  screen.focus();
  screen.setPointerCapture(e.pointerId);
  flushText();
  press = { point: p, started: false, timer: setTimeout(startPress, 150) };
};
screen.onpointermove = (e) => {
  if (!held || !drag) return;
  const p = point(e);
  if (!p || !press) return;
  if (
    !press.started &&
    Math.hypot(p.x - press.point.x, p.y - press.point.y) < 4
  )
    return;
  startPress();
  const current = drag;
  current.next = p;
  if (current.queued) return;
  current.queued = true;
  void enqueue(async () => {
    try {
      await flushMoves(current);
    } finally {
      current.queued = false;
    }
  });
};
const release = (end?: { x: number; y: number }) => {
  if (!held) return;
  held = false;
  const pressed = press;
  press = undefined;
  clearTimeout(pressed?.timer);
  const current = drag;
  drag = undefined;
  if (pressed && !pressed.started) {
    if (end) void enqueue(() => send({ type: "click", ...end }));
    return;
  }
  if (current) current.next = end;
  void enqueue(async () => {
    try {
      if (current) await flushMoves(current);
    } finally {
      // Even a stale frame or failed final move must release the button.
      await call("cua_ui_control", { action: "release" });
    }
  });
};
screen.onpointerup = (e) => release(point(e));
screen.onpointercancel = () => release();
screen.onlostpointercapture = () => release();
let wheel: { x: number; y: number; deltaX: number; deltaY: number } | undefined;
let wheelQueued = false;
screen.onwheel = (e) => {
  if (!human || !frame) return;
  e.preventDefault();
  const p = point(e);
  if (!p) return;
  wheel = {
    ...p,
    deltaX: Math.max(-2000, Math.min(2000, (wheel?.deltaX ?? 0) + e.deltaX)),
    deltaY: Math.max(-2000, Math.min(2000, (wheel?.deltaY ?? 0) + e.deltaY)),
  };
  if (wheelQueued) return;
  wheelQueued = true;
  void enqueue(async () => {
    try {
      while (wheel) {
        const value = wheel;
        wheel = undefined;
        await send({ type: "wheel", ...value });
      }
    } finally {
      wheelQueued = false;
    }
  });
};
screen.onkeydown = (e) => {
  if (!human || !frame) return;
  e.preventDefault();
  const modifiers =
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0);
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (pendingText.length >= 2000) flushText();
    pendingText += e.key;
    clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 120);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")
    void enqueue(() => send({ type: "selectAll" }));
  else if (
    [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(e.key)
  )
    void enqueue(() => send({ type: "key", key: e.key, modifiers }));
};
for (const b of document.querySelectorAll<HTMLButtonElement>(
  "button[data-action]",
))
  b.onclick = () => {
    held = false;
    clearTimeout(press?.timer);
    press = undefined;
    if (drag) drag.next = undefined;
    drag = undefined;
    void enqueue(async () => {
      state(await call("cua_ui_control", { action: b.dataset.action }));
      void refresh();
    });
  };
$("insert").onclick = () => {
  const input = $<HTMLInputElement>("text");
  let text = input.value;
  input.value = "";
  void enqueue(async () => {
    try {
      await send({ type: "text", text });
    } finally {
      text = "";
    }
  });
};
$("enter").onclick = () =>
  void enqueue(() => send({ type: "key", key: "Enter" }));
$("select").onclick = () => void enqueue(() => send({ type: "selectAll" }));
$("recover").onclick = () => {
  if (!access || !recoveryToken || recovering || !disconnected) return;
  recovering = true;
  wakeLoading(true);
  $("status").textContent = "正在唤醒…";
  $("error").textContent = "";
  void enqueue(async () => {
    try {
      const result = await app.callServerTool({
        name: "cua_ui_recover",
        arguments: { sessionId: access!.sessionId, token: recoveryToken! },
      });
      if (result.isError) throw Error("Recovery failed");
      const v = (result._meta as any)?.cua;
      access = { sessionId: v.sessionId, token: v.token };
      recoveryToken = v.recoveryToken;
      ended = false;
      human = false;
      held = false;
      drag = undefined;
      frame = undefined;
      screen.removeAttribute("src");
      await refresh(true);
      $("recovery-note").textContent = v.recreated
        ? "已新建会话和空白页面；原页面及未保存状态无法恢复。请取得控制权或让模型继续。"
        : "已重新连接原页面，请按需取得控制权。";
    } catch {
      disconnect();
      $("status").textContent = "唤醒失败";
      $("error").textContent =
        "唤醒失败，请重试；若服务连接已断开，请重新连接 MCP 并打开面板。";
    } finally {
      recovering = false;
      wakeLoading(false);
    }
  });
};
$("refresh").onclick = () => void refresh();
window.addEventListener("blur", () => release());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) release();
});
app.ontoolresult = (result) => {
  const v = (result._meta as any)?.cua;
  if (v?.token && v.sessionId) {
    access = { sessionId: v.sessionId, token: v.token };
    recoveryToken = v.recoveryToken;
    $<HTMLButtonElement>("recover").disabled = !recoveryToken;
    ended = false;
    disconnected = false;
    void refresh();
  }
};
const timer = setInterval(() => void refresh(), 1000);
app.onteardown = async () => {
  clearInterval(timer);
  clearTimeout(press?.timer);
  press = undefined;
  flushText();
  await chain;
  try {
    await call("cua_ui_control", { action: "close" });
  } catch {}
  ended = true;
  access = undefined;
  screen.removeAttribute("src");
  return {};
};
void app.connect().catch(() => {
  $("status").textContent = "宿主未提供 MCP Apps 连接，请使用 CLI 人工通道。";
});
