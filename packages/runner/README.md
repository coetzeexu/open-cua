# @cua/runner

通过已启动的 CUA HTTP MCP 执行已发布脚本。提供三个鉴权 HTTP 接口、SQLite 持久化串行队列、JSON Schema 2020-12 校验、输入文件下载和输出产物发布。不启动浏览器，不调用模型，不自动重放业务动作。

- [完整设计](../../docs/runner-design.md)：接口报文、状态机、文件协议、部署边界、实施顺序与验收。
- [类型契约](src/index.ts)：三个接口、脚本清单、任务结果和启动配置。
- 来源：[CUA Runner 协议](https://aliyuque.antfin.com/mk4b5n/hgg6z6/zy57fnh6l6crwu1g)，读取于 2026-11-01。

```ts
import { RUNNER_ROUTES, type RunScriptRequest } from "@cua/runner";

const request: RunScriptRequest = {
  cua_script_id: "yangao-mrp-640",
  script_version: "1",
  request_id: "purchase-20261101-001",
  input: { apply_buy_user: "张三" },
};
// 启动服务后，POST runnerURL + RUNNER_ROUTES.run，携带 Bearer 和 JSON 请求体。
```

本包是独立 workspace，不迁移或改变 `@cua/recipes` 的现有 `runRecipe`。

## 启动

使用 Node 24.18.x。Runner 与 CUA 必须共享相同绝对路径的工作目录；启动会在 CUA REPL 读取探测文件，不连接浏览器。

1. 启动 CUA HTTP MCP，配置 profile 并准备浏览器登录状态。
2. 按 [配置模板](../../examples/runner.json) 设置 MCP、三个服务地址、绝对目录与配额。模板域名仅为示例，不能直接运行。
3. 在环境中提供 `CUA_RUNNER_TOKEN`（至少 32 个非空白字符）、`CUA_MCP_TOKEN` 及模板指定的文件/脚本服务凭据。
4. 启动：

```sh
bun install --frozen-lockfile
bun run build
node packages/cli/dist/index.js runner --config /absolute/path/runner.json
```

程序接入使用 `await startRunner(config)`，返回 `url`、`close()` 和 `retryCleanup()`。可注入 `authenticate(request)` 与 `authorizeScript(principal, scriptId)`；默认 Bearer 映射单一主体 `service`，不是多租户认证系统。主体使用 1–128 位安全 ID。

## HTTP 接口

统一 POST、`Authorization: Bearer ...`、`Content-Type: application/json`。

| 路径 | 请求 | 响应 |
| --- | --- | --- |
| `/get_script_schema` | `cua_script_id`、可选 `script_version` | 200，版本、说明和输入/输出 Schema |
| `/run_cua_script` | 上述标识、必填 `request_id`、`input` 对象 | 202，固定版本、run_id、接单时 queued |
| `/get_cua_result` | `run_id` | 200，当前状态、成功输出或失败原因 |

相同主体/request_id/请求返回原始接单回执，参数不同返回 409，已结束也不重跑。执行失败通过结果中的 status/error 表达；HTTP 200 不代表业务成功。非终态和失败态不返回部分输出。完整示例见设计文档。

## 脚本和文件

脚本源按设计提供 published.json、不可变版本 manifest.json 和 main/verify 源文件。源码是 async 函数体；main 接收 `ctx`，返回 `{output,files}`；verify 接收 `ctx,result`，必须返回 true。Runner 冻结版本与摘要，源变化或撤销后排队任务失败，不切换版本。

`x-cua-file: true` 标记输入文件引用。输入服务提供 `GET {input_base}/files/{file_id}`，Runner 校验大小、摘要，路径放入 `ctx.files[JSON Pointer]`。支持嵌套对象、数组和本地 `$defs` 引用；拒绝远程引用、递归 Schema 和歧义分支的文件注解。

脚本将产物写入 `ctx.outputDirectory`，返回相对路径/MIME 类型。Runner 拒绝路径逃逸、符号链接及配额超限，冻结副本后向 `PUT {output_base}/runs/{runId}/files/{fileId}/{runId}-{name}` 上传。输出服务返回 OutputFile，元数据必须匹配，download_url 必须同源、无查询令牌并受服务鉴权。单 run 文件数和总字节配额合并计算输入输出。

文件请求携带部署服务凭据及 `X-CUA-Principal`。**文件服务须将此受信任主体绑定到文件所有权，验证 GET/PUT 权限**，不能仅凭服务账号允许任意 file_id。输出 PUT 应按 fileId/hash 幂等。成功回执逐个持久化，上传失败不重新执行 main；当前无公开重发产物接口，运维可依据本地冻结副本和回执处理。

## 关闭与恢复

SIGINT/SIGTERM 停止接单、取消/关闭当前会话并保留排队任务，下次启动恢复队列。完成结果、幂等键和本地工作文件到保留期后由每分钟维护任务清理；未确认清理成功的任务保留供排查。远端文件的到期删除由文件服务按相同保留策略管理，Runner 不调用外部删除接口。

运行总时限含排队，MCP 单次执行不超过 300000 ms。会话关闭未确认时隔离执行槽，查询仍可用，新接单返回 503。进程存活时每分钟仅重试已知 session 的资源清理，也可调用 `runner.retryCleanup()`；成功后继续原队列。

崩溃后的非排队任务标记 interrupted。若旧 session 可能仍存活，启动拒绝就绪。操作员先在 CUA 主机检查并停止旧工作、释放会话，再显式启动：

```sh
node packages/cli/dist/index.js runner --config /absolute/path/runner.json --acknowledge-stopped
```

该开关是对旧执行已停止的确认，不会终止未知远端会话或重跑 interrupted 任务。不要在普通进程管理器启动命令中常驻此开关。

Runner 只运行受控发布者脚本，沿用 CUA REPL 与宿主同权限的边界。外网监听由部署层提供 HTTPS，非 loopback 的下游服务须用 HTTPS。人工输入返回 USER_ACTION_REQUIRED，首版不托管 MCP Apps。

## 验证

```sh
bun run typecheck
bun run check:boundaries
bun run build
node --experimental-vm-modules --import tsx --test tests/runner.test.ts
```

覆盖真实 HTTP MCP + fake provider，以及故障注入 MCP、文件服务、队列/重启/幂等、鉴权、Schema、文件完整性和清理隔离，不启动真实浏览器。
