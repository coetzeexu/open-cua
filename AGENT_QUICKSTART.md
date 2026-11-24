# 给 Agent 的快速开始

把本文的地址交给 **dsh、Qoder、Codex 或其他 Agent**，附一句：

> 请按这份文档帮我配置 Open CUA。先确认我的宿主、浏览器环境和历史/脚本选项，再完成安装接入和就绪检查；保留已有配置。完成后我会直接给你浏览器任务。

本文是安装执行入口，不要求用户先读其他架构文档。Agent 应完成以下流程，不要只把命令交回用户。已有明确选择不重复询问；缺少的信息再问。不要假定宿主是 Codex，也不要默认写 `~/.codex`。

## 1. 先检查，再询问选项

检查当前 OS、可用 shell、Node/Bun、当前仓库路径和构建、宿主名称及其 MCP/Skill 能力。读取宿主已有配置时只获取所需字段，不回显 token 或其他服务的秘密。dsh/Qoder 等宿主的配置位置和格式以**本机帮助、已安装配置或该产品的官方文档**为准；不要猜测它们等同于 Codex，也不要给未知宿主编造安装命令。

向用户集中确认以下选项，已从对话获知的项直接沿用。推荐值是候选，用户确认前不执行依赖这些选择的安装。

| 选项 | 推荐 / 可选 |
| --- | --- |
| Agent 宿主和接入范围 | 自动识别后确认；项目级 / 用户级；MCP 服务名默认 `cua` |
| 浏览器运行位置 | 本机专用 Chrome 窗口（推荐）；连接现有本机 CDP；AgentBay；已有沙箱服务 |
| 本机窗口 | 可见窗口（推荐）；无头。新建独立 profile，不继承个人 Chrome 登录态 |
| 执行历史 | 本地记录（推荐）；关闭。默认不上报，失败截图单独选择 |
| 脚本沉淀 / 修复 | 两个独立选项：manual（推荐）、disabled、auto |
| 宿主能力 | stdio MCP / HTTP MCP；能否运行本地 CLI；是否支持 MCP Apps 和 Skill |
| 验证范围 | 只检查接入（不开浏览器）；或用户授权一次本机测试页浏览器验收 |

可以简问：“检测到你在使用 X。是否采用本机可见 Chrome、记录本地历史和失败截图、沉淀/修复均手动、日志不上报？配置作用于当前项目还是用户全局？本次只检查接入，还是也运行浏览器测试？”宿主能力能自动查到时不要让用户回答技术细节。

几个选项之间的约束：

- 历史关闭时，沉淀/修复与失败截图一并关闭；仍可执行已有脚本。不要默默改变用户选择，先解释依赖。
- `manual` 表示用户提出沉淀或修复后，使用**当前 Agent 模型**处理；正常 Runner 不调用模型。
- `auto` 表示生成待处理请求，当前 Agent/Harness 需主动接续；不是后台唤醒 Agent，也不会自动激活草稿或重跑任务。
- MCP Apps 是可选的交互界面能力。普通 MCP 不等于具备预览、私密表单和自动继续。未知宿主默认关闭 Apps；有官方支持或实际协商证据再启用。关闭时用受支持的终端/人工接管，绝不能让用户把密码或验证码填进聊天。
- 当前 Recipe 激活要求 **local-browser 实测通过**。纯 AgentBay/沙箱用户可以操作浏览器和记录历史，但不能承诺远端验证能激活脚本；需要另配本机验证 profile，或明确这项能力暂不可用。

## 2. 获取并构建

若当前目录已经是此仓库，复用它并保留未提交修改。否则使用有权限访问的源码：

```sh
git clone https://github.com/coetzeexu/open-cua.git
cd open-cua
bun install --frozen-lockfile
bun run build
```

源码需要 Bun 1.3.12 和 Node `>=24.18.0 <25`；本机 create 模式需要 Chrome。检查缺失后按用户环境准备依赖，不改动系统默认 Node。桌面宿主可能不继承 shell PATH，后续使用已验证的 **Node 绝对路径**。完整 Linux/Windows 运行包已有构建和 Node，可跳过 Bun；见 [运行包接入](docs/harness-integration.md)。Mac Apple Silicon 完整包同样无需构建或安装依赖，见 [Mac 安装与提示词](docs/macos-install.md)，后续命令使用包内 `runtime/node` 的绝对路径。当前没有公共 npm 包或稳定运行包下载源，不要编造 `npx` 安装方式。仓库需要访问权限；网页地址打不开时使用本地 checkout，或请用户提供可访问的仓库，不绕过权限。

