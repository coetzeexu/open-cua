# Open CUA v0.7 最终工程计划

更新：2026-10-21。本文是本轮工程的范围、交付和验收基准，已合并后续加入的沙箱部署、HTTP MCP、人工输入与 MCP Apps。包版本仍为 0.7.0；早期的“v0.8 优化”不是另一个已发布版本。

## 目标与范围

让 Codex 和其他 Agent Harness 通过持续的 JavaScript 会话操作浏览器。CUA 负责浏览器执行、状态和人工控制，模型决策循环由 harness 提供。工程重点是目标身份准确、取消后不再派发新动作、错误可判断是否生效、资源按归属回收。

| 交付            | 当前实现                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SDK             | 可替换的浏览器、AX、DOM、截图、动作、目标解析和策略 provider                                                                   |
| Service 与 REPL | 每会话独立 Node worker；跨调用变量、执行监管、取消、去重、输出与资源恢复                                                       |
| 浏览器          | 本机 Chromium create/attach；AgentBay create/attach；沙箱内 loopback CDP attach                                                |
| MCP             | stdio 与有状态 Streamable HTTP；七个基础工具；协商 Apps 后增加 `cua_view`、`cua_login`、`cua_secure_form` 和十个 app-only 工具 |
| 人工介入        | 私密输入、手动接管、中断、交还、凭据文档观察保护；MCP Apps 与终端通道                                                          |
| 平台与交付      | Windows x64、Ubuntu/Linux x64 完整运行包，自带 Node 和生产依赖；目标机无需 Bun                                                 |
| 开发工具        | 独立 Preview 和固定 mock 演示，只供开发，不进入运行包                                                                          |

技术栈：TypeScript、ESM、Bun 1.3.12 workspace；Node 24.18.0 执行 Service 和 VM modules REPL。十二个开发 workspace，十个交付运行包。具体结构与取舍见 [架构与决策](architecture.md)，实际部署见 [Agent Harness 接入 CUA文档](harness-integration.md)。

不包含：模型供应商 API 或自动规划循环、模型系统桌面操作和文件选择器、自动验证码求解、多租户账户平台、操作系统级代码沙箱、网络防火墙、跨进程持久化任务恢复。尚未发布 npm 包；使用源码工程或构建后的运行包。

## 实施收口

| 阶段             | 交付内容                                                                            | 状态                                                               |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 契约和核心       | 错误表、目标身份、调度、scope 取消、AX 基线、站点策略                               | 已实现                                                             |
| 默认浏览器       | 本机和 AgentBay provider、iframe、弹窗、对话框、资源 journal                        | 已实现                                                             |
| REPL 与接口      | 变量语义、worker 监管、Service、stdio MCP、CLI                                      | 已实现                                                             |
| 人工输入         | auth/handoff、终端确认、敏感字段写入限制和观察保护                                  | 已实现                                                             |
| 沙箱内运行       | sandbox provider、浏览器发现、Windows CLI、两端完整运行包                           | 已实现                                                             |
| 远端接入         | HTTP MCP 鉴权、连接恢复、请求去重、会话归属                                         | 已实现                                                             |
| MCP Apps         | 内嵌画面、接管、拖动、中断、交还及私密表单                                          | 已实现；真实宿主验收范围见下表                                     |
| 通用安全表单     | text/email/tel/password/date/原生单选、私密填写、无值状态、跨导航保护与资源保护标记 | 第一阶段已实现；仅 fill，后续人工核验，验收见下文                  |
| AX 修复          | 普通人工输入及文字子节点脱敏，动态字段类型重新判断                                  | 已修复；本机 Chrome 回归通过，Windows 原生面板普通输入脱敏复验通过 |
| sandbox 断连恢复 | 同一会话内再次 connect 重连原 CDP，失效旧句柄、不重放动作                           | 已实现；模拟故障通过，真实 Chrome 退出后现场恢复待验收             |

## 验收基准

