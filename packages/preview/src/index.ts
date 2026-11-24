import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserProvider, ExecutionResult } from "@cua/contracts";
import { CUAService } from "@cua/service";
import {
  ChromiumBinding,
  ChromiumTab,
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
import { SandboxBrowserProvider } from "@cua/browser-sandbox";

const fixture = `<!doctype html><meta charset="utf-8"><title>CUA 演示工作台</title><style>body{font:18px system-ui;background:#f2f5f8;color:#172a3a;padding:50px}main{max-width:700px;margin:auto;background:white;padding:36px;border-radius:16px}small{color:#52758c}h1{font-size:30px}input,button{font:inherit;padding:14px;border-radius:8px;border:1px solid #b7c8d5}input{width:65%}button{background:#234f68;color:white;cursor:pointer}#count{font-size:52px;color:#234f68}li{margin:12px 0}</style><main><small>LIVE BROWSER · 同一个页面 / 两种控制方式</small><h1>模型与人工接力</h1><p>在 preview 点击“运行演示”，然后取得控制权，直接在这里输入、点击或滚动。</p><label for="message">输入内容</label><p><input id="message" aria-label="输入内容" placeholder="点击这里输入"><button id="submit">提交</button></p><p role="status">等待操作</p><div id="count">0</div><small>已提交次数</small><p><label for="drag">人工拖动测试</label><input id="drag" type="range" min="0" max="100" value="0" aria-label="人工拖动测试"></p><ol id="history"></ol></main><script>let count=0;document.querySelector('#submit').onclick=()=>{const value=document.querySelector('input').value;document.querySelector('[role=status]').textContent='已收到：'+value;document.querySelector('#count').textContent=++count;const li=document.createElement('li');li.textContent=value;document.querySelector('#history').prepend(li);};</script>`;
const assets = new URL("../public/", import.meta.url);
const same = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const cookies = (r: IncomingMessage) =>
  r.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("cua_preview="))
    ?.slice(12) ?? "";
