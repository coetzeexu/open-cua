import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("sandbox discovery selects the initialized profile and refuses ambiguous processes", async () => {
  const { discoverEndpoint } = await import(
    new URL("../deploy/sandbox/discover-endpoint.mjs", import.meta.url).href
  );
  const proc = await mkdtemp(join(tmpdir(), "cua-proc-"));
  const profile = "/tmp/agentbay_browser";
  const processEntry = async (pid: string, args: string[]) => {
    await mkdir(join(proc, pid));
    await writeFile(join(proc, pid, "cmdline"), args.join("\0") + "\0");
  };
  try {
    await processEntry("1", [
      "/bin/sh",
      "chrome --user-data-dir=/tmp/agentbay_browser --remote-debugging-port=1111",
    ]);
    await processEntry("2", [
      "/opt/chrome",
      "--type=renderer",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=2222",
    ]);
    await processEntry("3", [
      "/opt/chrome",
      "--user-data-dir=/tmp/other",
      "--remote-debugging-port=3333",
    ]);
    await processEntry("4", [
      "/opt/chrome",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
    ]);
    await assert.rejects(discoverEndpoint(profile, proc), /exactly one/);
    await processEntry("5", [
      "/opt/google/chrome/chrome",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=42213",
    ]);
    assert.equal(
      await discoverEndpoint(profile, proc),
      "http://127.0.0.1:42213",
    );
    await processEntry("6", [
      "/opt/chromium",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=43210",
    ]);
    await assert.rejects(discoverEndpoint(profile, proc), /exactly one/);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("Windows discovery handles quoted profile paths and refuses multiple main browsers", async () => {
  const { windowsEndpoint } = await import(
    new URL("../deploy/sandbox/discover-windows.mjs", import.meta.url).href
  );
  const profile = "C:\\Users\\Test User\\Chrome";
  const main = {
    Name: "chrome.exe",
    CommandLine: `"C:\\Chrome\\chrome.exe" --user-data-dir="${profile}" --remote-debugging-port=42100`,
  };
  const child = { ...main, CommandLine: main.CommandLine + " --type=renderer" };
  assert.equal(
    windowsEndpoint([main, child], profile),
    "http://127.0.0.1:42100",
  );
  assert.throws(() => windowsEndpoint([main, main], profile), /exactly one/);
  assert.throws(
    () => windowsEndpoint([main], profile + "-other"),
    /exactly one/,
  );
  assert.throws(
    () =>
      windowsEndpoint(
        [{ ...main, CommandLine: main.CommandLine.replace("42100", "99999") }],
        profile,
      ),
    /exactly one/,
  );
});
