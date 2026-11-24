import { viewportPoint } from "/geometry.js";
const $ = (id) => document.getElementById(id);
let control = "paused",
  active = false,
  busy = false,
  currentFrame,
  frameTime = 0,
  objectUrl;
const showError = (message) => {
  $("error").textContent = message;
  $("error").hidden = !message;
};
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? "请求失败");
  return value;
}
function buttons() {
  $("run").disabled = busy || control !== "agent" || active;

  $("take").disabled =
    busy || control === "human" || control === "interrupting";
  $("stop").disabled =
    busy || control === "paused" || control === "interrupting";
  $("resume").disabled =
    busy || control === "agent" || control === "interrupting";
  $("url").disabled = control !== "human";
  $("inputHint").textContent =
    control === "human"
      ? "你正在控制 · 点击画面后可拖动、输入、粘贴和滚动"
      : "只读预览 · 取得控制权后可点击、拖动、输入和滚动";
  $("screen").style.cursor = control === "human" ? "crosshair" : "default";
}
async function update() {
  try {
    const s = await api("/api/state");
    control = s.control;
    active = s.active;
    $("mode").textContent = {
      agent: "模型控制",
      human: "人工控制",
      paused: "已暂停",
      interrupting: "正在中断",
    }[control];
    $("mode").className = "mode " + control;
    $("platform").textContent = s.platform + " / " + s.node;
    $("browser").textContent = "Chromium " + s.browser;
    $("provider").textContent = s.provider + " · CDP";
    $("execution").textContent = s.active
      ? "执行中"
      : (s.lastExecution?.status ?? "待命");
    $("session").textContent = s.sessionId.slice(0, 8);
    $("hint").textContent =
      control === "human"
        ? "人工操作期间，模型执行被服务端阻止"
        : control === "paused"
          ? "任务保持暂停，取得控制权或交还模型后继续"
          : "可运行演示并随时接手";
    $("logs").replaceChildren(
      ...s.logs.map((l) => {
        const item = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = new Date(l.time).toLocaleTimeString();
        item.append(time, document.createTextNode(l.message));
        return item;
      }),
    );
    document.dispatchEvent(new CustomEvent("preview-state", { detail: s }));
    buttons();
  } catch (e) {
    $("connection").textContent = "连接不可用";
    $("liveDot").className = "";
    showError(e.message);
  } finally {
    setTimeout(update, 800);
  }
}
async function frames() {
  const started = performance.now();
  try {
    const response = await fetch("/api/frame", {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error("画面暂不可用");
    const frame = {
      frameId: Number(response.headers.get("X-Frame-Id")),
      width: Number(response.headers.get("X-Frame-Width")),
      height: Number(response.headers.get("X-Frame-Height")),
    };
    const next = URL.createObjectURL(await response.blob());
    const image = new Image();
    image.src = next;
    await image.decode();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = next;
    $("screen").src = next;
    currentFrame = frame;
    frameTime = Date.now();
    $("loading").style.display = "none";
    $("connection").textContent = "LIVE · 已连接";
    $("liveDot").className = "online";
    $("frameInfo").textContent =
      `${frame.width} × ${frame.height} · ${Math.round(performance.now() - started)} ms`;
  } catch {
    frameTime = 0;
    $("connection").textContent = "画面断开 · 输入已停用";
    $("liveDot").className = "";
  }
  setTimeout(frames, Math.max(50, 250 - (performance.now() - started)));
}
async function command(action) {
  busy = true;
  buttons();
  showError("");
  try {
    await api(
      action.startsWith("demo") ? "/api/" + action : "/api/control",
      action.startsWith("demo") ? {} : { action },
    );
  } catch (e) {
    showError(e.message);
  } finally {
    busy = false;
    buttons();
  }
}
$("run").onclick = () => command("demo");

$("take").onclick = () => command("take");
$("stop").onclick = () => command("interrupt");
$("resume").onclick = () => command("resume");
let inputQueue = Promise.resolve();
let queued = 0;
function input(data) {
  if (control !== "human" || !currentFrame || Date.now() - frameTime > 3000)
    return;
  if (queued > 16) {
    showError("输入过快，请稍候");
    return;
  }
  const payload = { ...data, frameId: currentFrame.frameId };
  queued++;
  inputQueue = inputQueue
    .then(() => api("/api/input", payload))
    .catch((e) => showError(e.message))
    .finally(() => queued--);
}
function position(e) {
  const rect = $("screen").getBoundingClientRect();
  return viewportPoint(rect, currentFrame, e.clientX, e.clientY);
}
let pointerId,
  lastPointer,
  lastMove = 0;
const screen = $("screen");
screen.ondragstart = (e) => e.preventDefault();
screen.onpointerdown = (e) => {
  if (
    control !== "human" ||
    !currentFrame ||
    e.button !== 0 ||
    pointerId !== undefined
  )
    return;
  const point = position(e);
  if (!point) return;
  e.preventDefault();
  pointerId = e.pointerId;
  lastPointer = point;
  lastMove = 0;
  screen.setPointerCapture(e.pointerId);
  $("keyboard").focus({ preventScroll: true });
  input({ type: "pointer", phase: "down", ...point });
};
screen.onpointermove = (e) => {
  if (pointerId !== e.pointerId) return;
  e.preventDefault();
  const point = position(e);
  if (!point) return;
  lastPointer = point;
  if (performance.now() - lastMove < 80) return;
  lastMove = performance.now();
  input({ type: "pointer", phase: "move", ...point });
};
function endPointer(e) {
  if (pointerId !== e.pointerId) return;
  e.preventDefault();
  const point = position(e) ?? lastPointer;
  if (point) {
    if (e.type === "pointerup")
      input({ type: "pointer", phase: "move", ...point });
    input({
      type: "pointer",
      phase: e.type === "pointerup" ? "up" : "cancel",
      ...point,
    });
  }
  pointerId = undefined;
  if (screen.hasPointerCapture(e.pointerId))
    screen.releasePointerCapture(e.pointerId);
}
screen.onpointerup = endPointer;
screen.onpointercancel = endPointer;
screen.onlostpointercapture = endPointer;
$("screen").addEventListener(
  "wheel",
  (e) => {
    if (control !== "human" || !currentFrame) return;
    e.preventDefault();
    const point = position(e);
    if (!point) return;
    input({
      type: "wheel",
      ...point,
      deltaX: Math.max(-2000, Math.min(2000, e.deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, e.deltaY)),
    });
  },
  { passive: false },
);
$("keyboard").addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
  e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")
    return input({ type: "selectAll" });
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
    return input({ type: "text", text: e.key });
  if (
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
    input({
      type: "key",
      key: e.key,
      modifiers:
        (e.altKey ? 1 : 0) +
        (e.ctrlKey ? 2 : 0) +
        (e.metaKey ? 4 : 0) +
        (e.shiftKey ? 8 : 0),
    });
});
$("keyboard").addEventListener("paste", (e) => {
  e.preventDefault();
  input({ type: "text", text: e.clipboardData.getData("text").slice(0, 2000) });
});
$("keyboard").addEventListener("compositionend", (e) => {
  input({ type: "text", text: e.data });
  $("keyboard").value = "";
});
$("nav").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/navigate", { url: $("url").value });
    showError("");
  } catch (error) {
    showError(error.message);
  }
};
(async () => {
  try {
    if (location.hash.length > 1) {
      const token = location.hash.slice(1);
      history.replaceState(null, "", location.pathname);
      const r = await fetch("/auth", {
        method: "POST",
        headers: { "X-CUA-Preview-Token": token },
      });
      if (!r.ok) throw Error("访问码无效");
    }
    await api("/api/state");
    update();
    frames();
  } catch (e) {
    showError("无法连接：" + e.message + "。请使用包含访问码的 preview 链接。");
  }
})();

fetch("/__demo/info")
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info?.expiresAt) return;
    $("endDemo").hidden = false;
    $("endDemo").title =
      "到期自动释放：" + new Date(info.expiresAt).toLocaleString();
    $("endDemo").onclick = async () => {
      try {
        await api("/__demo/close", {});
        showError("演示已结束，沙箱已释放。");
        $("endDemo").disabled = true;
      } catch (e) {
        showError(e.message);
      }
    };
  })
  .catch(() => {});