## 3. 生成配置，绑定同一套历史和脚本

以下是 **Agent 确认用户选择后**填写的本机例子；不是固定替用户选好。将 `host` 改成实际宿主：

```json
{
  "host": "qoder",
  "provider": "local",
  "mode": "create",
  "headless": false,
  "apps": false,
  "history": true,
  "captureOnFailure": true,
  "distill": "manual",
  "repair": "manual",
  "serverName": "cua"
}
```

复制 [choices 示例](examples/setup.local.json)，在选定的持久目录保存为 `choices.json`。选用项目目录时把该运行目录加入项目忽略规则；不要提交个人路径、历史和截图。示例目录为 `~/.cua/installations/<宿主或项目名>`；可改为用户指定路径。

在仓库根目录执行（占位符由 Agent 替换为实际路径）：

```sh
node packages/cli/dist/index.js setup --answers /absolute/path/choices.json --directory /absolute/path/cua-installation
```

`setup` 会生成：

| 文件 | 用途 |
| --- | --- |
| `cua.json` | Service、历史、脚本配置，独立历史和脚本目录，上传关闭 |
| `mcp.json` | 常见 `mcpServers` 格式的 stdio 配置片段，含绝对 Node/入口/config/cwd |
| `launch.json` | 同一启动参数和所需环境变量**名称**，便于适配其他宿主格式 |
| `agent-context.md` + `installation.json` | 让后续对话找到正确 CLI、配置和 profile |
| `recipe-guide/SKILL.md` + `installation.json` | 无需 Skill 加载器也能读取的沉淀/修复指引 |

重复执行相同选择幂等；遇到不同文件或 Skill 软链会停止，不覆盖用户已有内容。要改变配置，Agent 先读现有内容再做针对性修改并运行 doctor，或选择新的安装目录；不要删除目录“解决冲突”。`setup` 不直接修改任何宿主全局配置。

支持 Skill 的宿主：先查出其实际 Skill 父目录，在 choices 增加 `"skillDirectory": "/actual/host/skills"`。setup 将安装 `cua-recipes/SKILL.md` 和该安装的配置绑定。目录已存在且指向其他安装时，先决定复用还是隔离，不能覆盖另一套绑定。

不支持 Skill 的宿主：无需安装 Skill。将 `agent-context.md` 的路径写入该宿主支持的项目指令/记忆入口；后续沉淀或修复直接读取 `recipe-guide/SKILL.md`。不要要求用户记住 `$cua-recipes` 语法，不要假定所有宿主都识别 `AGENTS.md`。宿主没有持久指令功能时，明确下一次会话需要重新提供 `agent-context.md`。

### 其他浏览器选择

choices 的共用字段与上例相同，仅替换浏览器字段：

- 本机 attach：`provider:"local", mode:"attach", endpoint:"http://127.0.0.1:9222"`，删除 `headless`。用户负责已启用 CDP 的浏览器；不强制重启个人浏览器。
- AgentBay create：`provider:"agentbay", mode:"create", imageId:"实际镜像ID"`，删除 `headless`。attach 则改为 `mode:"attach", sessionId:"实际会话ID"` 并删除 imageId。`AGENTBAY_API_KEY` 由用户在**运行服务的宿主环境**中设置，模型只检查是否存在，不读取或打印值。
- 沙箱内 stdio：`provider:"sandbox"`，删除 `mode/headless`；服务进程读取 `CUA_BROWSER_CDP_URL`，或显式指定无凭据的 loopback `endpoint`。setup 不创建沙箱、不启动浏览器。
- Agent 在本机而 CUA 在远端沙箱，或宿主只支持 HTTP MCP：不要把本机 stdio 路径当远端地址。按 [Harness 接入](docs/harness-integration.md) 完成服务部署、TLS、鉴权和宿主连接。本 setup 是 stdio 配置生成器，不是云资源部署器。远端历史/Recipe CLI 必须在服务所在主机运行；若 Agent 无该主机执行通道，明确只有浏览器 MCP 能用，沉淀/修复尚未接通。

完整 choices 字段见 [setup 与就绪检查](docs/agent-setup.md)。

## 4. 接入用户选择的宿主

