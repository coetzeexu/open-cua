# CUA Runner 层设计（协议 v1）

状态：`@cua/runner` 已实现三个 HTTP 接口、SQLite 队列、MCP 执行、文件流转及功能测试。启动与运维见 [子包说明](../packages/runner/README.md)。

依据：[CUA Runner 协议](https://aliyuque.antfin.com/mk4b5n/hgg6z6/zy57fnh6l6crwu1g)，2026-11-01 读取。原文确定了预先启动 CUA MCP、浏览器配置、default/ax/dom、三个地址配置、三个接口名称及文件名包含 runId。原文 input_schema 示例止于 `user` 字段，执行与查询章节没有报文。下文为本仓库补齐的协议，外部脚本/文件服务提供方需按此对接。

## 1. 范围与依赖

Runner 面向业务系统提供脚本发现、参数校验、异步执行及结果查询；正常运行不调用模型，不自动修复脚本，不自动重放业务动作。浏览器启动、登录准备、CDP 地址、沙箱生命周期仍由部署层负责。

```text
业务调用方 ── HTTP/JSON ── @cua/runner
                            ├─ ScriptRepository ── 脚本源
                            ├─ FileGateway ── 输入文件源 / 输出文件服务
                            ├─ RunStore + 串行队列
                            └─ McpExecutor ── 已启动的 CUA MCP ── 浏览器
```

首版一个 Runner 绑定一个 MCP endpoint/profile，一个浏览器执行槽，最多一个运行中任务。schema/result 查询不占执行槽。队列容量有上限；不以多个 CUA session 假定浏览器隔离。多实例共享一个浏览器不在首版支持范围，启动时对 state_directory 持有独占锁。

包位置 `packages/runner`，包名 `@cua/runner`。依赖 MCP SDK、Ajv 2020/ajv-formats 与 Node 内置 SQLite，不导入浏览器 provider、core 或 REPL 内部模块。CLI 负责读取配置和启动 Runner，不在 Runner 内启动另一套浏览器。

现有 `@cua/recipes.runRecipe` 保留：它管理本地 Recipe、来源质量门槛、active 版本和 Service 执行。新协议的 `script_version` 是脚本源发布版本，不等于 Recipe UUID。未来若提供 Recipe 导出器，只允许导出已验证且激活的版本，保留 provenance/hash 映射；不能绕过现有激活门槛。现有 Parameter 是自定义参数模型，不能直接宣称支持完整 JSON Schema。

## 2. 启动与部署配置

配置字段以 [RunnerConfig](../packages/runner/src/index.ts) 为准：

| 配置 | 含义 |
| --- | --- |
| listen | 监听地址、端口、API Bearer 的环境变量名；默认 loopback |
| mcp | HTTP MCP URL、认证环境变量名、profile、observation_mode |
| script_source.base_url | 已发布脚本的受信任根地址 |
| input_files.base_url | 从上传系统读取输入文件的根地址 |
| output_files.base_url | 上传产物并获取下载引用的根地址 |
| work_directory | Runner 与 CUA 主机可见的同一个绝对目录 |
| state_directory | 任务数据库、版本缓存和进程锁目录 |
| limits | 队列、请求体、脚本、单文件、总文件量、超时与保留期 |

建议默认：队列 100、请求体 1 MiB、单脚本 1 MiB、单文件 50 MiB、每 run 20 个文件/200 MiB、任务总时限 10 分钟、单次 IO 30 秒、清理 30 秒、结果保留 7 天。排队计入任务总时限，manifest 的 timeout_ms 可缩短而不能延长全局时限。当前 cua_exec 的 timeoutMs 上限为 300000，提交时取剩余总时限、manifest 时限及 300000 的最小值；不能把 10 分钟直接传入 MCP，也不能通过重提脚本延长时限。

启动时校验配置、目录权限、独占锁、数据库迁移、MCP initialize/listTools 与必需工具。就绪检查不执行业务脚本、不打开浏览器；profile 对应浏览器是否可用在执行阶段检查。`observation_mode` 是部署与脚本兼容约束，不能传入 MCP 未定义的 mode 参数；脚本使用当前 SDK 已有的 AX/DOM API。default 表示不额外限制观察方式。

首版 Runner 与 CUA 必须同机或挂载同路径共享卷。当前 `setInputFiles` 只接受 CUA 服务主机上的绝对路径，MCP 不提供通用文件上传下载工具。不同主机且无共享卷时启动失败，不把 Runner 本机路径发给远端。输出目录同样依赖此约束。所有凭据由环境变量读取，不进入请求、脚本清单、工作目录或普通日志。

## 3. 脚本托管约定

脚本源提供以下只读对象（路径段须编码，ID 限定为字母、数字、下划线、短横线，长度 1–128）：

```text
{base}/scripts/{id}/published.json             → {"script_version":"1"}
{base}/scripts/{id}/versions/{version}/manifest.json
{base}/scripts/{id}/versions/{version}/main.js
{base}/scripts/{id}/versions/{version}/verify.js
```

manifest 使用 `ScriptManifest`，包括 input_schema/output_schema、entry/verify_entry、两个文件的 SHA-256、协议版本、观察模式和时限。版本目录只存已发布版本且不可原地更新；修改必须生成新版本。未指定版本时解析 published 指针，接单时冻结完整 manifest、源文件及摘要，排队期间发布变更不影响该 run。显式指定版本允许运行仍保留的已发布历史版本；撤销版本在入队和执行前检查并失败，不悄悄切换版本。

缓存键为 id/version/hash；同一 id/version 出现不同 manifest 或源码时返回 INTEGRITY_MISMATCH。撤销通过版本 manifest 返回 HTTP 410 表示，执行前重新读取 manifest 校验发布状态与摘要；404 同样拒绝运行，网络异常失败关闭而非使用缓存绕过检查。脚本源是受信任发布入口，hash 仅保证传输与版本完整性，不是代码签名或隔离机制。入口必须为版本目录内相对路径，拒绝绝对路径、`..`、跨源跳转和超限响应。网络来源只允许部署配置的源；运行请求不能指定 URL、源码或 MCP 地址。

main.js 是 async 函数体（不是 ESM 模块），在现有 CUA REPL 中运行，拿到已有 `cua` 及只读 `ctx: ScriptContext`。输入文件在 `ctx.input` 中保留文件引用，`ctx.files[JSON Pointer]` 提供实际绝对路径。业务代码返回 `ScriptReturn`，例如 `{output:{order_id:"PO-1"},files:[]}`。

verify.js 同样为 async 函数体，接收 `ctx` 和 `result: ScriptReturn`，必须读取业务证据并返回严格的 `true`。wrapper 在一次执行里先 main、后 verify，最后输出带 run 专属随机标记的 JSON envelope。适配器只接受匹配标记且完整、未截断的唯一结果；console/text 输出不能当作业务结果。返回值必须能无损表示为有限 JSON，不允许循环对象、undefined、非有限数字或隐式丢字段。输出 Schema 校验之后才能发布产物。

输入/输出均使用 JSON Schema 2020-12；以维护该方言的校验器编译，不手写部分规则冒充完整支持。开启 date/date-time 等 format 校验，不做类型强转、不移除额外字段、不隐式填默认值。禁用远程 `$ref`，允许当前文档的本地 `$defs` 引用；无法编译的 schema 拒绝发布/接单。Schema 是运行时校验依据，TypeScript 类型不承担验证。

## 4. HTTP 协议

三个接口统一 POST + application/json，使用 Bearer 鉴权，所有权由认证主体确定，不接收 caller_id 自报身份。拒绝未知顶层字段和超限请求体。无 WebSocket、回调或公开文件上传端点。API 路由和类型定义见 [src/index.ts](../packages/runner/src/index.ts)。所有时间为 UTC RFC 3339。

### POST /get_script_schema

```json
{"cua_script_id":"yangao-mrp-640","script_version":"1"}
```

script_version 可省略。成功 HTTP 200：

```json
{
  "cua_script_id":"yangao-mrp-640",
  "script_version":"1",
  "description":"填写采购信息并导入 BOM 文件",
  "input_schema":{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["apply_buy_user","bom"],
    "properties":{
      "apply_buy_user":{"type":"string","minLength":1},
      "bom":{
        "type":"object","x-cua-file":true,"additionalProperties":false,
        "required":["file_id","sha256","size_bytes"],
        "properties":{
          "file_id":{"type":"string","minLength":1},
          "sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
          "size_bytes":{"type":"integer","minimum":0}
        }
      }
    }
  },
  "output_schema":{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object","additionalProperties":false,"required":["order_id"],
    "properties":{"order_id":{"type":"string","minLength":1}}
  }
}
```

此例补齐文件字段以展示协议，不声称还原原文缺失的 ERP 字段。调用方建议携带获取到的版本运行，避免 schema 与最新版本发生竞态。

### POST /run_cua_script

```json
{
  "cua_script_id":"yangao-mrp-640",
  "script_version":"1",
  "request_id":"purchase-20261101-001",
  "input":{
    "apply_buy_user":"张三",
    "bom":{"file_id":"upload-001","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size_bytes":2048}
  }
}
```

示例摘要是占位值，真实请求须提供文件实际摘要。成功 HTTP 202：

```json
{"run_id":"8bcc8de7-d50a-4e1c-8551-5a89ad34c15d","cua_script_id":"yangao-mrp-640","script_version":"1","status":"queued"}
```

返回前完成鉴权、原始请求规范化、幂等检查、版本冻结、schema 编译/输入校验，以及任务+幂等键的原子持久化。不执行浏览器动作，也不等待文件下载。run_id 由服务生成，同时传入 CUA createSession 的 runId，用于历史关联。

request_id 必填，长度 1–128；唯一键为主体+request_id。请求摘要由规范化的原始请求产生（对象键排序、数组保序，拒绝重复 JSON key），包含版本是否省略。相同 key/相同请求返回原始 202 回执，即便已完成也不重跑；不同请求 HTTP 409。重试先读幂等记录再解析 published，防止版本变化导致重复接单。并发提交靠数据库唯一约束和事务解决，不依赖内存 Map。校验失败或队列已满不占用 key。

### POST /get_cua_result

```json
{"run_id":"8bcc8de7-d50a-4e1c-8551-5a89ad34c15d"}
```

HTTP 200 返回 RunResult；非终态不包含 output/files，建议 1 秒起步、最大 5 秒退避轮询。成功示例：

```json
{
  "run_id":"8bcc8de7-d50a-4e1c-8551-5a89ad34c15d",
  "cua_script_id":"yangao-mrp-640","script_version":"1",
  "status":"succeeded","business_success":true,"cleanup":"succeeded",
  "created_at":"2026-11-01T08:00:00Z","updated_at":"2026-11-01T08:01:00Z",
  "finished_at":"2026-11-01T08:01:00Z",
  "output":{"order_id":"PO-1"},"files":[]
}
```

执行失败也返回 HTTP 200 的终态记录，error 为机器可读 code/message，不返回内部堆栈。查询不存在或其他主体的 run 均返回 404，避免泄露存在性。

请求级失败统一 `{ "error": { "code": "INPUT_INVALID", "message": "..." } }`。HTTP 映射：400 请求格式；401 认证；403 脚本权限；404 脚本/版本/run；409 幂等冲突或版本完整性变化；413 请求体过大；422 schema/参数不合法；429 队列满（附 Retry-After）；502 源不可用；503 MCP 未就绪；500 内部错误。完整错误枚举在包契约中；日志记录内部原因，对外返回脱敏诊断。

## 5. 状态、持久化和执行

```text
queued → preparing → running → publishing → succeeded
   └───────────────任一非终态───────────────→ failed / timed_out / interrupted
```

preparing 下载并校验输入文件、准备目录、创建 CUA 会话；running 提交脚本、轮询、业务 verify 和输出校验；publishing 发布产物与提交结果。成功要求 main 成功、verify 为 true、输出合法且所有文件发布成功。文件发布失败为 failed/OUTPUT_PUBLISH_FAILED，同时 business_success=true，明确业务可能已经完成；不能据此重跑业务。business_success=null 表示未验证，false 只用于明确验证失败。

SQLite runs 行原子保存请求摘要、主体/request_id 唯一键、冻结版本、状态、execution cursor 和 artifact receipts；versions 表锁定已见版本摘要，meta 表保存隔离状态。使用 WAL + synchronous=FULL，独立 SQLite 排他事务持有进程锁，崩溃后由 OS 释放。派发前写 running 意图，收到 MCP 回执立即保存 sessionId/executionId/cursor。私密输入仅在有权限的任务存储中保留，不输出到 API 日志。输入文件先临时写入、校验后 rename，数据库发布引用只能指向完整文件。

MCP 调用顺序：initialize/listTools → cua_session_create({profile,runId,goal}) → cua_exec({sessionId,requestId,code,timeoutMs}) → cua_poll({sessionId,executionId,cursor}) 直到终态 → cua_close({sessionId})。保存 MCP transport session ID 与 CUA sessionId 两种 ID，不能混用。轮询必须推进 cursor，不能丢失或重复消费输出。

当前不自动重试源 IO 或 cua_exec。执行中的 cua_poll 使用原 session/execution/cursor；失联则 interrupted/EXECUTION_UNKNOWN，不创建新 session 重放。总时限耗尽，对已知 execution 调用 cua_cancel，再通过 cua_close 的 closed=true 确认整个会话结束；无法确认关闭的槽进入隔离。仅请求返回超时不代表浏览器动作已停止。

所有分支 finally 清理 CUA session。cleanup 失败独立记录，不把已完成业务改写为可重跑；释放失败的槽同样隔离。任务清理截止后可返回终态并显示 cleanup=failed，后台只重试资源清理。启动扫描：queued 可恢复排队；其余非终态标记 interrupted，保留所有现场且不自动续跑。存在无法确认结束的执行时，启动就绪失败直到处理。首版不承诺跨进程恢复浏览器执行。

遇到登录/验证码/私密表单请求时返回 USER_ACTION_REQUIRED 并取消/关闭原执行；首版不提供人工交互或暂停恢复接口。应在接单前完成登录准备。后续若引入 waiting_user，须同时提供 MCP Apps 宿主、恢复标识与状态机，不把三接口服务当作现成人工恢复能力。

终态结果不再改写，cleanup 信息允许单独更新；保留期从 finished_at 开始计算，活动任务不清理。幂等记录至少与结果同寿命，清理后 key 可再次使用，调用方不得跨保留期把旧 request_id 当作防重凭据。业务订单号等长期幂等由业务端保障。该机制保证接单防重，不声称跨网络和进程故障的业务 exactly-once。

## 6. 文件输入输出协议

`x-cua-file: true` 是 schema 扩展注解，Runner 在编译时登记允许的文件位置（支持 properties、数组 items 和本地 $ref；首版拒绝在 oneOf/anyOf 等歧义分支中声明文件）。普通对象恰好含 file_id 不能触发下载。单文件引用的形状见 InputFileRef。

输入服务约定 `GET {input_base}/files/{file_id}` 返回原始字节，必须按认证主体校验文件归属。Runner 的 FileGateway 传递经认证的主体上下文，服务账号凭据不能让调用方越权读取任意 file_id。输入流下载到 `{work}/{runId}/input/{generatedName}`，计算实际长度与 SHA-256，检查声明大小、摘要及配额后才交给脚本。文件名由服务生成，不能拼接调用方原始文件名。

输出由脚本写到 `ctx.outputDirectory = {work}/{runId}/output`，返回相对路径清单。Runner 通过 realpath 验证在目录内，拒绝符号链接、目录、设备文件和路径逃逸，只接受普通文件，限制数量/总量。脚本结束后冻结产物副本并计算摘要，避免上传时内容变化。

输出服务约定 `PUT {output_base}/runs/{runId}/files/{fileId}/{runId}-{safeName}` 上传原始字节，返回 OutputFile。fileId 是 Runner 生成并持久化的稳定 ID，重复 PUT 必须校验同摘要并返回相同对象；主体归属由服务端绑定。所有输出文件名包含 runId。download_url 必须是配置允许域的鉴权读取地址，查询接口不生成公开 URL、不返回磁盘路径。源服务若使用预签名 URL，由 FileGateway 适配，但 URL/令牌不进入普通日志，过期链接按原 fileId 刷新，不能重跑脚本获取链接。

部分文件上传成功时保留回执，任务仍失败且不暴露部分业务输出；可由运维按 runId 重试幂等发布，不能重执行 main。文件服务和本地临时目录保留期与 run 一致。文件系统检查是可信脚本的错误防护，不是恶意代码隔离；现有 REPL 与宿主同权限，首版只托管受控发布者脚本。

## 7. 实施拆分与验收

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| 基础 | workspace 子包、类型契约、设计文档、依赖边界接入（已实现） | typecheck、boundaries、build |
| 1 | ScriptRepository + JSON Schema 校验 + FileGateway | 版本冻结/篡改、非法 schema、日期/额外字段、文件摘要/配额/越权/路径逃逸 |
| 2 | RunStore + 串行队列 + 三个 HTTP 接口 | 同 key 并发只入队一次、请求差异 409、重启 queued 恢复、查询权限、队列满 |
| 3 | MCP Executor + wrapper + 产物发布 | mock MCP 完整工具顺序、cursor、verify false、输出截断、超时/失联不重放、清理失败隔离、部分上传失败 |
| 4 | CLI 配置/启动与交付包接入 | 独立启动/退出、共享目录检查、依赖安装与运行包验证 |

阶段 1–4 的运行代码已接入。测试使用 mock 文件服务、故障注入 MCP 和真实 HTTP MCP + fake provider，不启动真实浏览器。CLI 新增 `runner --config FILE`，既有 CLI/Dashboard 执行链路保持不变。真实外部文件服务、业务站点及 Windows/Linux 打包部署仍需现场验收。

实现约束：拒绝递归 Schema、远程引用及歧义分支的文件注解；文件数/总字节合并计算输入输出。download_url 只接受同源、无查询字符串的鉴权 URL，预签名 URL 适配未提供。上传回执逐个持久化，暂无公开重发产物接口；运维可使用冻结副本与回执处理，不能重跑业务。启动共享目录检查会执行仅含文件读取的 REPL 探测，不连接浏览器。

外部落地前需要服务提供方对齐脚本源对象布局、文件 GET/PUT 协议及主体授权方式；若外部存储接口不同，通过 Repository/FileGateway 适配，不改变三个业务接口。跨主机文件桥、分布式队列、人工接管、取消接口、脚本发布管理和自动修复均不在 v1 范围。