1. **目标身份**：旧 ref 不匹配克隆替换的新节点；导航、frame 更换、reset 后拒绝旧句柄；坐标必须关联有效截图和视口版本。
2. **终止**：先关闭 scope，再取消队列与停止 worker；catch/finally、迟到定时器不能继续派发动作；在途动作未结束时不交出 tab 锁。`unknown` 先观察，不自动重放。
3. **REPL**：失败 cell 的已初始化变量按规则保留；无法安全结束时重建 worker，浏览器保留；requestId 去重；失败或截断的 AX 输出不推进默认基线。
4. **人工介入**：接管／中断后新模型执行被拒绝；交还后重新绑定句柄；输入和 panel token 不进入正常模型工具结果。AX 对受保护文档的编辑值及子节点脱敏，reset、hash 和 pushState 不解除保护。这是 SDK 调用路径的约束，不是对同权限 Node worker 的安全隔离。
5. **资源**：create 负责清理，attach 不删除外部资源；journal 恢复可重入且不回收活跃实例；MCP DELETE 清理所属 CUA 会话。
6. **部署**：目标机不依赖 Bun；HTTP 精确校验 Host、Origin 与 Bearer；Windows 和 Ubuntu 分别验证，不把镜像/profile 的兼容性当作自动保证。

## 已有验证证据与限制

下面是截至本次整理的证据，不代表每次修改都重跑全部环境，也不把固定 mock 等同于真实业务模型任务。

| 范围                          | 结果与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 历史真实浏览器（本批未重跑）  | 2026-10-21 全部 `tests/chrome/*.test.ts` 18 项通过（其中通用安全表单 7 项），使用专用无头 Chrome；覆盖 hash/pushState 后凭证保护、真实 iframe 外部 handoff 交还、普通输入/textarea/contenteditable/Shadow DOM 脱敏、动态 password 类型、完整/增量快照、reset 与新文档导航，以及现有取消/策略/MCP/拖动回归                                                                                                                                                                                                                           |
| Windows 与 Ubuntu 沙箱        | 既有完整包已分别通过 CLI 交互终端、stdio MCP mock、页面归属与退出清理；后续 HTTP MCP mock 两端通过鉴权、页面操作、重连去重、取消、reset、DELETE                                                                                                                                                                                                                                                                                                                                                                                     |
| Codex 原生 MCP Apps + Windows | 原生工具和 `cua_view` 接入成功；用户完成预览与接管操作；慢速循环在 8 次后取消，交还后读到滑块 100%／释放 1 次，再点击计数从 8 到 9                                                                                                                                                                                                                                                                                                                                                                                                  |
| 面板延迟回归                  | 本地 mock 验证截图阻塞时中断/接管仍可用、截图超时与迟到结果处理；打包 UI 验证延迟拖动的最终位置及失败后释放。两项新修复已随 `c047ae4` 包于 2026-10-16 部署到新 Windows 沙箱，用户已完成原生拖动至 100%／释放 1 次；人为注入延迟或截图卡住的原生场景仍未实测                                                                                                                                                                                                                                                                         |
| 原生中断按钮                  | 2026-10-16 原生面板人工操作后，慢速循环完成 9 次点击即返回 cancelled / EXECUTION_CANCELLED，迟到动作被 SCOPE_CLOSED 拒绝；随后无页面动作的新执行返回 SESSION_BUSY。用户随后交还，模型重新绑定原标签页并成功点击，计数 10→11；普通输入值与子节点继续脱敏。中断→拒绝新执行→人工交还→恢复闭环通过                                                                                                                                                                                                                                      |
| Windows AX 修复版             | 2026-10-16 已部署 `c047ae4` 新包，远端 SHA256、监听进程路径、HTTPS MCP 与 Win32 测试页检查通过。重启 Codex 后用户在原生面板接管、输入并交还：普通输入框 sensitive=true、value=[redacted]，3 个子节点文字均保护；增量快照无编辑节点变化，合并后仍脱敏。滑块 100%／释放 1 次，模型点击后计数 0→1。输入原文未输出或记录；此项不等同于远端 textarea/contenteditable 全覆盖                                                                                                                                                              |
| 独立登录卡片 + 本机 Codex     | 2026-10-19 用户在原生会话卡片提交测试凭据后，`ui/message` 自动唤醒下一轮，模型 poll 原执行、确认登录并读取 3 笔待发货订单，总计 458 元；测试密码预先用于演示，不能据此证明模型此前不知道密码                                                                                                                                                                                                                                                                                                                                        |
| 通用安全表单 + 本机 Codex     | 2026-10-21 用户在原生卡片私密填写七字段，固定 `ui/message` 自动继续原任务；原执行返回 `filled`、7 项 confirmed、0 项 uncertain，站点记录 7 次字段事件且自动提交次数为 0。用户在原生浏览器面板接管、人工提交并交还后，站点确认提交 1 次，字段事件仍为 7 次；AX/DOM/截图/evaluate 均在派发前被 `SECURE_FORM_PROTECTED` 拒绝，REPL reset 后重新绑定句柄仍保持保护和无值状态查询。模型未读取填写值；站点仅保留固定字段 ID 和计数。此结果不覆盖 AgentBay、关闭卡片后续接或跨 Service 操作恢复                                            |
| AgentBay Linux 登录链路       | 2026-10-19 本机 stdio CUA → AgentBay API attach、沙箱内 CUA → HTTPS MCP 两条路径完整通过：真实云浏览器、独立卡片私密提交、随机密码服务器校验、原文档 AX 脱敏/evaluate 拒绝、自动继续读订单、截图与接管/交还。卡片运行于模拟 AppBridge 宿主，继续消息触发测试回调；不等同于云端 Codex 原生卡片人工验收                                                                                                                                                                                                                               |
| AgentBay Linux 通用安全表单   | 2026-10-21 本机 stdio → AgentBay attach、沙箱内 HTTPS MCP 两条链路均通过。真实云 Chromium + 打包后的安全表单 App + 模拟 AppBridge 宿主；七字段资料运行时随机生成（国家选择固定候选项），独立站点以预置哈希逐字段核验，7 次字段事件且自动提交为 0。验证自动通知原执行一次、私密 UI 清空、重复提交不重放、重开卡片恢复无值状态并撤销旧 token；模拟人工通道接管/提交/交还后确认 1 次，包含资料回显的新页面及 reset 后 AX/DOM/截图/evaluate 仍在派发前阻断。专用沙箱已删除，唯一标签审计剩余 0。此项不等同于云端 Codex 原生卡片人工验收 |
| sandbox 断连恢复              | 8 个专项测试覆盖连接恢复、旧句柄失效、失败后重试、并发、opt-in 边界、保护保留、派发后不重放、worker generation 与 CDP 断连错误。模拟故障通过；部署后未关闭真实 Chrome 做现场故障注入                                                                                                                                                                                                                                                                                                                                                |
| 长时与业务场景                | 真实业务账号/手机验证码、完整 1688 业务流程、其他镜像及云 API attach 全场景、长时保活与崩溃云回收未形成完整实测结论                                                                                                                                                                                                                                                                                                                                                                                                                 |

