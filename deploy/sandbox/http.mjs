import { fileURLToPath } from "node:url";
import { discoverEndpoint } from "./discover-endpoint.mjs";
import { loadConfig, startHttp, httpOptionsFromEnv } from "@cua/cli";
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 18) throw Error("Use packaged Node 24.18+");
  const options = httpOptionsFromEnv();
  if (!options.token) throw Error("Missing CUA_MCP_TOKEN");
  if (!process.env.CUA_BROWSER_CDP_URL)
    process.env.CUA_BROWSER_CDP_URL = await discoverEndpoint(
      process.env.CUA_BROWSER_PROFILE,
    );
  const path =
    process.env.CUA_CONFIG ??
    fileURLToPath(new URL("../../examples/cua.sandbox.json", import.meta.url));
  await startHttp(await loadConfig(path), options);
  console.log("CUA HTTP MCP ready at /mcp (Bearer required).");
} catch {
  console.error(
    "HTTP MCP startup failed. Check Node 24, token, browser initialization, port and allowed hosts. See docs/harness-integration.md.",
  );
  process.exitCode = 1;
}
