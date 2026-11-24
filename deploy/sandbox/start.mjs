import { fileURLToPath } from "node:url";
import { discoverEndpoint } from "./discover-endpoint.mjs";
import { loadConfig, start } from "@cua/cli";

try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 18)
    throw Error(
      "Sandbox CUA requires Node.js 24.18 or later in the 24.x line. Use the packaged runtime or install Node 24.18+.",
    );
  if (!process.env.CUA_BROWSER_CDP_URL)
    process.env.CUA_BROWSER_CDP_URL = await discoverEndpoint(
      process.env.CUA_BROWSER_PROFILE,
    );
  const config = fileURLToPath(
    new URL("../../examples/cua.sandbox.json", import.meta.url),
  );
  await start(await loadConfig(process.env.CUA_CONFIG ?? config));
} catch {
  // Endpoint/token-bearing low-level errors must not reach MCP or terminal logs.
  console.error(
    "Sandbox CUA startup failed. Check Node 24, initialized browser, internal endpoint, and configuration. See docs/harness-integration.md.",
  );
  process.exitCode = 1;
}