原始验收报告位于本机忽略的 `artifacts/parity/`、`artifacts/http-gateway/`、`artifacts/http-linux/`、`artifacts/codex-apps-poc/`、`artifacts/login-agentbay/`、`artifacts/secure-form-native/`、`artifacts/secure-form-agentbay/`，不随仓库交付。云镜像历史验证为 Windows `windows_latest` 与 Ubuntu `imgc-0ab5tdslhgux1tf3g`；使用方需有镜像权限，并核对实际浏览器 profile。

### AgentBay 登录专项的环境约束（2026-10-19）

- SDK 0.22.0 的 `get()` 创建新 Browser 对象，其本地初始化标志为 false。attach 改为调用 SDK 的 GetCdpLink API 获取已运行浏览器端点，避免为取得端点重新初始化浏览器；回归验证不初始化、不续期、不删除外部资源。
- 本次 Linux 镜像的 Chrome 启动参数包含 `--proxy-bypass-list=<-loopback>`，浏览器访问沙箱内 localhost 验收页得到代理 503。测试服务改走 AgentBay HTTPS 端口转发；这不意味着所有镜像都采用相同网络配置。
- 测试密码由可信测试进程运行时随机生成，服务器仅保存哈希；模拟模型的调用代码、工具结果和继续消息均检查不含该密码。服务器成功校验后才记为登录通过，卡片提交回执本身不作为成功证据。
- 本次专用沙箱已删除；按唯一测试标签查询确认剩余资源为 0。
- 新增 `scripts/check-agentbay-login.mjs` 作为显式云端验收入口。它依赖已初始化的专用 Linux 沙箱、Node/Python3 和测试端口 31987，清理自己创建的测试服务和 CUA 会话；沙箱的创建、保活与删除由调用方负责。

