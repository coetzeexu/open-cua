# Harness 接入 CUA

本文面向使用方：**CUA 安装在沙箱内，harness 通过标准 MCP + MCP Apps 接入**。CUA 操作浏览器；harness 负责模型循环、用户界面和任务调度。

```text
用户 ↔ harness 界面（MCP Apps）↔ harness 后端（模型循环）
                                      ↕ HTTPS / MCP
                              沙箱内 CUA ↔ 沙箱浏览器
```

已确认的首版边界：账号密码登录可自动继续；通用安全表单只填字段，之后人工检查；只支持有效会话内恢复，不承诺服务重启后续跑或关闭卡片后自动唤醒。

## 1. 双方需要实现的部分

| 部分     | CUA 提供方                                                       | 使用方                                                                              |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 部署     | Windows / Linux x64 完整运行包，内含 Node、生产依赖与启动器      | 创建沙箱、初始化浏览器、上传解压、保持 CUA 进程运行、HTTPS 端口转发、续期与删除沙箱 |
| 执行     | MCP 工具、持续 JavaScript 会话、浏览器操作、轮询、取消与资源清理 | MCP 客户端、模型 API 适配、工具调用循环、run 与会话关联                             |
| 界面     | 浏览器面板、登录卡片、安全表单的 HTML 资源及桥接示例             | 隔离 iframe、AppBridge、私密后端路由、用户与任务鉴权                                |
| 继续任务 | 不含填写值的服务端回执                                           | 接收 `ui/message`，去重并排入原 run；模型忙时排队                                   |
| 恢复     | 有效会话内查询、执行请求去重                                     | 保存必要 ID；断线后查询原执行；状态不确定时不重放                                   |

示例不是完整 harness：使用方仍需实现模型调用、iframe 容器和任务队列。部署 Bearer 只留在后端；私密工具参数、结果 `_meta` 不进入模型上下文、聊天记录或普通日志。

当前用于可信 harness 和受控代码，尚无 OS 级恶意代码隔离，详见[架构与信任边界](architecture.md)。

## 2. 获取运行包


由 CUA 提供方在开发机执行，需要 Bun 1.3.12、Node 24.18.x 和仓库访问权限：

```sh
git clone https://github.com/coetzeexu/open-cua.git
cd open-cua
bun install --frozen-lockfile

# 按目标系统选择一个；命令会先构建源码
bun run package:linux
# bun run package:windows
```

| 目标        | 完整包                                        |
| ----------- | --------------------------------------------- |
| Linux x64   | `artifacts/sandbox/cua-sandbox-linux-x64.tgz` |
| Windows x64 | `artifacts/sandbox/cua-sandbox-win32-x64.tgz` |

完整包内含 Node 24.18.0，沙箱不需要 Bun 或另装依赖。不要使用需要额外安装依赖的精简包 `cua-sandbox.tgz`。交付页提供下载链接、包大小和打包时间，便于选择和使用对应运行包。



## 3. 沙箱安装与启动

### 先准备四项配置

使用方通过自己的沙箱平台完成以下步骤；这些是平台部署动作，不是 CUA 工具调用：

1. 创建 Windows / Linux x64 沙箱，初始化其中的 Chromium 浏览器。
2. 将完整包上传到 Linux `/tmp/` 或 Windows `C:\Temp\`。
3. 为内部端口 `30151` 配置 HTTPS 转发，取得外部 MCP URL。例如 `https://cua.example.com:8002/mcp`，对应允许的 Host 为 `cua.example.com:8002`；默认 HTTPS 443 可省略端口。带路径或查询路由的代理需要按实际转发规则配置。
4. 通过私密配置向 CUA 和 harness 后端注入同一个 `CUA_MCP_TOKEN`，至少 32 个无空白字符；推荐用密码管理器生成 64 位随机 hex。harness 后端同时设置 `CUA_MCP_URL` 为上一步地址。

下面启动命令只需替换 `CUA_MCP_ALLOWED_HOSTS`；令牌由上一步注入。不要把令牌写进源码、URL 或模型消息。

### Linux（Bash）

以有权创建 `/opt/cua` 的用户运行：

```bash
set -e
: "${CUA_MCP_TOKEN:?请先通过部署环境注入 CUA_MCP_TOKEN}"
mkdir -p /opt/cua
tar -xzf /tmp/cua-sandbox-linux-x64.tgz -C /opt/cua

export CUA_MCP_HOST=0.0.0.0
export CUA_MCP_PORT=30151
export CUA_MCP_APPS=1
export CUA_MCP_ALLOWED_HOSTS='替换为实际转发域名:外部非默认端口'
/opt/cua/runtime/node /opt/cua/deploy/sandbox/http.mjs
```

