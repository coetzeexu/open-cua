import { startPreview } from "@cua/preview";
import { discoverEndpoint } from "./discover-endpoint.mjs";
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw Error("Use Node.js 24");
if (!process.env.CUA_BROWSER_CDP_URL) {
  process.env.CUA_BROWSER_CDP_URL = await discoverEndpoint(
    process.env.CUA_BROWSER_PROFILE,
  );
}
const preview = await startPreview({
  host: process.env.CUA_PREVIEW_HOST ?? "127.0.0.1",
  port: Number(process.env.CUA_PREVIEW_PORT ?? 30150),
  token: process.env.CUA_PREVIEW_TOKEN,
});
if (!process.env.CUA_PREVIEW_TOKEN)
  console.log(
    `Preview: http://127.0.0.1:${preview.server.address().port}/#${preview.token}`,
  );
else console.log("Preview ready (authenticated HTTP).");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void preview.close();
  });