async function body(req: IncomingMessage): Promise<any> {
  let data = "";
  for await (const part of req) {
    data += part;
    if (data.length > 16384) throw Error("Request too large");
  }
  return JSON.parse(data || "{}");
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
/** Consume only new output, so early output cannot starve IPC completion events. */
export async function waitPreviewExecution(
  service: CUAService,
  sessionId: string,
  initial: ExecutionResult,
) {
  let result = initial;
  const output = [...result.output];
  while (result.status === "running") {
    result = await service.getExecution({
      sessionId,
      executionId: result.executionId,
      cursor: result.cursor ?? output.length,
      waitMs: 1000,
    });
    output.push(...result.output);
  }
  return { ...result, output };
}
export async function startPreview(
  options: {
    scenario?: (
      service: CUAService,
      sessionId: string,
      tabId: string,
      log: (message: string) => void,
    ) => {
      start(): void;
      cancel(): void;
      active(): boolean;
      state(): unknown;
    };
    scenarioScript?: URL;
    provider?: BrowserProvider;
    host?: string;
    port?: number;
    token?: string;
  } = {},
) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32)
    throw Error("Preview token must contain at least 32 characters");
  const original = options.provider ?? new SandboxBrowserProvider();
  let binding: ChromiumBinding | undefined;
  const service = new CUAService({
    profiles: {
      preview: () => ({
        browser: {
          descriptor: original.descriptor,
          resourceKey: original.resourceKey,
          async connect(context) {
            const connected = await original.connect(context);
            if (!(connected instanceof ChromiumBinding)) {
              await connected.close();
              throw Error("Preview requires Chromium");
            }
            binding = connected;
            return connected;
          },
        },
        capabilities: chromiumCapabilities(),
        targetResolvers: [new ChromiumTargetResolver()],
      }),
    },
    executeWaitMs: 0,
    cellTimeoutMs: 120000,
    idleMs: 3600000,
  });
  let tab: ChromiumTab;
  let sessionId: string;
  try {
    ({ sessionId } = await service.createSession());
    let boot = await service.execute({
      sessionId,
      code: `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify("data:text/html," + encodeURIComponent(fixture))}});output.text(tab.id);`,
    });
    boot = await waitPreviewExecution(service, sessionId, boot);
    if (boot.status !== "succeeded")
      throw Error("Preview browser initialization failed");
    tab = (await binding!.get(
      String(boot.output.find((o) => o.type === "text")?.text),
    )) as ChromiumTab;
  } catch (error) {
    await service.close();
    throw error;
  }
  const cdp = await binding!.context.newCDPSession(tab.page);
  const logs: { time: string; message: string }[] = [];
  const log = (message: string) => {
    logs.unshift({ time: new Date().toISOString(), message });
    logs.splice(30);
  };
  let epoch = 0;
  let pointer: { x: number; y: number; epoch: number } | undefined;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  const releasePointer = async () => {
    clearTimeout(pointerTimer);
    const held = pointer;
    pointer = undefined;
    if (held)
      await cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: held.x,
          y: held.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {});
  };
  tab.page.on("framenavigated", (frame) => {
    if (frame === tab.page.mainFrame()) {
      epoch++;
      void releasePointer();
    }
  });
  let frameSequence = 0;
  const frames = new Map<
    number,
    { time: number; epoch: number; width: number; height: number }
  >();
  let capturing:
    | Promise<{ data: Buffer; id: number; width: number; height: number }>
    | undefined;
  let closed = false;
  let lastExecution: { id: string; status: string } | undefined;
  const capture = () =>
    (capturing ??= (async () => {
      const before = epoch;
      const layout = await cdp.send("Page.getLayoutMetrics");
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 65,
        captureBeyondViewport: false,
      });
      if (epoch !== before) throw Error("Page changed; request a fresh frame");
      const { clientWidth: width, clientHeight: height } =
        layout.cssVisualViewport;
      const id = ++frameSequence;
      frames.set(id, { time: Date.now(), epoch, width, height });
      while (frames.size > 16) frames.delete(frames.keys().next().value!);
      return { data: Buffer.from(shot.data, "base64"), id, width, height };
    })().finally(() => {
      capturing = undefined;
    }));
  const observeResult = async (id: string) => {
    try {
      let result = await service.getExecution({
        sessionId,
        executionId: id,
        waitMs: 1000,
      });
      result = await waitPreviewExecution(service, sessionId, result);
      lastExecution = { id, status: result.status };
      log(
        result.status === "succeeded"
          ? "模型演示完成"
          : `模型执行已结束：${result.status}`,
      );
    } catch {
      if (!closed) log("模型执行已停止");
    }
  };
  const scenario = options.scenario?.(service, sessionId, tab.id, log);
  const state = () => ({
    sessionId,
    provider: original.descriptor.id,
    platform: process.platform,
    node: process.version,
    browser: binding!.browser.version(),
    control: service.status()[0]?.control ?? "paused",
    active: scenario?.active() || service.status()[0]?.status === "busy",
    scenario: scenario?.state(),
    lastExecution,
    logs,
    frameAgeMs: frames.size
      ? Date.now() - [...frames.values()].at(-1)!.time
      : null,
  });
  const manualInput = async (input: any) => {
    const frame = frames.get(input.frameId);
    if (!frame || frame.epoch !== epoch || Date.now() - frame.time > 5000)
      throw Error("Refresh the live view before sending input");
    await service.runHumanAction(sessionId, async () => {
      if (["click", "wheel", "pointer"].includes(input.type)) {
        if (
          !Number.isFinite(input.x) ||
          !Number.isFinite(input.y) ||
          input.x < 0 ||
          input.y < 0 ||
          input.x >= frame.width ||
          input.y >= frame.height
        )
          throw Error("Invalid coordinates");
        if (input.type === "pointer") {
          if (!["down", "move", "up", "cancel"].includes(input.phase))
            throw Error("Invalid pointer phase");
          if (input.phase === "cancel" || input.phase === "up") {
            await releasePointer();
            return;
          }
          if (input.phase === "down") {
            await releasePointer();
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: input.x,
              y: input.y,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
          } else {
            if (!pointer || pointer.epoch !== epoch)
              throw Error("Pointer is no longer held");
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: input.x,
              y: input.y,
              button: "left",
              buttons: 1,
            });
          }
          pointer = { x: input.x, y: input.y, epoch };
          clearTimeout(pointerTimer);
          pointerTimer = setTimeout(() => {
            void releasePointer();
          }, 3000);
        } else if (input.type === "click") {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
        } else {
          if (
            ![input.deltaX, input.deltaY].every(
              (v) => Number.isFinite(v) && Math.abs(v) <= 2000,
            )
          )
            throw Error("Invalid wheel delta");
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          });
        }
      } else if (input.type === "text") {
        if (typeof input.text !== "string" || input.text.length > 2000)
          throw Error("Invalid text");
        await cdp.send("Input.insertText", { text: input.text });
      } else if (input.type === "key") {
        const keys: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Backspace: 8,
          Delete: 46,
          Escape: 27,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          Home: 36,
          End: 35,
          PageUp: 33,
          PageDown: 34,
        };
        if (
          !Object.hasOwn(keys, input.key) ||
          !Number.isInteger(input.modifiers ?? 0) ||
          (input.modifiers ?? 0) < 0 ||
          (input.modifiers ?? 0) > 15
        )
          throw Error("Unsupported key");
        const params = {
          key: input.key,
          code: input.key,
          windowsVirtualKeyCode: keys[input.key],
          modifiers: input.modifiers ?? 0,
        };
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          ...params,
        });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      } else if (input.type === "selectAll") {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
          commands: ["selectAll"],
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
      } else throw Error("Unsupported input");
    });
  };
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      const url = new URL(req.url ?? "/", "http://preview.invalid");
      const origin = req.headers.origin;
      if (
        origin &&
        ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(
          origin,
        )
      )
        return json(res, { error: "Origin rejected" }, 403);
      const bearer = String(
        req.headers["x-cua-preview-token"] ??
          req.headers.authorization?.replace(/^Bearer /, "") ??
          "",
      );
      const authenticated = same(bearer, token) || same(cookies(req), token);
      if (url.pathname === "/auth" && req.method === "POST") {
        if (!same(bearer, token))
          return json(res, { error: "Authentication required" }, 401);
        res.setHeader(
          "Set-Cookie",
          `cua_preview=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return json(res, { ok: true });
      }
      if (
        ["/", "/app.js", "/geometry.js", "/style.css"].includes(url.pathname) &&
        req.method === "GET"
      ) {
        const name =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.writeHead(200, {
          "Content-Type": name.endsWith("html")
            ? "text/html; charset=utf-8"
            : name.endsWith("js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        });
        return res.end(await readFile(new URL(name, assets)));
      }
      if (url.pathname === "/scenario.js" && req.method === "GET") {
        res.setHeader("Content-Type", "text/javascript");
        return res.end(
          options.scenarioScript ? await readFile(options.scenarioScript) : "",
        );
      }
      if (!authenticated)
        return json(res, { error: "Authentication required" }, 401);
      if (req.method === "GET" && url.pathname === "/api/state")
        return json(res, state());
      if (req.method === "GET" && url.pathname === "/api/frame") {
        const shot = await capture();
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "X-Frame-Id": shot.id,
          "X-Frame-Width": shot.width,
          "X-Frame-Height": shot.height,
        });
        return res.end(shot.data);
      }
      if (req.method !== "POST") return json(res, { error: "Not found" }, 404);
      const data = await body(req);
      if (url.pathname === "/api/control") {
        await releasePointer();
        if (data.action === "take") {
          scenario?.cancel();
          await service.interruptSession({ sessionId, takeControl: true });
          log("人工已取得控制权，模型已停止");
        } else if (data.action === "interrupt") {
          scenario?.cancel();
          await service.interruptSession({ sessionId });
          log("已中断，保持暂停");
        } else if (data.action === "resume") {
          await service.resumeSession({ sessionId });
          log("控制权已交还模型，等待下一次执行");
        } else return json(res, { error: "Unknown control action" }, 400);
        return json(res, state());
      }
      if (url.pathname === "/api/input") {
        await manualInput(data);
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/navigate") {
        const target = new URL(data.url);
        if (!["http:", "https:"].includes(target.protocol))
          throw Error("Only HTTP(S) navigation is supported");
        await service.runHumanAction(sessionId, () =>
          tab.page.goto(target.href, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          }),
        );
        return json(res, { ok: true });
      }
      if (scenario && url.pathname === "/api/scenario") {
        scenario.start();
        return json(res, state());
      }
      if (url.pathname === "/api/demo") {
        if (scenario?.active()) throw Error("Demo already running");
        const code = `var browser=await cua.connect();var tab=await browser.tabs.get(${JSON.stringify(tab.id)});await tab.goto(${JSON.stringify("data:text/html," + encodeURIComponent(fixture))});for(var i=1;i<=12;i++){output.json(await tab.ax.snapshot());await tab.getByRole('textbox',{name:'输入内容'}).fill('Agent step '+i);await tab.getByRole('button',{name:'提交',exact:true}).click();await new Promise(r=>setTimeout(r,1500));}`;
        const execution = await service.execute({ sessionId, code });
        lastExecution = { id: execution.executionId, status: execution.status };
        log("模型演示开始：12 次输入与提交，可随时中断");
        void observeResult(execution.executionId);
        return json(res, { executionId: execution.executionId });
      }
      return json(res, { error: "Not found" }, 404);
    })().catch((error) => {
      // Human text, navigation URLs and browser errors never enter logs or model messages.
      if (!res.headersSent)
        json(
          res,
          {
            error:
              error?.code === "SESSION_BUSY"
                ? "当前控制权不允许该操作，或浏览器动作仍在结束中；请稍后重试。"
                : "操作未完成，请刷新画面后重试。",
          },
          409,
        );
      else res.destroy();
    });
  });
  server.requestTimeout = 20000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 30150, options.host ?? "127.0.0.1", resolve);
  }).catch(async (error) => {
    await cdp.detach();
    await service.close();
    throw error;
  });
  log("浏览器已连接，实时画面仅发送到人工 preview");
  return {
    server,
    service,
    sessionId,
    token,
    state,
    async close() {
      if (closed) return;
      closed = true;
      scenario?.cancel();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await releasePointer();
      await cdp.detach().catch(() => {});
      await service.close();
    },
  };
}