### Windows（PowerShell）

```powershell
$ErrorActionPreference = 'Stop'
if (-not $env:CUA_MCP_TOKEN) { throw '请先通过部署环境注入 CUA_MCP_TOKEN' }
New-Item -ItemType Directory -Force C:\cua | Out-Null
tar -xzf C:\Temp\cua-sandbox-win32-x64.tgz -C C:\cua
if ($LASTEXITCODE -ne 0) { throw '运行包解压失败' }

$env:CUA_MCP_HOST = '0.0.0.0'
$env:CUA_MCP_PORT = '30151'
$env:CUA_MCP_APPS = '1'
$env:CUA_MCP_ALLOWED_HOSTS = '替换为实际转发域名:外部非默认端口'
C:\cua\runtime\node.exe C:\cua\deploy\sandbox\http.mjs
```

看到 `CUA HTTP MCP ready at /mcp (Bearer required).` 后，继续下一节握手检查。上述命令前台运行；正式部署由使用方进程管理器以相同环境和命令托管，不能在一次性远程命令结束时杀掉进程。

启动器自动发现 AgentBay 浏览器的内部 CDP 端口，默认匹配 profile `/tmp/agentbay_browser`（当前 Windows 镜像也使用该参数）。其他镜像可设置 `CUA_BROWSER_PROFILE`，或由部署层注入实际 loopback 地址 `CUA_BROWSER_CDP_URL`，例如 `http://127.0.0.1:实际端口`；不要猜端口。`CUA_CONFIG` 可指定配置文件，默认使用包内 `examples/cua.sandbox.json`，profile 名为 `sandbox`。

CUA 不创建或续期这个沙箱，也不需要 AgentBay API key；浏览器初始化和端口转发需要的云端凭据留在使用方部署层。浏览器首次在 `cua.connect()` 时连接，服务 ready 不等于浏览器验收通过。

沙箱浏览器断开后，操作返回 `BROWSER_DISCONNECTED`。再次调用 `cua.connect()` 会清除失效连接，并在同一 MCP 会话内重新连接配置的 CDP 地址；等待预算由 `sandbox.connectTimeoutMs` 控制（默认 30 秒），浏览器仍未启动时返回 `CONNECT_FAILED`，之后可以再次连接。CUA 不负责启动 Chrome，也不会创建或删除沙箱。浏览器退出后的拉起由部署层进程管理器负责。

恢复成功后必须用新返回的 browser 获取标签页：先检查 `browser.userTabs.list()`，确认目标后 `browser.userTabs.claim(info)`；attach 模式下已有标签页需要重新认领。旧 browser、tab、快照和截图坐标全部失效。不要自动重放断连前的点击、输入或提交，先重新观察页面再决定后续操作。连接恢复不会解除私密表单保护。其他 provider 只有显式实现 `reconnect` 才启用此机制，避免意外创建云资源。

## 4. harness 接入与连通检查

### 后端 MCP 客户端

在使用方 harness 工程安装依赖，复制交付版本的 [harness-client.mjs](../examples/harness-client.mjs) 和 [harness-app-bridge.mjs](../examples/harness-app-bridge.mjs)：

```sh
npm install @modelcontextprotocol/sdk@1.32.1 @modelcontextprotocol/ext-apps@1.1.2
```

后端用 `connectCUA({url, token, apps: true})` 建立连接；它会声明 MCP Apps 能力，并过滤模型可见工具和结果。注意 `connectCUA` 的可选 `sessionId` 是 **MCP 协议会话 ID**，不是工具返回的 CUA `sessionId`。

