// Synthetic cloud acceptance site. Expected input is supplied as hashes only.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const fieldIds = [
  "name",
  "birth",
  "country",
  "passport",
  "email",
  "phone",
  "password",
];
export function createCloudSecureFormFixture({ hashes, origin }) {
  const matched = new Set();
  let events = 0,
    confirmations = 0;
  const matches = (id, value) =>
    typeof value === "string" &&
    createHash("sha256").update(value).digest("hex") === hashes[id];
  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          matchedFieldIds: fieldIds.filter((id) => matched.has(id)),
          events,
          confirmations,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      ["/observe", "/confirm"].includes(url.pathname)
    ) {
      if (req.headers.origin !== origin) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) {
          res.writeHead(413).end();
          return;
        }
      }
      try {
        if (url.pathname === "/observe") {
          const { id, value } = JSON.parse(body);
          if (!fieldIds.includes(id)) {
            res.writeHead(400).end();
            return;
          }
          events++;
          if (matches(id, value)) matched.add(id);
          else matched.delete(id);
          res.writeHead(204).end();
        } else {
          const values = new URLSearchParams(body);
          if (!fieldIds.every((id) => matches(id, values.get(id)))) {
            res.writeHead(400).end();
            return;
          }
          confirmations++;
          // Deliberately echo in the next URL/title/body to exercise whole-flow protection.
          res
            .writeHead(303, {
              location: `/summary?name=${encodeURIComponent(values.get("name"))}`,
            })
            .end();
        }
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/summary") {
      const name = (url.searchParams.get("name") ?? "").replace(
        /[<>&"']/g,
        "_",
      );
      res.end(`<title>${name}</title><p>${name.toUpperCase()}</p>`);
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>Cloud secure form</title>
<style>body{font:16px sans-serif;padding:80px 20px 20px}label{display:block;margin:8px}button{position:fixed;left:20px;top:20px;width:240px;height:40px}</style>
<form method="post" action="/confirm"><button>Human review complete</button><fieldset><legend>Passenger 1</legend>
<label>Name<input id="name" name="name" required></label>
<label>Birth<input id="birth" name="birth" type="date" required></label>
<label>Country<select id="country" name="country" required><option value="">Choose</option><option value="wrong">CN</option><option value="CN">China</option></select></label>
<label>Passport<input id="passport" name="passport" required></label>
<label>Email<input id="email" name="email" type="email" required></label>
<label>Phone<input id="phone" name="phone" type="tel" required></label>
<label>Password<input id="password" name="password" type="password" required></label>
</fieldset></form><script>document.querySelector('form').addEventListener('change',e=>{if(e.target.name)fetch('/observe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:e.target.name,value:e.target.value})});});</script>`);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  createCloudSecureFormFixture(config).listen(config.port, "0.0.0.0");
}
