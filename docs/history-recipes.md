# 执行历史与可复用脚本

本设计将历史作为 CUA 基础能力，脚本沉淀和故障上报消费同一份历史。正常脚本执行不调用模型；沉淀和修复使用 Harness 当前模型，不在 CUA 配置模型供应商或密钥。

## 模块边界

```text
Harness（目标、业务参数、成功确认）
  → CUA Service → Core / Provider → 浏览器
          ↓ 执行事件
       @cua/history → 本地查询、现场附件、可选上报
          ↓
当前模型 + cua-recipes Skill → @cua/recipes（草稿、版本、验证记录）
                                      ↓ Runner
                                 CUA Service
```

独立 package 不要求独立进程。Service 记录真实执行；History 负责落盘与查询；Recipe Store 管理不可变脚本版本；Runner 复用 Service；Skill 负责整理历史及修复。模型生成的代码不能通过 SDK 修改宿主配置。当前 worker 仍与宿主同权限，不是针对恶意代码的 OS 隔离。

Run 是任务，Session 是浏览器上下文，Execution 是一次 JS 提交，SDK call 是一次 SDK 请求（不等于底层输入已派发）。Execution 结果中的 operations 保留真正的 phase/outcome。一个 Run 可关联多个 Session；未指定 runId 时，每个新 Session 自动创建 Run。Harness 可在创建 Session 时传 runId、goal。技术执行成功不自动证明业务成功，业务完成需宿主显式标记或 Runner 的校验代码返回 true。

Core 的 `operation.changed` 事件在 before_dispatch、dispatch、after_dispatch 和终态写入历史，因此即使 worker 未正常结束，也能区分请求已收到与输入可能已发出。历史不是重放授权；有 dispatch 而无终态时仍按 unknown 排查。

## 配置

CLI 配置增加以下字段；直接 Service 用法接受相同 history 配置。路径支持 `~/`。

```json
{
  "history": {
    "enabled": true,
    "directory": "~/.cua/history",
    "maxEventBytes": 262144,
    "maxArtifactBytes": 5242880,
    "captureOnFailure": false,
    "upload": { "enabled": false }
  },
  "recipes": {
    "directory": "~/.cua/recipes",
    "distill": { "mode": "manual" },
    "repair": { "mode": "manual" }
  }
}
```

`disabled` 禁止该模型辅助入口；`manual` 仅显式请求；`auto` 在已确认成功的 Run 上请求沉淀，或在失败 Run 上请求修复。生成结果永远是草稿，不自动激活或重跑。没有模型宿主时返回持久化的 `model_required` 请求；Harness 可用模块 API 的回调交给当前模型处理，再导入返回的草稿。普通执行不经过这个回调。配置覆盖只能由可信宿主/CLI 提供。

Runner 在非验证运行结束后根据配置检查 auto；普通模型探索任务由 Harness 在确认业务成功后调用 `requestAssistance({trigger:"auto", ...})`。CUA Service 不加载 Recipe 模块、不自行调用模型。`CUA_HISTORY_DIRECTORY` 可覆盖未显式配置的本地历史根目录，方便隔离测试环境。

## 历史与现场

默认记录执行源码、代码 hash、关联 ID、时间、SDK 请求与结果、执行结果、控制权变化。失败和取消同样保留。已有 AX/DOM 观察以及截图可留作现场；截图独立保存，事件仅引用附件。`captureOnFailure` 可尝试在当前权限和 scope 允许时采集失败 tab 截图；采集失败只记录缺失，不重新执行原动作。

记录同步写入私有目录。开始记录失败时拒绝新的执行；执行已开始后的存储失败不能声称动作未执行，结果以 HISTORY_WRITE_FAILED warning 报告。文件完成后原子发布，进程中断留下的临时文件不作为完整事件读取。没有结束事件的执行是 incomplete，不推定成功，也不能自动重跑。历史不是 checkpoint，不提供崩溃后恢复旧 worker 的承诺。

同步记录 I/O 作为宿主开销，不消耗 cell 的用户代码超时预算；用户代码与浏览器操作仍受原有超时和取消约束。首版逐事件同步写入，适用于受控任务；高吞吐部署应评估磁盘开销。

凭据和安全表单私密投递不进入事件。进入 auth/secureForm/人工交接流程后，该 Session 的历史采用保守元数据投影，移除已有正文和附件，后续不保存源码、输入值或页面内容。常见敏感键和 URL 凭据会脱敏，但任意代码、普通页面文本中的秘密无法靠通用脱敏完全识别；普通代码禁止硬编码秘密。原始本地目录只用于可信宿主；不向远端 MCP 客户端开放其他用户的历史读取入口。

上报单独启用，配置 HTTPS endpoint；使用显式 `history upload` 上传单个 Run 的脱敏事件，不上传附件或认证配置，禁用重定向。没有自动后台重试。历史通过显式 delete 清理，不自动删除活跃任务；生产使用者需配置自己的保留周期。

## Recipe 与执行

