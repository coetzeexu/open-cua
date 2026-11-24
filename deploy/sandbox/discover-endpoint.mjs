import { readdir, readFile } from "node:fs/promises";
import { posix, join } from "node:path";

import { discoverWindowsEndpoint } from "./discover-windows.mjs";

// AgentBay image-specific adapter, kept outside the generic provider. No port scan.
export async function discoverEndpoint(
  profile = "/tmp/agentbay_browser",
  procRoot = "/proc",
) {
  if (process.platform === "win32" && procRoot === "/proc")
    return discoverWindowsEndpoint(profile);
  const matches = new Set();
  for (const pid of await readdir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    let args;
    try {
      args = (await readFile(join(procRoot, pid, "cmdline"), "utf8")).split(
        "\0",
      );
    } catch {
      continue;
    }
    if (
      !/^(chrome|chromium|chromium-browser|google-chrome)$/.test(
        posix.basename(args[0] ?? ""),
      )
    )
      continue;
    if (args.some((a) => a.startsWith("--type="))) continue;
    if (!args.includes(`--user-data-dir=${posix.resolve(profile)}`)) continue;
    const port = args
      .find((a) => a.startsWith("--remote-debugging-port="))
      ?.split("=")[1];
    if (port && /^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)
      matches.add(`http://127.0.0.1:${port}`);
  }
  if (matches.size !== 1)
    throw Error(
      "Expected exactly one initialized AgentBay browser with the configured profile. Initialize the browser first, or inject CUA_BROWSER_CDP_URL explicitly.",
    );
  return [...matches][0];
}
