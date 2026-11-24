# Agent 接入配置参考

面向用户的单一入口是根目录 [AGENT_QUICKSTART.md](../AGENT_QUICKSTART.md)。此页供执行安装的 Agent 查阅字段与诊断，不替代宿主自己的 MCP 配置文档。

## CLI

开发 checkout 的 `cua` 为 `node <repo>/packages/cli/dist/index.js`，使用经过验证的 Node 绝对路径。

```text
cua setup --answers choices.json --directory DIR
cua doctor --config FILE [--mcp] [--apps on|off]
```

命令无交互 TTY 依赖，用户问答由当前 Agent 完成；所有结果是 JSON。setup 不注册宿主、不打开浏览器、不配置模型、不上传历史。doctor 失败退出码为 1；参数错误同样非零。`--mcp` 启动当前构建的正式 stdio 服务做独立工具/REPL 检查，关闭时清理会话；未指定时只检查配置。宿主挂载验证必须另行从该宿主工具执行。

## choices 字段

| 字段 | 类型 / 默认 | 含义 |
| --- | --- | --- |
| host | 非空 string，必填 | 宿主名称，仅记录，不据此猜配置目录 |
| provider | local / agentbay / sandbox，必填 | 浏览器运行环境 |
| mode | create / attach；local/agentbay 默认 create | sandbox 仅 attach，可省略 |
| headless | boolean；local create 默认 false | 仅用于本机新建窗口 |
| endpoint | string，可省略 | local attach 必填；sandbox 可用，需 loopback。无内嵌凭据/query/fragment |
| imageId | string，可省略 | AgentBay create 必填，真实镜像 ID |
| sessionId | string，可省略 | AgentBay attach 必填，既有会话 ID |
| apps | boolean，必填 | 是否已确认宿主支持 MCP Apps；未知选 false |
| history | boolean，必填 | 是否保存执行历史 |
| captureOnFailure | boolean，默认 false | 失败时尝试采集现场截图；需 history |
| distill / repair | disabled / manual / auto，分别必填 | 两项独立模型辅助开关；history=false 时必须均为 disabled |
| serverName | string，默认 cua | 字母开头，字母/数字/下划线/连字符，最多 64 字符 |
| skillDirectory | string，可省略 | 已核实的宿主 Skill 父目录；不填也会生成直接阅读版指引 |

未知字段拒绝，不静默吞掉拼写错误；私密配置不放入 choices。上传在快速接入中固定关闭，另有明确上报需求时按 [历史配置](history-recipes.md) 配置。

`--directory`、answers 和 skillDirectory 支持 `~/`，解析为运行此 CLI 的用户目录。生成的 Node/CLI/config/cwd/存储目录全部是绝对路径，避免宿主工作目录不同而读错配置。每次安装独立历史和 Recipe。搬迁 checkout 或 Node 后需要更新启动参数并重新 doctor；不声称旧绝对路径仍有效。

`setup` 比较所有拟写文件，任何差异先报冲突；相同内容不重写（JSON 允许格式差异）。不存在的文件使用独占创建，不覆盖同名文件。不删除额外文件，不覆盖现有 Skill 软链。Skill 是复制安装，包含绑定该配置的 installation.json，仓库后续更新不会静默改变已安装 Skill；升级由 Agent 审阅差异后完成。

## 能力与就绪状态

| 检查 / 状态 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| setup: configuration_generated | 本地文件已生成 | 宿主已注册 / 已加载 |
| doctor: scope=configuration | Node、入口、变量存在性、存储可写 | 密钥有效、浏览器安装、远端可达 |
| doctor --mcp: scope=standalone-mcp | 正式 stdio、工具、REPL、历史链路通过 | 当前宿主的 MCP 注册、界面渲染、真实浏览器动作 |
| 宿主工具调用成功 | Agent 能从自己的 MCP 工具访问服务 | 尚未执行的浏览器和私密卡片流程 |
| 用户授权的浏览器验收通过 | 本次浏览器/provider 实际可用 | 所有站点兼容性、所有宿主界面能力 |

doctor 始终报告 `hostRegistration:not_checked` 与 `browser:not_tested`，不会把 REPL 输出混同浏览器验收。`--apps on` 用支持 UI 的 MCP 客户端协商并读取 3 个 UI 资源，但不渲染宿主卡片。Apps 的私密路由、iframe 和自动继续由宿主实现。

`launch.json.requiredEnvironment` 仅列必须继承的环境变量名：AgentBay 的 `AGENTBAY_API_KEY`，或 sandbox 的 `CUA_BROWSER_CDP_URL`。设置于实际服务进程环境；运行 doctor 的 shell 有变量，不代表 GUI 宿主也有。不要把值转抄到宿主 JSON、日志或模型上下文。

## 常见阻断

| 现象 | Agent 的处理 |
| --- | --- |
| Existing file differs / Skill symlink | 保留原内容，比较安装位置；明确复用/新安装/针对性更新，不删库重来 |
| 配置生成了但看不到工具 | 查询宿主注册与加载状态，按该产品方式重载；报告等待宿主加载 |
| 独立 doctor 成功，宿主失败 | 比较实际 Node 路径、权限、环境变量、传输方式、cwd；不重复安装无关依赖 |
| 缺环境变量 | 让用户通过环境/密钥管理设置，只验证存在性，不向聊天索要值 |
| 不支持 Skill | 将 agent-context.md 放入宿主持久指令；沉淀修复直接读 recipe-guide/SKILL.md |
| 无法持久加载指引 | 说明下一会话需提供 agent-context.md，不能宣称跨会话已自动安装 |
| 不支持 MCP Apps | apps=false，普通操作仍可用；私密输入使用受支持的人工路径 |
| 只有 HTTP MCP | 按远端接入文档部署/注册 URL；不将 stdio JSON 当 HTTP 配置 |
| 远端只有 MCP、没有 shell/CLI 通道 | 浏览器工具可用；历史/Recipe 管理尚不可用，需要服务主机执行通道 |
| 远端 Recipe 无法 activate | 当前实现只接受 local-browser 验证；需要已授权的本机验证环境，不能伪造 validation |

本轮实际功能检查覆盖通用配置生成、重复运行、冲突保留、显式 Skill 目录、环境变量与配置依赖、真实 stdio MCP/REPL 的无浏览器探测。dsh/Qoder 的原生 MCP 注册、UI 与持久指令路径尚未实机验收；需要目标 Agent 按入口文档完成最后的宿主验证。
