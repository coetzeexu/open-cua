import { readFile } from "node:fs/promises";
import { startRunner } from "@cua/runner";

export async function runnerCommand(args: string[]) {
  const index = args.indexOf("--config");
  if (
    index < 0 ||
    !args[index + 1] ||
    args.some(
      (arg, n) =>
        n !== index && n !== index + 1 && arg !== "--acknowledge-stopped",
    )
  )
    throw Error("Usage: cua runner --config FILE [--acknowledge-stopped]");
  const config = JSON.parse(await readFile(args[index + 1], "utf8"));
  const runner = await startRunner(config, {
    acknowledgeStopped: args.includes("--acknowledge-stopped"),
  });
  console.error(`CUA Runner ready at ${runner.url} (Bearer required)`);
  const stop = () => {
    void runner
      .close()
      .then(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return runner;
}
