// Persistent, loopback-only synthetic orders. No real account or remote services.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function ordersForDate(date) {
  return [1, 2, 3].map((n) => ({
    id: `TEST-${date}-${n}`,
    date,
    amountCents: n * 1250,
  }));
}
export function createOrdersFixture(statePath) {
  mkdirSync(dirname(statePath), { recursive: true });
  let state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { version: "v1", executionCount: 0, receipts: [], changes: [] };
  const save = (next) => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    renameSync(`${statePath}.tmp`, statePath);
    state = next;
  };
  if (!existsSync(statePath)) save(state);
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("cache-control", "no-store");
    const json = (code, data) => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && url.pathname === "/status") {
        return json(200, {
          ...state,
          countsByDate: Object.fromEntries(
            state.receipts.map((r) => [
              r.date,
              state.receipts.filter((x) => x.date === r.date).length,
            ]),
          ),
        });
      }
      if (
        req.method === "POST" &&
        ["/admin/version", "/exports"].includes(url.pathname)
      ) {
        // Browser posts must be same-origin; CLI admin calls have no Origin.
        if (
          req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`
        )
          return json(403, { error: "origin" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return json(413, { error: "body too large" });
        }
        const input = JSON.parse(body);
        if (url.pathname === "/admin/version") {
          if (!["v1", "v2"].includes(input.version))
            return json(400, { error: "invalid version" });
          save({
            ...state,
            version: input.version,
            changes: [
              ...state.changes,
              {
                from: state.version,
                to: input.version,
                time: new Date().toISOString(),
                executionCount: state.executionCount,
              },
            ],
          });
          return json(200, {
            version: state.version,
            executionCount: state.executionCount,
          });
        }
        const date = input.date;
        if (
          typeof date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
        )
          return json(400, { error: "invalid date" });
        const orders = ordersForDate(date);
        const csv =
          "order_id,date,amount_cents\n" +
          orders.map((o) => `${o.id},${o.date},${o.amountCents}`).join("\n") +
          "\n";
        const sequence = state.executionCount + 1;
        const receipt = {
          receiptId: `EXPORT-${String(sequence).padStart(4, "0")}`,
          date,
          sequence,
          rowCount: orders.length,
          totalCents: orders.reduce((a, o) => a + o.amountCents, 0),
          sha256: createHash("sha256").update(csv).digest("hex"),
          version: state.version,
          time: new Date().toISOString(),
          orderIds: orders.map((o) => o.id),
          csv,
        };
        save({
          ...state,
          executionCount: sequence,
          receipts: [...state.receipts, receipt],
        });
        return json(200, receipt);
      }
      if (req.method === "GET" && url.pathname.startsWith("/files/")) {
        const receipt = state.receipts.find(
          (r) => url.pathname === `/files/${r.receiptId}.csv`,
        );
        if (!receipt) return json(404, { error: "receipt not found" });
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="orders-${receipt.date}.csv"`,
        });
        return res.end(receipt.csv);
      }
      if (req.method !== "GET" || url.pathname !== "/")
        return json(404, { error: "not found" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>CUA synthetic order exports</title>
<style>body{font:17px system-ui;max-width:880px;margin:48px auto;padding:20px}label,input,button{font:inherit}input,button{padding:10px;margin:8px}pre{white-space:pre-wrap;background:#eee;padding:16px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #ccc}</style>
<h1>Test order exports</h1><p>Local synthetic data only. Page version: <strong>${state.version}</strong></p>
<form><label for="date">Order date</label><input id="date" name="date" placeholder="YYYY-MM-DD" required pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"><button type="submit">${state.version === "v1" ? "Export orders" : "Generate order CSV"}</button></form>
<p id="message" role="status">Choose a date to generate 3 test orders.</p><section aria-label="Export receipt"><pre id="receipt">No export yet</pre><a id="download" hidden>Download CSV</a></section>
<script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const button=document.querySelector('button');button.disabled=true;document.querySelector('#message').textContent='Exporting…';try{const r=await fetch('/exports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:document.querySelector('#date').value})});const data=await r.json();if(!r.ok)throw Error(data.error);document.querySelector('#receipt').textContent=JSON.stringify(data,null,2);document.querySelector('#message').textContent='Export complete: '+data.receiptId;const link=document.querySelector('#download');link.href='/files/'+data.receiptId+'.csv';link.hidden=false;}catch(e){document.querySelector('#message').textContent='Export failed: '+e.message;}finally{button.disabled=false;}});</script></html>`);
    } catch (error) {
      json(400, { error: error.message });
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const statePath = resolve(
    process.argv[2] ?? "outputs/recipe-orders/state.json",
  );
  const port = Number(process.argv[3] ?? 43187);
  const server = createOrdersFixture(statePath);
  server.listen(port, "127.0.0.1", () =>
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}`,
        statePath,
        pid: process.pid,
      }),
    ),
  );
}
