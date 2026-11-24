import { createServer } from "node:http";

// Local viewing bridge. Upstream port links and credentials stay on this process.
export async function startPreviewBridge({
  upstream,
  token,
  port = 4317,
  onClose,
  expiresAt,
}) {
  const base = new URL(upstream);
  if (base.protocol !== "https:")
    throw Error("The remote preview link must use HTTPS");
  const server = createServer((req, res) => {
    void (async () => {
      const boundPort = server.address()?.port ?? port;
      const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
      if (
        !allowed.includes(req.headers.host) ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin &&
          !allowed.map((h) => "http://" + h).includes(req.headers.origin))
      ) {
        res.writeHead(403);
        res.end("Origin rejected");
        return;
      }
      const local = new URL(req.url, "http://127.0.0.1");
      if (local.pathname === "/__demo/info") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ expiresAt }));
        return;
      }
      if (local.pathname === "/__demo/close" && req.method === "POST") {
        await onClose?.();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ closed: true }));
        setTimeout(() => server.close(), 100);
        return;
      }
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 16384) throw Error("Request too large");
      }
      const remote = new URL(base);
      remote.pathname = base.pathname.replace(/\/$/, "") + local.pathname;
      const response = await fetch(remote, {
        method: req.method,
        headers: {
          "X-CUA-Preview-Token": token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body || undefined,
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      });
      for (const name of [
        "content-type",
        "cache-control",
        "x-frame-id",
        "x-frame-width",
        "x-frame-height",
        "content-security-policy",
        "x-content-type-options",
      ]) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.statusCode = response.status;
      res.setHeader("Referrer-Policy", "no-referrer");
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "沙箱连接不可用，演示可能已结束。" }));
      } else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