以下命令在已安装依赖的源码工程根目录执行（Bash + Node 24.18.x）。环境中先设置 `CUA_MCP_URL` 和 `CUA_MCP_TOKEN`；它验证远端握手、Apps 资源和 REPL，**不会连接或打开浏览器**：

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectCUA } from './examples/harness-client.mjs';
const cua = await connectCUA({
  url: process.env.CUA_MCP_URL,
  token: process.env.CUA_MCP_TOKEN,
  apps: true,
});
async function call(name, args) {
  const result = await cua.callModelTool(name, args);
  assert.ok(!result.isError, `${name} failed`);
  return result.structuredContent;
}
try {
  const names = new Set(cua.tools.map(t => t.name));
  for (const name of ['cua_exec', 'cua_view', 'cua_login', 'cua_secure_form'])
    assert.ok(names.has(name), `${name} missing; check package and Apps settings`);
  for (const uri of ['ui://cua/browser.html', 'ui://cua/login.html', 'ui://cua/secure-form.html']) {
    const resource = await cua.client.readResource({ uri });
    assert.ok(resource.contents.some(c => c.mimeType === 'text/html;profile=mcp-app'));
  }
  const { sessionId } = await call('cua_session_create', { profile: 'sandbox' });
  let r = await call('cua_exec', {
    sessionId, requestId: randomUUID(), code: 'output.text("CUA ready");',
  });
  const output = [...r.output];
  while (r.status === 'running') {
    r = await call('cua_poll', {
      sessionId, executionId: r.executionId, cursor: r.cursor, waitMs: 1000,
    });
    output.push(...r.output);
  }
  assert.equal(r.status, 'succeeded');
  assert.ok(output.some(item => item.text === 'CUA ready'));
  await call('cua_close', { sessionId });
  console.log('MCP + Apps resources + REPL OK');
} finally {
  await cua.close();
}
JS
```

该检查要求包含安全表单的新包；旧包缺少 `cua_secure_form` 时应更新包，不是调整工具名。此独立检查可以在 `finally` 中清理；正式 run 等待用户时不能关闭连接。

### 前端 MCP Apps

服务端启用 `CUA_MCP_APPS=1`，客户端启用 `apps: true` 只是能力协商；使用方还必须实现资源加载和界面桥接：

| 工具                                      | 通过 MCP `resources/read` 加载的资源 | 桥接函数 / 客户端回调                    |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `cua_view({sessionId, tabId})`            | `ui://cua/browser.html`              | `attachCUAPanel` / `openPanel`           |
| `cua_login({sessionId, requestId})`       | `ui://cua/login.html`                | `attachCUALogin` / `openLogin`           |
| `cua_secure_form({sessionId, requestId})` | `ui://cua/secure-form.html`          | `attachCUASecureForm` / `openSecureForm` |

使用方实现四件事：

1. 在隔离 iframe 中加载资源，用 AppBridge transport 连接，将原始工具结果交给对应卡片。`ui://` 是 MCP 资源标识，不能直接当成 iframe 的网页 URL。
2. 调用 `cua.callModelTool(name, args, {openPanel, openLogin, openSecureForm})`，让上述回调挂载界面；回调由使用方实现，单纯设置 `apps: true` 不会显示卡片。
3. 实现 `callPrivateTool(name, args)`：走用户已鉴权的后端，校验所属 run/MCP 连接。沿用桥接示例的工具白名单与绑定授权，不允许 iframe 任意切换 session、请求或 token。私密调用不经过模型循环，不记录填写值。
4. 实现 `enqueueUserMessage(message, {idempotencyKey})`：只接收桥接层核验的服务端回执，按键去重后排回原 run。重复通知或 iframe 重载不能启动两个后续回合；示例只有内存去重，宿主需维护自己的去重状态。

模型只接收 model 可见工具及过滤后的 `content`、`structuredContent`、`isError`；不要把原始 `_meta` 或 app-only 工具结果传给模型。部署 Bearer 不交给 iframe。隔离与 CSP 按 MCP Apps 的 AppBridge 要求配置，示例不提供完整 iframe 容器。

## 5. 一次完整 run

一个 run 从用户提交任务开始，到完成、失败或用户终止结束；等待填写、人工接管不是结束。

| 顺序          | 使用方 harness 的动作                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| 1. 开始       | 建立 `runId`，连接 MCP，调用 `cua_session_create({profile:"sandbox"})` 并保存 CUA `sessionId` |
| 2. 模型决策   | 把用户目标、`cua.tools` 和会话 ID 交给模型；按模型供应商格式转换工具定义                      |
| 3. 执行       | 转发模型工具调用；为每次新 `cua_exec` 分配 `requestId`，同一请求重试使用原 ID、原代码         |
| 4. 轮询       | 返回 `running` 时，用 `executionId + cursor` 调 `cua_poll`；汇集新增输出并处理 warnings       |
| 5. 继续或等待 | 结果交回模型；发现 `USER_ACTION_REQUIRED` 时及时打开对应卡片，不能只等执行结束才处理          |
| 6. 用户完成   | 收到可信回执或明确交还后，恢复原 run，查询原执行及当前状态，继续剩余任务                      |
| 7. 收尾       | 输出业务结果；`cua_close` 关闭 CUA 会话，`cua.close()` 结束该 MCP 连接；部署层按策略删除沙箱  |

