// Local manual acceptance fixture. Uses synthetic credentials only.
// Run: node examples/login-scenario.mjs
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const sessions = new Set();
const shell = (
  title,
  content,
) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
body{font:16px system-ui,sans-serif;margin:40px auto;padding:0 24px;max-width:820px;color:#18232d;background:#f5f6f8}main{padding:28px;background:white;border:1px solid #d4d8de;border-radius:10px}label{display:block;margin:16px 0}input,button{font:inherit;padding:10px}input{display:block;margin-top:6px}button{cursor:pointer}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}.note{color:#59636d}a{color:#1769aa}</style><main>${content}</main></html>`;
const login = (failed = false) =>
  shell(
    "订单后台 · 登录",
    `
<h1>登录订单后台</h1><p>查看订单前需要账号密码登录。</p>
${failed ? '<p role="alert">账号或密码错误，请重新登录。</p>' : ""}
<form method="post" action="/login">
<label for="account">账号</label><input id="account" name="account" autocomplete="username" required>
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p><button type="submit">登录</button></p></form>
<p class="note">本地验收环境，只使用提供的测试账号。登录成功后进入订单列表。</p>`,
  );
const orders = [
  ["DEMO-1001", "桌面收纳盒", "待发货", "129.00"],
  ["DEMO-1002", "便携台灯", "已发货", "89.00"],
  ["DEMO-1003", "机械键盘", "待发货", "299.00"],
  ["DEMO-1004", "理线夹套装", "待发货", "30.00"],
];
const redirect = (res, path) => {
  res.writeHead(303, { location: path });
  res.end();
};
const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/html; charset=utf-8");
  const url = new URL(req.url, "http://127.0.0.1");
  const token = /(?:^|;\s*)cua_demo_session=([a-f0-9]+)/.exec(
    req.headers.cookie ?? "",
  )?.[1];
  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    for await (const part of req) {
      body += part;
      if (body.length > 16384) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const values = new URLSearchParams(body);
    if (
      values.get("account") !== "demo" ||
      values.get("password") !== "CuaDemo2026!"
    ) {
      res.writeHead(401);
      res.end(login(true));
      return;
    }
    const session = randomBytes(24).toString("hex");
    sessions.add(session);
    res.setHeader(
      "set-cookie",
      `cua_demo_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
    );
    redirect(res, "/orders");
    return;
  }
  if (req.method === "POST" && url.pathname === "/logout") {
    sessions.delete(token);
    res.setHeader(
      "set-cookie",
      "cua_demo_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
    );
    redirect(res, "/login");
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url.pathname === "/login") {
    res.end(login());
    return;
  }
  if (url.pathname === "/" || url.pathname === "/orders") {
    if (!sessions.has(token)) {
      redirect(res, "/login");
      return;
    }
    const filter = url.searchParams.get("status");
    const filtered =
      filter === "pending"
        ? orders.filter((row) => row[2] === "待发货")
        : orders;
    res.end(
      shell(
        "订单后台 · 订单列表",
        `<h1>订单列表</h1><p role="status">登录成功</p>
<nav><a href="/orders">全部订单</a> · <a href="/orders?status=pending">只看待发货</a></nav>
<table><thead><tr><th>订单号</th><th>商品</th><th>状态</th><th>金额（元）</th></tr></thead><tbody>${filtered.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>
<form method="post" action="/logout"><button>退出登录</button></form>`,
      ),
    );
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
server.listen(Number(process.env.CUA_DEMO_PORT ?? 31987), "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`Login scenario ready: http://127.0.0.1:${port}/orders`);
});
