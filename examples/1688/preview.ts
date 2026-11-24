import { startPreview, waitPreviewExecution } from "@cua/preview";
import type { CUAService } from "@cua/service";
import { run1688Demo, type DemoTask } from "./demo1688.js";

function scenario(
  service: CUAService,
  sessionId: string,
  tabId: string,
  log: (message: string) => void,
) {
  let demoTask: DemoTask | undefined;
  let demoAbort: AbortController | undefined;
  let demoRunning = false;
  const cancelDemo = () => {
    demoAbort?.abort();
    if (demoTask?.status === "running") {
      demoTask.status = "interrupted";
      demoTask.stage = "已中断；交还模型后可重新运行演示2";
    }
  };
  const startDemo2 = () => {
    if (
      demoRunning ||
      service.status()[0]?.status === "busy" ||
      service.status()[0]?.control !== "agent"
    )
      throw Error("Model unavailable");
    const task: DemoTask = {
      status: "running",
      stage: "准备演示2",
      products: [],
    };
    const abort = new AbortController();
    demoTask = task;
    demoAbort = abort;
    demoRunning = true;
    void run1688Demo({
      task,
      signal: abort.signal,
      progress: log,
      async execute(code) {
        const initial = await service.execute({
          sessionId,
          code: `var browser=await cua.connect();var tab=await browser.tabs.get(${JSON.stringify(tabId)});${code}`,
        });
        const result = await waitPreviewExecution(service, sessionId, initial);
        if (result.status !== "succeeded") {
          const failed = result.operations.findLast((o) => o.error);
          task.failure = {
            code: failed?.error?.code ?? result.error?.code ?? result.status,
            operation: failed?.kind,
          };
          throw Error("CUA step did not complete");
        }
        const value = result.output.findLast((o) => o.type === "text")?.text;
        return value === undefined ? undefined : JSON.parse(value);
      },
    })
      .catch(async () => {
        if (abort.signal.aborted) return;
        task.status = "blocked";
        task.stage =
          "页面未满足当前步骤条件。请查看画面；如需登录或验证，可取得控制权处理，交还模型后重新运行演示2。";
        log("演示2已暂停：页面条件未满足，未将未查看商品记为完成");
        await service.interruptSession({ sessionId }).catch(() => {});
      })
      .finally(() => {
        demoRunning = false;
      });
  };
  return {
    start: startDemo2,
    cancel: cancelDemo,
    active: () => demoRunning,
    state: () => demoTask,
  };
}
const preview = await startPreview({
  scenario,
  scenarioScript: new URL("./panel.js", import.meta.url),
});
console.log(`http://127.0.0.1:30150/#${preview.token}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void preview.close());