首次浏览器操作通过 `cua_exec({sessionId, requestId, code})` 发送以下代码：

```javascript
var browser = await cua.connect();
var tab = await browser.tabs.create({ url: "https://example.com" });
output.text(tab.id);
output.json(await tab.ax.snapshot());
```

后续调用复用同一个会话和变量。根据实际观察定位字段，再操作并观察结果。`cua_exec` 本身执行成功不等于登录、下单等网站业务成功。

### 三类等待分支

| 场景                   | 完整处理链路                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号密码               | 模型通过 `tab.auth.request` 绑定真实字段和登录动作 → warnings 给出请求 ID → `cua_login` → 用户私密提交 → 服务端回执经 `ui/message` 唤醒原 run → poll 原执行、观察确认登录结果 → 继续任务                   |
| 个人资料               | 模型通过 `tab.secureForm.request` 绑定字段，`delivery:{mode:"fill"}` → `cua_secure_form` → 用户私密提交 → 查询原执行与 `tab.secureForm.status(requestId)` → 按 `nextAction: human_review` 打开面板人工检查 |
| 验证码、滑块、复杂控件 | 说明原因并打开 `cua_view` → 用户取得控制权，停止模型派发 → 用户操作并明确交还 → 重建 SDK 句柄、观察允许读取的状态 → 继续剩余任务                                                                           |

登录卡片只接受含密码且不含 OTP 的请求；字段和提交目标需满足同 frame、原生表单同源 POST 等校验。验证码与无法核验的页面走人工接管，不在聊天中索要秘密值。

通用表单当前支持 1–20 项原生 text/email/tel/password/date/单选；不支持自动填入后点击、复杂组件或文件上传。`accepted` 只是接受输入，`filled` 只是确认字段写入，`partial_or_unknown` 必须检查且不能重放。保护跨导航、reset 保留，交还模型也不能解除；模型只能处理无值状态，不能读取受保护网页原始内容或继续普通页面动作。

人工接管会取消当前执行，交还会重建 REPL，旧变量失效；先 `cua.connect()` 并通过 `browser.tabs.list()` 重新获取句柄。普通登录/人工输入的原文档观察也有脱敏限制；不能把它当作通用表单跨页面保护的替代。

## 6. 状态、重试与停止约定

| 标识                                        | 保存用途                                                 |
| ------------------------------------------- | -------------------------------------------------------- |
| 使用方 `runId`                              | 原始业务任务、用户与消息队列                             |
| MCP session ID（`cua.transport.sessionId`） | 恢复仍有效的协议连接                                     |
| CUA `sessionId`                             | 工具调用所属浏览器执行会话                               |
| 执行 `requestId`                            | 同一次执行的幂等键；新操作换 ID，重试保留 ID 和代码      |
| `executionId`、`cursor`                     | 查询原执行、读取增量输出                                 |
| 登录/表单 `requestId`                       | warnings 中的用户请求 ID；与执行幂等键含义不同，不可混用 |

- **状态处理**：`running` 继续 poll；终态按 `status`、`aggregateOutcome` 和 `error.nextAction` 处理。失败不等于没有动作生效，`unknown` 先查状态或人工检查，不能自动重放。
- **停止**：`cua_cancel` 只取消当前执行，harness 同时停止后续派发；面板“中断/取得控制权”会暂停会话。关闭面板或断线不会自动交还。
- **重置**：`cua_reset` 重建 REPL，页面保留，变量失效。重置不解除通用表单保护。
- **有效会话恢复**：断线保留上述 ID，用原 MCP session ID 重连并 poll；服务重启或旧 session 返回 404 时需新建会话，不自动重放业务动作。示例见 [check-http.mjs](../deploy/sandbox/check-http.mjs)。
- **人工等待**：保持 run 和连接存活，状态查询采用有界退避。HTTP 连接默认 15 分钟无活动即回收，挂着 SSE 不算保活；面板授权、表单请求另有期限，按服务返回处理。有效请求可重新打开卡片，面板授权过期可重新调用 `cua_view`。
- **通知失败**：提示用户继续检查或重开卡片，不重复发送凭据。首版不保证关闭卡片后后台唤醒，不恢复输入草稿，也不提供跨服务进程的操作恢复。

