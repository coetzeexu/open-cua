# Mac Apple Silicon 安装

交付物是 **`.tgz` 完整运行包**，适用于 Apple Silicon（M 系列芯片、arm64）。它包含已编译的 Open CUA、Node 24.18.0、生产依赖、配置生成器和安装指引。目标 Mac 无需安装 Bun、npm 依赖或系统 Node；本机浏览器操作需要另有 Google Chrome。

这是由 Agent 宿主按需启动的 stdio MCP 服务，不是 `.app`、`.dmg` 或双击安装的 `.pkg`。不需要 sudo、开机启动项或常驻 launchd 服务；安装完成后从宿主的 CUA 工具使用。

## 交付文件

维护者在源码目录运行 `bun run package:mac`，生成以下文件，一起发给使用者：

| 文件 | 用途 |
| --- | --- |
| `cua-macos-arm64.tgz` | 包含 Node 和依赖的运行包 |
| `cua-macos-arm64.tgz.sha256` | SHA-256 校验文件 |
| `INSTALL_MACOS.md` | 本文，含可直接复制的安装提示词 |

产物位于 `artifacts/macos/`；包内也有 `INSTALL_MACOS.md`。当前没有固定公共下载地址，使用交付方提供的文件，不编造 npm 安装命令或下载链接。

构建时默认下载官方 Node 发行包。已下载 `node-v24.18.0-darwin-arm64.tar.gz` 的维护者可以设置 `CUA_NODE_ARCHIVE=/绝对路径/node-v24.18.0-darwin-arm64.tar.gz` 后运行打包命令；仍会获取官方校验表并校验内容，不接受错版本或错架构的缓存。

## 给安装 Agent 的提示词

将三个交付文件放在同一目录，把下面的提示词交给目标 Mac 上有本地文件和命令执行能力的 Agent。把第一行路径替换为实际路径；宿主优先使用当前 Agent 所属产品，无法识别时再询问。

```text
请在这台 Mac 上安装并接入 Open CUA。运行包路径是：/请替换为实际路径/cua-macos-arm64.tgz，旁边有同名 .sha256 校验文件。

我已选择：当前 Agent 宿主、用户级安装、MCP 服务名 cua、本机专用可见 Chrome 窗口、保留本地执行历史、关闭失败截图与上报、脚本沉淀和修复均为 manual。仅验证 MCP/REPL，不打开浏览器。上述选项不再重复询问；无法识别宿主或遇到已有配置冲突时再询问。

请直接执行安装，不要只返回命令：
1. 检查系统为 macOS、硬件为 Apple Silicon（包括终端运行在 Rosetta 的情况），校验旁边的 SHA-256 文件；不匹配则停止。只检查 Chrome 是否存在，不启动它；缺失时告知浏览器功能尚不可用。
2. 将运行包解压到新的、持久的 ~/.cua/releases/ 子目录，名称含版本与本次校验值前缀。不要从 Downloads、临时目录或源码目录直接注册服务，不覆盖已有安装。使用包内 runtime/node，确认它报告 darwin/arm64 和 Node 24.18.0；不要安装 Bun 或替换系统 Node。
3. 阅读解压后的 INSTALL_MACOS.md 和 AGENT_QUICKSTART.md，按已选配置生成 choices.json。host 使用实际宿主，provider=local、mode=create、headless=false、history=true、captureOnFailure=false、distill=manual、repair=manual、serverName=cua。apps 仅在有宿主支持证据时为 true，否则 false。
4. 使用包内 Node 和 CLI 的绝对路径执行 setup，配置保存到 ~/.cua/installations/<实际宿主名称>。已安装时先检查并复用一致配置；冲突不得删除或覆盖。宿主支持 Skill 时先核实其实际 Skill 路径，再通过 skillDirectory 安装；否则绑定生成的 agent-context.md 和 recipe-guide 指引。
5. 根据宿主本机帮助或实际配置格式，备份并合并注册 cua MCP，保留其他设置。使用生成的 launch.json/mcp.json 中的绝对路径，不猜宿主配置位置，不默认写 Codex 配置。不配置 launchd、HTTP 对外端口或模型 API。
6. 运行 doctor 和 doctor --mcp，--apps 与选择一致。之后通过当前宿主挂载的 CUA 工具创建会话、执行 output.text("CUA ready")、关闭会话并核对历史；不调用 cua.connect()、不打开浏览器。宿主尚未加载工具时只报告“配置完成，等待宿主加载”，明确需要的重载步骤。
7. 最后报告运行包目录、配置目录、宿主服务名、profile、历史与脚本选项、Skill/指引路径，以及已通过和未完成的检查。浏览器未验证必须明确说明。
```

## 安装命令参考

以下命令供 Agent 按实际路径执行。先在交付文件目录校验：

```sh
shasum -a 256 -c cua-macos-arm64.tgz.sha256
```

硬件检查可以读取 `sysctl -n hw.optional.arm64`，值为 `1` 表示支持 arm64；不要仅依赖可能在 Rosetta 下返回 `x86_64` 的 `uname -m`。

解压到新的安装目录后，使用实际绝对路径替换以下占位符。`choices.json` 按提示词和实际宿主生成，字段参考包内 `docs/agent-setup.md`：

```sh
"/实际运行包目录/runtime/node" -p 'process.platform + "/" + process.arch + " " + process.version'
"/实际运行包目录/runtime/node" "/实际运行包目录/packages/cli/dist/index.js" setup \
  --answers "/实际配置目录/choices.json" --directory "/实际配置目录"
"/实际运行包目录/runtime/node" "/实际运行包目录/packages/cli/dist/index.js" doctor \
  --config "/实际配置目录/cua.json"
"/实际运行包目录/runtime/node" "/实际运行包目录/packages/cli/dist/index.js" doctor \
  --config "/实际配置目录/cua.json" --mcp --apps off
```

已启用 Apps 时将最后的 `off` 改成 `on`。doctor 不启动浏览器；独立 MCP 检查成功不代表当前 Agent 已加载服务。包内 Node 和配置里的路径必须保持稳定，移动运行包后需更新启动配置并重新检查。

升级时解压到新的 release 目录，备份并更新既有宿主的启动路径，保留原配置、历史和脚本；不要在服务运行中覆盖旧包。卸载先移除宿主中的 cua 注册，确认无进程使用后删除对应 release 目录；历史和脚本按用户选择保留。
