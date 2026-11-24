// Local native-host acceptance fixture. Use invented test data, never real identity data.
// Run: node examples/secure-form-scenario.mjs (loopback only, ephemeral port by default).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function createSecureFormScenario() {
  const filled = new Set();
  let inputEvents = 0,
    confirmations = 0;
  const ids = [
    "name",
    "birth",
    "country",
    "passport",
    "email",
    "phone",
    "password",
  ];
  const valid = (id, value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    (id === "birth"
      ? /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
      : id === "country"
        ? ["CN", "JP", "SG"].includes(value)
        : id === "email"
          ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          : ids.includes(id));
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          filledFieldIds: ids.filter((id) => filled.has(id)),
          inputEvents,
          confirmations,
          complete: filled.size === ids.length,
        }),
      );
      return;
    }
    if (req.method === "POST" && ["/observe", "/confirm"].includes(path)) {
      if (req.headers.origin !== `http://${req.headers.host}`) {
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
        if (path === "/observe") {
          const data = JSON.parse(body);
          if (!ids.includes(data.id)) {
            res.writeHead(400).end();
            return;
          }
          inputEvents++;
          if (valid(data.id, data.value)) filled.add(data.id);
          else filled.delete(data.id);
          // Discard values. Only fixed field ids and counters survive this request.
          res.writeHead(204).end();
        } else {
          const values = new URLSearchParams(body);
          const complete = ids.every((id) => valid(id, values.get(id)));
          if (complete) confirmations++;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            `<meta charset="utf-8"><h1>${complete ? "人工检查提交成功" : "请返回补全字段"}</h1><p>测试站点不保存输入资料。</p>`,
          );
        }
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    if (req.method !== "GET" || path !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>安全表单验收</title>
<style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 20px}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:8px}input,select{display:block;width:90%}fieldset{margin:16px 0}button{cursor:pointer}</style>
<h1>安全表单 · 原生宿主验收</h1><p>只填写虚构测试资料。填入动作不点击下方按钮，请在人工检查后提交。</p>
<form method="post" action="/confirm"><fieldset><legend>乘客 1 · 测试资料</legend>
<label>姓名<input id="name" name="name" required></label>
<label>出生日期<input id="birth" name="birth" type="date" required></label>
<label>国家<select id="country" name="country" required><option value="">请选择</option><option value="CN">中国</option><option value="JP">日本</option><option value="SG">新加坡</option></select></label>
<label>测试证件号<input id="passport" name="passport" required></label>
<label>邮箱<input id="email" name="email" type="email" required></label>
<label>电话<input id="phone" name="phone" type="tel" required></label>
<label>测试口令<input id="password" name="password" type="password" required></label>
</fieldset><button type="submit">人工检查完成，提交测试</button></form>
<script>document.querySelector('form').addEventListener('change',e=>{if(e.target.name)fetch('/observe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:e.target.name,value:e.target.value})});});</script></html>`);
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createSecureFormScenario();
  server.listen(
    Number(process.env.CUA_SECURE_FORM_PORT ?? 0),
    "127.0.0.1",
    () => {
      console.log(
        JSON.stringify({
          url: `http://127.0.0.1:${server.address().port}/`,
          statusPath: "/status",
          storesPrivateValues: false,
        }),
      );
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
