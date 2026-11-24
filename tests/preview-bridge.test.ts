import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
const call = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, headers, method, agent: false },
      (res) => {
        let body = "";
        res.on("data", (data) => {
          body += data;
        });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
test("local preview bridge keeps upstream credentials private and rejects cross-site or rebound hosts", async (t) => {
  const { startPreviewBridge } = await import(
    new URL("../deploy/sandbox/bridge.mjs", import.meta.url).href
  );
  let forwarded = 0,
    closed = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, options: any) => {
    forwarded++;
    assert.equal(url.origin, "https://private.test");
    assert.equal(options.headers["X-CUA-Preview-Token"], "private-token");
    assert.equal(options.headers.Origin, undefined);
    return new Response('{"control":"agent"}', {
      headers: { "content-type": "application/json" },
    });
  });
  const server = await startPreviewBridge({
    upstream: "https://private.test",
    token: "private-token",
    port: 0,
    expiresAt: "2099-01-01T00:00:00Z",
    onClose: async () => {
      closed++;
    },
  });
  const port = server.address().port;
  try {
    const state = await call(port, "/api/state");
    assert.equal(state.status, 200);
    assert.equal(JSON.parse(state.body).control, "agent");
    assert.ok(!state.body.includes("private-token"));
    assert.equal(
      (
        await call(
          port,
          "/api/control",
          { Origin: "https://attacker.test" },
          "POST",
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(port, "/api/frame", { "Sec-Fetch-Site": "cross-site" }))
        .status,
      403,
    );
    assert.equal(
      (await call(port, "/api/state", { Host: "rebound.test" })).status,
      403,
    );
    assert.equal(forwarded, 1);
    const result = await call(port, "/__demo/close", {}, "POST");
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).closed, true);
    assert.equal(closed, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
