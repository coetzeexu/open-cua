# Open CUA

为 Codex 和其他 Agent Harness 提供持续的 JavaScript 浏览器操作会话。支持本机 Chrome、AgentBay 浏览器和沙箱内部署，通过 stdio 或 HTTP MCP 接入；MCP Apps 提供画面预览、人工接管、中断和交还。

**私密登录与任务自动继续**：模型负责识别登录字段，用户在独立 MCP App 卡片中填写账号密码。凭据通过宿主私密路由交给浏览器，不进入正常模型上下文；提交后仅发送不含凭据的状态消息，唤醒模型确认登录结果并继续任务。详见[凭据与模型上下文分离](docs/architecture.md#凭据与模型上下文分离)。

**通用安全表单**：支持 text/email/tel/password/date/原生单选，通过独立卡片私密填入网页。填写后保持流程保护，由用户检查业务结果；详见[当前交付范围](docs/secure-forms-design.md#当前交付范围)。

当前面向可信 harness 和受控代码。worker 与宿主同权限；人工确认和脱敏是 SDK 调用路径的保护，不保证恶意模型代码无法绕过。详见架构文档的安全边界。

## 从这里开始

- **[把这个入口交给 Agent](AGENT_QUICKSTART.md)**：适用于 dsh、Qoder、Codex 等；Agent 询问配置、生成安装文件、接入实际宿主并验证。支持 Skill 就安装，不支持则直接读取流程指引。不会默认写 Codex 配置。
- [配置生成与就绪检查](docs/agent-setup.md)：`cua setup` / `cua doctor`、配置字段、能力边界和故障定位。
- [Mac Apple Silicon 安装包与提示词](docs/macos-install.md)：自带 Node 和依赖的完整运行包，解压后接入 Agent 宿主。
- [Harness 接入 CUA](docs/harness-integration.md)：双方职责、沙箱安装命令、MCP + MCP Apps 协议、完整 run 与人工输入。
- [文件上传](docs/file-upload.md)：`setInputFiles`、iframe/隐藏控件、文件限制和验证方式。
- [架构与决策](docs/architecture.md)：进程边界、目标身份、取消、控制权、隐私与资源归属。
- [Runner 脚本服务](packages/runner/README.md)：独立 `@cua/runner` 子包，提供 HTTP 接口、持久化调度、MCP 执行与文件流转；[协议设计](docs/runner-design.md)。
- [执行历史与脚本](docs/history-recipes.md)：本地历史、现场上报、脚本版本与运行，以及当前模型的沉淀/修复入口。
- [本地脚本执行中心](docs/dashboard.md)：脚本与版本、执行统计、瀑布图 Trace、截图和快捷执行；`bun run dashboard --config /path/cua.json`。
- [最终工程计划](docs/plan-v0.7.md)：交付范围、已有验证证据、未完成验收和测试入口。

## 本机准备

开发需要 Bun 1.3.12、Node 24.18.x；本机浏览器模式还需要 Google Chrome。

```sh
git clone https://github.com/coetzeexu/open-cua.git
cd open-cua
bun install --frozen-lockfile
bun run build
```

随后按接入文档配置 MCP。`serve` 是等待客户端消息的 stdio 服务，不是终端 REPL；首次 `cua.connect()` 才连接浏览器。

## 开发与交付

```sh
bun run check            # 类型、边界、默认测试和构建，不启动浏览器
bun run test:chrome      # 专用本机 Chrome 回归
bun run package:windows  # Windows x64 完整包
bun run package:linux    # Linux x64 完整包
bun run package:mac      # Mac Apple Silicon（arm64）完整包
```

执行历史默认保存在 `~/.cua/history`；上报默认关闭。`cua history list/show` 查看历史，`cua recipe import/validate/activate/run` 管理和运行脚本。脚本正常执行不调用模型；`recipes.distill.mode` 与 `recipes.repair.mode` 独立支持 `disabled/manual/auto`，默认 manual。模型辅助使用仓库的 [cua-recipes Skill](skills/cua-recipes/SKILL.md)，自动模式需 Harness 提供当前模型回调；CLI 无模型时返回 `model_required`。

完整包自带 Node 和生产依赖，目标机无需 Bun。Bun 用于开发安装和构建，Service/REPL 使用 Node。开发 Preview 不进入运行包，正式人工界面使用 MCP Apps。

Windows 和 Ubuntu 已有 CLI、stdio/HTTP MCP mock 的真实沙箱验证。Codex 原生面板已完成接管、拖动和交还实测；新版 Windows 普通人工输入的 AX 脱敏复验通过，中断、拒绝新执行与人工交还后恢复的闭环已通过，详见最终计划。AgentBay Linux 的账号密码卡片、随机凭据校验和提交后自动继续已通过两种部署路径的模拟宿主验收。通用安全表单已通过本机 Codex 原生卡片填写、自动继续、人工检查提交与交还，以及跨页/reset 保护验收；AgentBay Linux 通用表单的 stdio attach 与沙箱内 HTTP MCP 两条链路也已通过真实浏览器及模拟 AppBridge 宿主验收，新 Linux 运行包已验证；Windows 新包及云端原生卡片人工验收仍未覆盖。仓库不包含部署凭据、个人 Codex 配置、临时沙箱地址和测试 artifacts。


### 1688 演示

设置 `CUA_BROWSER_CDP_URL` 指向可用的 Chromium CDP 端点，运行 `bun run build` 和 `node --import tsx examples/1688/preview.ts`，打开终端打印的预览地址。