## 整体 review 收口（2026-10-16）

| 意见                              | 处理与验证                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0：同文档跳转解除凭证保护        | 文档 epoch 与观察引用 epoch 分开，CDP loaderId 变化才表示新文档；真实 Chrome 验证 hash/pushState 后 evaluate、DOM、截图仍受限，AX 不含测试密文                                             |
| P1-1：外部 handoff 交还漏保护     | 恢复、取消、过期均先记录所有当前 frame 的文档身份再开放操作；默认回归覆盖三种状态，真实 Chrome 覆盖同进程 iframe 与同文档跳转；补齐 iframe 共享父目标 CDP session 的处理                   |
| P1-2：私密输入目标误导            | password/OTP 要求敏感目标；字段和提交目标同 frame；原生表单限同源 POST，检查按钮覆盖属性；收集前、输入及提交前重查。默认与 Chrome 回归覆盖错误目标、GET、跨源、跨 frame 和等待期间表单变化 |
| P1-3：同权限 worker 绕过人工批准  | 采用 C 方案，在 README、接入文档和架构文档明确降级为工作流约束。**同权限绕过未修复**；需要不同 OS 身份/容器及端点隔离才能建立更强保证                                                      |
| P1-4：HTTP 长轮询完成后被提前回收 | 非 GET 请求完成时刷新 lastSeen，保证响应结束后有完整闲置宽限期；增加耗时超过闲置期限的轮询回归，GET SSE 不延长闲置寿命；HTTP 测试文件连续 4 轮通过                                         |

本轮日志保存在本机忽略的 `artifacts/wrapup-review/`。截至 2026-10-16，以上安全修复尚未部署到 Windows/Ubuntu 沙箱；2026-10-19 Linux 登录专项的范围见上表。前述 Windows 原生人工验收对应 `c047ae4` 包，不能作为本轮新代码的云端验收证据。

## 通用安全表单安全审查（2026-10-21）

当前交付为 `fill`：用户私密填写后返回无值回执，下一步为人工检查。不是网站业务成功，也不提供自动提交或通用业务续跑。详细范围见[安全表单设计](secure-forms-design.md)。

- 输入与授权：schema 固定、请求级 token、同源同 frame、原生 POST 表单、原节点身份和绑定指纹；接收前启用保护及资源标记。重复提交返回既有状态，部分写入或未知结果不重放。
- 输出与恢复：Service 过滤原始输出、缓存和诊断；导航、reset 和 worker 重启不解除保护。同资源重建依赖稳定 resourceKey 与持久目录，资源标记不是操作日志。
- 真实 Chrome 发现并修复：私密写入 evaluator 使用字符串导致 Playwright 未调用函数，改为静态源码编译的函数；原子检查补充禁用 fieldset；已脱离 DOM 的目标返回失效描述，避免误归类为一般失败。
- 原生宿主验收首次空白页面的 AX 读取超时，原标签页进入 quarantined；在尚未收集资料时关闭该页并新建测试页后完成上述闭环。未向不确定操作重放任何私密输入；此项不证明首次加载超时已根治。
- 新增真实浏览器回归：七字段填写、精确 select 值、焦点隔离、重复提交、节点替换/重绑定、自动填充冲突、选项变化、事件中替换后续节点、跨文档保护、禁用 fieldset。
- 仍保留的限制：同权限 worker 不是安全隔离；持久操作日志、outbox、跨 MCP 归属恢复、可信站点受限观察及通用 CLI 私密输入未实现。原生宿主人工验收与云部署验收独立记录，不以模拟宿主代替。

## 后续收尾

- 通用安全表单默认检查和真实 Chrome 已通过；原生 Codex 已通过七字段私密填写、自动继续、人工检查提交与交还，以及跨页/reset 后持续保护。AgentBay Linux 通用安全表单的 stdio attach 与沙箱内 HTTP MCP 已通过真实浏览器/模拟宿主验收；云端原生卡片人工验收仍未覆盖。
- Linux 登录专项已覆盖私密输入与原文档保护；Windows 新版登录卡片、完整云端原生宿主人工流程尚待验收。
- `c047ae4` Windows 包的普通输入人工交还及 AX 完整/增量验收已通过；textarea/contenteditable 的覆盖目前来自本机 Chrome 回归。
- 原生面板的接管、普通输入脱敏、拖动、中断、拒绝新执行与交还恢复闭环已完成；延迟/卡住的故障注入仍只有本地 mock 证据。
- 只有新增需求需要时，再验证真实账号、不同镜像、云 attach 的更多场景和长时生命周期；不为这些未验证项承诺上线保证。