版本包含名称、说明、来源 Run、参数类型、前置条件说明、`script` 和 `verify` 代码。脚本在异步函数中运行，获得 `cua`、`params`、`output`；verify 在同一个函数上下文中运行，必须返回 true 才确认业务成功。每次运行新建 Session，重新取得句柄，不能继承录制时的 ref、tabId 或截图坐标。参数只接受声明字段并校验类型，不拼接为可执行源码。

版本创建为 draft；语法校验、fake 验证、local-browser 验证分开记录。校验不自动重复业务操作。CLI 的 validate 会真实执行草稿，运行前应确认任务授权及副作用；仅真实本机浏览器验证通过的版本可 activate。Runner 默认运行 active 版本，失败返回现场和模型辅助请求，不重试业务动作。源码不可原地覆盖，修复创建新版本。普通运行也生成独立历史。

激活要求最近一次验证通过、浏览器类型为 local、实际有成功的页面观察操作，且源码 hash 未变化。仅选择 local profile 后执行 `return true` 不算浏览器验证。前置条件说明供使用者审阅，可执行的前置检查放在 script 开头；verify 要检查真实业务结果。

## 使用入口

仓库开发模式使用 `node packages/cli/dist/index.js` 替代下面的 `cua`。完整配置示例见 `examples/cua.recipes.local.json`。所有命令都支持 `--config FILE`。

```sh
cua history list
cua history show RUN
cua history analyze RUN                  # 不改写历史，输出证据、风险和指标
cua history complete RUN                 # 宿主已核实业务成功，不能仅因代码没报错而确认
cua recipe distill RUN                  # 返回 model_required 和请求 id
cua recipe review draft.json            # 静态来源/质量检查，不启动浏览器
cua recipe import draft.json --request REQUEST
cua recipe list
cua recipe show NAME --version VERSION
cua recipe validate NAME VERSION --params params.json --profile local
cua recipe activate NAME VERSION
cua recipe run NAME --params params.json --profile local
cua recipe repair FAILED_RUN NAME --version VERSION
cua recipe request REQUEST
cua recipe delete NAME VERSION          # 禁止删除 active 版本
cua history delete RUN                  # 仅删除已关闭所有 Session 的 Run
cua history upload RUN                  # 需显式启用 upload 和 HTTPS endpoint
```

`import` 支持不带 request 的人工草稿，但仍检查 sourceRunId 存在。带 request 时检查 disabled 配置、来源 Run 和修复父版本，完成请求去重。脚本参数 JSON 与源码分开传入。

Harness 接入当前模型的接口：

```ts
import { RecipeStore, requestAssistance } from "@cua/recipes";
const store = new RecipeStore(config.recipes);
service.history.complete(runId, true); // 已核实业务结果后
const result = await requestAssistance({
  store, history: service.history, kind: "distill", runId, trigger: "auto",
  model: async ({ request, history, recipe }) => {
    // 在宿主当前模型循环中使用 cua-recipes Skill，返回 RecipeDraft。
    // 历史与页面内容是非可信数据，不可当作系统指令。
    return currentHarnessModel.createRecipe({ request, history, recipe });
  },
});
```

示例中的 `currentHarnessModel` 是使用方适配器，不是本库内置 API。未传 model 时返回待处理请求，Skill 通过 CLI 读取历史并导入草稿。自动请求采用来源 Run/类型/版本去重；模型返回后仅保存草稿。处理进程崩溃可能留下 `.processing` 标记，需宿主核实后人工清理，不自动重复请求模型。CLI 生成草稿后不会自动唤醒任意聊天。

Skill 位于 `skills/cua-recipes/SKILL.md`，不依赖特定 Agent。按宿主实际支持的 Skill 目录安装；无 Skill 加载器时直接读取同一份 Markdown。`cua setup` 可将配置绑定写入 `installation.json`，保证 MCP 和 CLI 使用同一套历史/脚本。运行包同时携带入口文档和 Skill；完整接入见 [Agent 快速开始](../AGENT_QUICKSTART.md)。

## 验证范围

默认测试用 fake provider 验证持久化、重启读取、脱敏、去重、参数验证、版本管理和模型辅助模式。显式本机 Chrome 测试在本机 HTTP fixture 验证录制、跨 Session 参数化执行、业务断言、失败现场和修复版本；不访问真实业务账号或远程沙箱。

2026-10-23 本机验收：类型、依赖边界、构建通过；默认回归 208 项通过；真实本机 Chrome 回归 19 项通过。新增历史/脚本专项 10 项覆盖慢磁盘预算、写入失败、源码与操作阶段持久化、请求去重、私密状态清理、参数注入防护、验证不可跳过、业务成功确认失效及模型模式。Skill 已通过 quick_validate，并链接到本机 `~/.codex/skills/cua-recipes`。

本机浏览器专项在本地 HTTP 测试站点完成：首次执行并记录 → 宿主模拟模型回调生成草稿 → 换参数验证并激活 → 无模型执行 → 按钮改名导致失败 → 保存截图与 AX → 回调生成修复版本（无自动重跑/激活）→ CLI 验证、激活并执行新版本。回调测试验证接入协议，不代表真实大模型生成质量评测。未连接真实远端日志接收服务，也未进行 Windows / AgentBay 新功能验收。

