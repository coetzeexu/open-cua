import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.NODE_TEST_CONTEXT && !process.env.CUA_HISTORY_DIRECTORY) {
  const directory = mkdtempSync(join(tmpdir(), "cua-test-history-"));
  process.env.CUA_HISTORY_DIRECTORY = directory;
  process.once("exit", () =>
    rmSync(directory, { recursive: true, force: true }),
  );
}