1. 查询该宿主实际的 MCP 注册命令或配置格式、配置生效方式。`mcpServers` 是常见配置格式，**不是所有宿主必须采用的 MCP 协议字段**。
2. 只新增/更新用户指定的 CUA 服务，保留其他 MCP 和设置；修改前保存备份。同名且启动参数相同则复用；同名不同配置先向用户解释冲突，选择复用、改名或替换。
3. 将 `launch.json` 的 command、args、cwd、env 映射到该宿主支持的字段。仅传环境变量名称到宿主继承设置，不复制密钥到配置或聊天。若宿主不支持 cwd，当前生成配置已使用绝对路径，但仍应实测启动；无法继承所需变量则报告未就绪。
4. 将 `agent-context.md` 的路径绑定到宿主的持久指令，或安装已选择的 Skill。宿主若还需单独“启用 MCP / 信任服务”，完成它支持的流程；无法代操作时明确剩余一步，不宣称成功。
5. 必要时重新加载 MCP 或让用户重开会话。不能通过在终端另起 MCP 客户端，声称当前宿主已经挂载成功。

Codex 仅是其中一种可选适配，参考 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp) 和 [仓库 TOML 示例](examples/codex.config.toml)；只有用户选 Codex 才使用该路径。dsh/Qoder 按其本机实际支持的格式注册，当前仓库未宣称已完成这两个产品的原生界面验收。

## 5. 验证到什么程度，就报告到什么程度

先执行静态检查，然后做独立 MCP/REPL 检查；`--apps` 与选择一致：

```sh
node packages/cli/dist/index.js doctor --config /absolute/path/cua-installation/cua.json
node packages/cli/dist/index.js doctor --config /absolute/path/cua-installation/cua.json --mcp --apps off
```

doctor 检查 Node、构建、环境变量名称、存储可写；`--mcp` 通过正式服务握手、检查工具、执行 `output.text("CUA ready")`、关闭会话并核对历史。它不调用 `cua.connect()`，不开浏览器、不创建云浏览器；会启动正常 Service 和资源回收机制、保留一条检查历史。Apps 模式额外检查 UI 资源，不能据此声称宿主已能渲染卡片。

随后必须**通过用户选定宿主挂载的 CUA 工具**执行：

1. `cua_session_create({})`（使用已配置默认 profile；切换时传实际 profile），记录返回的 sessionId/runId，读 API 指引。
2. `cua_exec({sessionId, requestId:"本次唯一ID", code:'output.text("CUA ready");'})`；若 running 则 poll 原执行，确认输出。
3. `cua_close({sessionId})`，历史开启时通过同一 config 查询 Run，确认记录落盘。

不要预设工具的宿主前缀为 `cua_local`，从当前工具列表找到已注册的 server。宿主没有工具、看不到新版 schema 或尚需重载时，状态只能是“配置完成，等待宿主加载”。

默认到此结束，报告“宿主 MCP/REPL 可用，浏览器尚未验证，可以发起首次浏览器任务”。用户选择了浏览器验收时，再通过 CUA 打开受控本机测试页，观察后决定动作，核对结果，保存 Run 并关闭会话。可以复用 [本机合成订单 fixture](scripts/fixtures/recipe-orders.mjs)，但使用新目录和端口，不污染旧证据；不要把固定脚本执行当成模型沉淀质量验证。

最后交付：安装目录、宿主服务名、profile、历史开关、沉淀/修复模式、Skill 或直接读取方式、已通过的检查、尚未验证的能力。不给用户一大段待执行命令代替已授权的接入工作。

## 6. 开始使用

用户可以直接说：

- “打开这个页面，帮我完成……。”——通过 CUA 工具观察和操作。
- “把刚才成功的流程保存为脚本，日期作为参数。”——读取正确 Run 的历史，由当前模型按 recipe-guide 沉淀。
- “运行刚才的脚本，日期换成……。”——调用 CLI Runner，内部不调模型。
- “修复刚才失败的脚本。”——读取失败现场和原版本生成新草稿，验证后再激活。

所有历史/Recipe 命令携带 installation.json 中的 `--config`。技术成功不等于业务成功；失败或 unknown 先核实现场，不自动重放。不额外配置 OpenAI 或任何模型 API，模型由当前 Agent 提供。


遇到成功但绕路较多的流程，先 `history analyze RUN`，再按通用 Skill 生成带 provenance 的精简草稿；`recipe review` 不启动浏览器，`recipe validate` 才实际执行。错误返回含完整 message、执行 ID 和操作结果，按提示使用 `tab.info/goto/actions.scroll/dom.inspect`，不要把 Playwright API 名称套到 CUA。新版工具需宿主重新加载已构建的 Service；升级仓库不会自动覆盖宿主已复制的 Skill，按安装绑定更新指引并保留 installation.json。