## 7. 联调与排障

先完成第 4 节的无浏览器检查，再在专用测试沙箱运行真实浏览器验收。下列命令在开发机源码工程根目录执行，需 Node 24.18.x、已安装依赖和同一组 `CUA_MCP_URL` / `CUA_MCP_TOKEN`：

```sh
CUA_HTTP_SMOKE=1 node deploy/sandbox/check-http.mjs
```

它会创建测试页面、操作浏览器，覆盖鉴权、观察、填写点击、重连去重、取消、reset 和 DELETE，报告写入 `artifacts/http-verified/report.json`；不调用模型，也不验证 Apps UI。它刻意不声明 Apps 能力，断言基础七个工具是正常的。

随后使用方在实际 harness 中完成：面板显示 → 接管/交还 → 私密登录自动继续 → 安全表单填写后人工检查 → 结束清理。用合成资料验证私密值不进入模型和日志；模拟桥接通过不能代替实际宿主验收。

| 现象                                  | 处理                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `401` / `403 Host not allowed`        | 核对两端令牌，以及代理实际传递的 Host/非默认端口                                  |
| 未 ready / `502`                      | 检查浏览器已初始化、CDP profile、服务进程和端口转发                               |
| 缺少 `cua_view` / 卡片工具            | 检查服务 `CUA_MCP_APPS=1`、客户端 Apps 协商和交付包版本                           |
| 有工具结果、无卡片                    | 检查资源读取、iframe、桥接回调和原始结果的私密传递                                |
| 提交后未继续                          | 检查 `ui/message` 支持、`enqueueUserMessage` 和队列去重；查询原请求，不重新提交值 |
| 人工接管后 `SESSION_BUSY`             | 等用户明确交还，不新建会话绕过人工控制                                            |
| 服务重启后 `404`                      | 新建 MCP/CUA 会话；旧执行不能跨进程恢复                                           |
| `CREDENTIAL_PROTECTED` / 安全表单保护 | 按保护规则转人工检查；不绕过读取，不用 reset 解除                                 |

HTTP 网关内部使用 HTTP，对外使用 HTTPS；通常由 harness 后端连接，不让 iframe 直连网关。多个 MCP 连接的会话归属相互隔离，不代表同一浏览器支持并发写入。开发 Preview 不在交付包内，不能替代当前会话的 MCP Apps。

## 附：Codex 与其他连接方式

### Codex 连接沙箱

完成沙箱部署后，在本机 `~/.codex/config.toml` 合并配置，替换实际 URL：

```toml
[mcp_servers.cua_sandbox]
url = "https://实际转发域名:外部非默认端口/mcp"
bearer_token_env_var = "CUA_MCP_TOKEN"
startup_timeout_sec = 60
tool_timeout_sec = 45
```

启动 Codex 的环境需继承同一令牌。重开 Codex 后用 `codex mcp list` 检查注册，再要求模型创建 `sandbox` 会话、打开测试页面并调用 `cua_view`。UI 展示和自动继续依赖宿主实际支持的 MCP Apps 能力。

### harness 同在沙箱内

可使用 stdio MCP，子进程命令为 `/opt/cua/runtime/node /opt/cua/deploy/sandbox/start.mjs`；Windows 使用 `C:\cua\runtime\node.exe C:\cua\deploy\sandbox\start.mjs`。注入 `CUA_MCP_APPS=1` 并保留持续双向 stdin/stdout；一次性远程命令接口不能代替 MCP 连接。此方式无需 HTTP 转发与 Bearer，界面和 run 的处理仍遵循上文。

### 本机 CUA

本机浏览器用 [cua.local.json](../examples/cua.local.json) 和 [Codex 配置](../examples/codex.config.toml)，构建后运行 `node packages/cli/dist/index.js serve --config examples/cua.local.json`。默认创建独立浏览器，不接管日常 Chrome。

本机 CUA 连接既有 AgentBay 浏览器，使用 [cua.agentbay.attach.json](../examples/cua.agentbay.attach.json)，填写云 sessionId 并注入 `AGENTBAY_API_KEY`，启动命令改用该配置。云浏览器需已初始化；attach 不续期或删除外部沙箱。已有标签页需先列出并通过 `browser.userTabs.claim(info)` 显式认领。