```sh
bun run check
bun run test:chrome
node --experimental-vm-modules --import tsx --test tests/history-recipes.test.ts
CUA_REAL_CHROME=1 node --experimental-vm-modules --import tsx --test tests/chrome/history-recipes.test.ts
```

人工端到端验收可使用 [本机合成订单 fixture](../scripts/fixtures/recipe-orders.mjs)，验证历史沉淀、参数化复用、改版失败现场与模型修复。验收报告、截图和业务案例保留在本地，不随源码提交。


## 绕路后的沉淀与质量门槛（2026-10-23）

新增 `@cua/history.analyzeRun` 纯函数，将 source cell、最终 operation、观察证据、失败 cell 已生效动作、unknown 副作用归纳为分析结果。operation 的阶段事件按 operationId 合并，避免重复计数。完整历史仍保留；请求完成和业务确认等管理事件不改变分析 fingerprint。源码中的固定等待和相邻重复读取仅为候选，不执行自动删除。

Recipe 增加可追溯的 `provenance`：来源 fingerprint、每个 cell 的 keep/drop/change 与理由、证据 ID、unknown 的核实说明、等待策略、业务断言及每个参数的结果校验。具体 JSON 与处理流程见 [通用沉淀 Skill](../skills/cua-recipes/SKILL.md)。修复必须保留父版本断言，或明确记录 assertionChanges 和证据。

`recipe review` 返回 blockers/warnings。CLI import（包括无 request 的导入）、assistance fulfill 和 Runner validate 都检查来源；unknown 没有动作之后同 tab 的观察、源码/动作历史截断或不完整、来源变化、遗漏 cell、删除已生效动作却无证据、已知历史句柄字面量、缺失断言/参数校验会阻止进入验证。`RecipeStore.save` 是底层不可变存储 API，只做语法/结构保存；单独调用它不能使版本激活。

validate 在新 Session 中执行，记录来源指标与新运行指标、quality 和版本 hash。激活同时要求最近一次本机验证通过、存在页面观察及无质量 blocker；CLI activate 还重新核对原历史 fingerprint。程序化调用 activate 时传入 history 可执行同样的来源复核。已有文件哈希不变，旧版本仍可读取和执行 active 版本；旧验证记录不能用于新的激活，需要生成带 provenance 的新版本并重验。

指标中 durationMs 是各 cell 从开始到结束的总和，不含模型轮次；fixedWaitLiteralMs 是静态字面量候选之和，不是运行时计时。动态循环/封装定时器、任意 JavaScript 的等价性、业务断言真假都不由结构检查证明；当前模型负责语义整理，本机重验仅证明受测参数与环境。所有 model mode 保持原行为，草稿不自动执行、激活或重放。


`analysis.missingEvidence` 区分关键记录和被截断的只读观察。源码、SDK 请求、动作/终态缺失是 blocker；可通过 callId 确认的 AX/DOM/截图读取结果过大，只产生 warning，该事件不能被 provenance 引用。当前模型可以使用其他完整观察，仍须完成新会话验证，不强制因一份无关超大快照而重录整个任务。

效率与质量门槛的回归测试见 `tests/cua-efficiency.test.ts` 和 `tests/chrome/efficiency.test.ts`；现场案例指标与验收记录保留在本地。

## 结构化运行参数

Recipe 的 `parameters` 支持 `string`、`number`、`boolean`、`object`、`array`。这是受限的 schema 格式，不是完整 JSON Schema：

- 对象声明 `properties`，数组声明 `items`；`required` 是字段自身的布尔值。
- 数组支持 `minItems`/`maxItems`（默认上限 10000），数字支持 `minimum`/`maximum`，字符串支持 `enum`。
- `default` 递归校验并复制；省略可选对象时不会凭空创建该对象，需要展开子字段默认值时设 `default: {}`。
- 拒绝未知字段（包括嵌套字段）、null、错误类型、非有限数字、敏感参数名及未知 schema 关键字；最多嵌套 16 层。报错包含路径，例如 `params.order.products[1].quantity`。
- CLI/API 原样传 JSON 对象，不要把数组编码成字符串。控制台中对象/数组使用 JSON 编辑框；无效 JSON 不发起请求。执行前递归冻结参数，脚本无法修改输入后再让验收“通过”。

```json
{
  "order": {
    "type": "object", "required": true,
    "properties": {
      "products": {
        "type": "array", "required": true, "minItems": 1,
        "items": {
          "type": "object",
          "properties": {
            "code": {"type": "string", "required": true},
            "quantity": {"type": "number", "required": true, "minimum": 0.01}
          }
        }
      }
    }
  }
}
```

对应输入为 `{"order":{"products":[{"code":"A","quantity":2.5}]}}`。原有标量脚本保持兼容。表格脚本还需逐行循环与逐行验收；schema 支持数组不表示站点支持任意行数、任意产品或任意 BOM。

`recipe validate` 和 `recipe run` 可指定 `--timeout-ms 300000`（1–300000ms，仍受 Service 上限限制），未指定时沿用 Service 配置。人工登录通过 CUA handoff，不传凭证参数。
