import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
// @ts-expect-error The standalone fixture is executable JavaScript.
import { createOrdersFixture } from "../scripts/fixtures/recipe-orders.mjs";
import type { Server } from "node:http";

test("order fixture persists receipts and version, counts repeats, and serves exact CSV", async () => {
  const root = mkdtempSync(join(tmpdir(), "recipe-orders-"));
  let server: Server;
  const start = async () => {
    server = createOrdersFixture(join(root, "state.json"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  let url = await start();
  const post = (path: string, data: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await post("/exports", { date: "2026-02-30" })).status, 400);
    const first = await (await post("/exports", { date: "2026-10-01" })).json();
    assert.equal(first.sequence, 1);
    assert.equal(first.rowCount, 3);
    const csv = await (
      await fetch(url + `/files/${first.receiptId}.csv`)
    ).text();
    assert.equal(csv, first.csv);
    assert.equal(createHash("sha256").update(csv).digest("hex"), first.sha256);
    assert.equal((await post("/admin/version", { version: "v2" })).status, 200);
    await stop();
    url = await start();
    assert.match(await (await fetch(url)).text(), /Generate order CSV/);
    const second = await (
      await post("/exports", { date: "2026-10-01" })
    ).json();
    assert.equal(second.sequence, 2);
    assert.equal(second.version, "v2");
    const status = await (await fetch(url + "/status")).json();
    assert.equal(status.executionCount, 2);
    assert.equal(status.countsByDate["2026-10-01"], 2);
    assert.equal(status.receipts[0].receiptId, first.receiptId);
    assert.equal(status.changes.length, 1);
    assert.equal((await fetch(url + "/files/missing.csv")).status, 404);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
