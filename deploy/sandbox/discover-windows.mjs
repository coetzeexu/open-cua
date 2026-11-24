import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function windowsEndpoint(processes, profile) {
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const profileFlag = new RegExp(
    `(?:^|\\s)--user-data-dir=(?:"${escaped}"|${escaped})(?:\\s|$)`,
  );
  const matches = processes.filter(
    (p) =>
      p.Name?.toLowerCase() === "chrome.exe" &&
      typeof p.CommandLine === "string" &&
      !/(?:^|\s)--type=/.test(p.CommandLine) &&
      profileFlag.test(p.CommandLine),
  );
  const port =
    matches.length === 1
      ? /(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)/.exec(
          matches[0].CommandLine,
        )?.[1]
      : undefined;
  if (!port || Number(port) < 1 || Number(port) > 65535)
    throw Error(
      "Expected exactly one initialized sandbox Chrome. Inject CUA_BROWSER_CDP_URL explicitly if the image uses a different browser profile.",
    );
  return `http://127.0.0.1:${port}`;
}

export async function discoverWindowsEndpoint(profile) {
  const script =
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object Name,CommandLine) | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 15000, windowsHide: true },
  );
  const rows = JSON.parse(stdout || "[]");
  return windowsEndpoint(Array.isArray(rows) ? rows : [rows], profile);
}