## 复现入口

```sh
bun install --frozen-lockfile
bun run check                 # 默认检查；不启动浏览器
bun run test:chrome           # 显式启动专用本机 Chrome
node examples/secure-form-scenario.mjs # 原生卡片人工验收页，仅 loopback，虚构数据
node scripts/check-agentbay-secure-form.mjs # 显式云表单验收；先配置专用会话及私密环境
bun run test:agentbay         # 显式使用真实云资源，需私密环境配置
bun run package:windows
bun run package:linux
```

登录专项使用私密环境中的 `AGENTBAY_API_KEY`、`AGENTBAY_SESSION_ID`，构建后运行 `node scripts/check-agentbay-login.mjs`。默认验证本机 stdio attach；同时提供 `CUA_MCP_URL`、`CUA_MCP_TOKEN` 则验证沙箱 HTTP MCP，需预先部署当前运行包并启用 `CUA_MCP_APPS=1`。可通过 `CUA_LOGIN_EVIDENCE` 指定不含凭据的结果文件。测试会临时转发只含合成数据的验收服务，不用于真实业务环境。

通用安全表单专项：`node scripts/check-agentbay-secure-form.mjs` 要求 `AGENTBAY_API_KEY`、已初始化的专用 Linux `AGENTBAY_SESSION_ID`，以及沙箱内 Node/Python3、空闲测试端口 31988 和 HTTPS 端口转发能力。默认验证本机 stdio attach；配置 `CUA_MCP_URL`、`CUA_MCP_TOKEN` 时验证沙箱内 HTTP MCP，运行包必须包含当前修复且启用 `CUA_MCP_APPS=1`。`CUA_SECURE_FORM_EVIDENCE` 指定无值报告文件，`CUA_SECURE_FORM_PORT` 可覆盖测试端口。

脚本只清理自身 CUA 会话、创建的页面和临时测试服务/文件；专用沙箱的创建、初始化、保活、删除与唯一标签审计由调用方负责。不可使用生产账号或共享业务会话。两条路径依次执行时先完整关闭前一条路径的测试页面；不能通过更换 resourceKey 绕过仍含资料的资源保护。每次验收使用新的专用环境，不删除保护标记来重试。

本轮使用镜像 `imgc-0ab5tdslhgux1tf3g`、平台默认生命周期与唯一 `cuaSession` 标签；从 `c554ae1` 的运行时代码重建 Linux x64 包，上传前后 SHA256 一致（完整值在本机报告中）。Node 24.18.0 下载经官方校验和验证。脚本验证的是填入/通知/保护及模拟人工通道，不推断真实业务保存成功，也不覆盖跨 Service 操作恢复、后台 outbox、其他镜像或 Windows。

`test:agentbay` 需要 `AGENTBAY_API_KEY`、`AGENTBAY_IMAGE_ID`；镜像不接受生命周期覆盖时，用 `AGENTBAY_LIFECYCLE_MODE=server-default`（云端期限由平台策略决定）。测试创建结果不确定时按唯一标签审计，不盲目重复创建。

沙箱内统一回归入口为 `CUA_SANDBOX_SMOKE=1` 配合 `deploy/sandbox/check-parity.mjs`；本机到沙箱的 HTTP 检查为 `CUA_HTTP_SMOKE=1` 配合 `deploy/sandbox/check-http.mjs`，由环境提供 `CUA_MCP_URL` 和 `CUA_MCP_TOKEN`。只在专用测试环境执行，结果应检查主报告和子报告。

## 历史保留方式

开发日志、早期方案、分轮 POC 和重复部署指南已合并到本计划、架构与接入文档，不再作为现行说明维护。完整历史未 squash 或重写，可查 `git log -- docs`；例如 `git show 118aaec:docs/poc-codex-mcp-apps-windows.md` 可恢复整理前的 POC 全文。临时会话 ID、包哈希和逐轮测试数字以对应历史版本为准。
