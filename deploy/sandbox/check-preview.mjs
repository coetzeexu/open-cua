import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectChromiumEndpoint } from "@cua/browser-chromium";
const url = process.env.CUA_PREVIEW_URL ?? "http://127.0.0.1:4317";
const endpoint =
  process.env.CUA_PREVIEW_TEST_CDP_URL ?? process.env.CUA_BROWSER_CDP_URL;
assert.ok(
  endpoint,
  "Inject a CDP endpoint for the test verifier; it is not logged.",
);
const directory = resolve(
  process.env.CUA_PREVIEW_EVIDENCE ?? "artifacts/preview/verified",
);
await mkdir(directory, { recursive: true });
const report = { time: new Date().toISOString(), checks: [], success: false };
const headers = process.env.CUA_PREVIEW_TOKEN
  ? { "X-CUA-Preview-Token": process.env.CUA_PREVIEW_TOKEN }
  : {};
const request = (path, body, extra = {}) =>
  fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
const api = async (path, body) => {
  const r = await request(path, body);
  assert.equal(r.status, 200, `HTTP ${r.status}: ${path}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = async (name) => {
  const r = await request("/api/frame");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.ok(bytes.length > 100);
  if (name) await writeFile(resolve(directory, name), bytes);
  return {
    frameId: Number(r.headers.get("x-frame-id")),
    width: Number(r.headers.get("x-frame-width")),
    height: Number(r.headers.get("x-frame-height")),
  };
};
const browser = await connectChromiumEndpoint(endpoint, { mode: "attach" });
let page;
try {
  const state = await api("/api/state");
  report.platform = state.platform;
  report.node = state.node;
  report.browser = state.browser;
  report.sessionId = state.sessionId;
  assert.equal(
    state.platform,
    process.env.CUA_EXPECT_PLATFORM ?? process.platform,
  );
  assert.match(state.node, /^v24\./);
  report.checks.push(
    `${state.platform} service with packaged Node 24 and sandbox provider`,
  );
  for (const candidate of browser.context.pages())
    if ((await candidate.title()) === "CUA 演示工作台") page = candidate;
  assert.ok(page, "Dedicated preview fixture must exist");
  assert.equal(
    (
      await request(
        "/api/control",
        { action: "take" },
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  report.checks.push("cross-origin control rejected");
  await frame("initial.jpg");
  report.checks.push("live JPEG and viewport metadata");
  const input = async (data) =>
    api("/api/input", { ...(await frame()), ...data });
  assert.equal(
    (
      await request("/api/input", {
        ...(await frame()),
        type: "text",
        text: "blocked",
      })
    ).status,
    409,
  );
  await api("/api/demo", {});
  const startedDeadline = Date.now() + 8000;
  while (
    Number(await page.locator("#count").textContent()) === 0 &&
    Date.now() < startedDeadline
  )
    await sleep(200);
  assert.ok(Number(await page.locator("#count").textContent()) > 0);
  await api("/api/control", { action: "take" });
  assert.equal((await api("/api/state")).control, "human");
  const count = await page.locator("#count").textContent();
  await sleep(1800);
  assert.equal(await page.locator("#count").textContent(), count);
  assert.equal((await request("/api/demo", {})).status, 409);
  report.checks.push(
    "takeover cancels active mock model; no trailing submits; model execution blocked during human control",
  );
  const box = await page
    .getByRole("textbox", { name: "输入内容" })
    .boundingBox();
  await input({
    type: "click",
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  await input({ type: "selectAll" });
  const value = "人工接管验证 / private input";
  await input({ type: "text", text: value });
  const button = await page
    .getByRole("button", { name: "提交", exact: true })
    .boundingBox();
  await input({
    type: "click",
    x: button.x + button.width / 2,
    y: button.y + button.height / 2,
  });
  assert.equal(
    await page.getByRole("textbox", { name: "输入内容" }).inputValue(),
    value,
  );
  assert.match(await page.getByRole("status").textContent(), /人工接管验证/);
  const humanState = await api("/api/state");
  assert.ok(!JSON.stringify(humanState).includes(value));
  await frame("manual-control.jpg");
  report.checks.push(
    "human mouse click, select-all, text insertion and submit succeed; input absent from activity logs",
  );
  const oldFrame = await frame();
  await page.reload();
  assert.equal(
    (await request("/api/input", { ...oldFrame, type: "text", text: "stale" }))
      .status,
    409,
  );
  report.checks.push("stale frame input rejected after navigation");
  await api("/api/control", { action: "interrupt" });
  assert.equal((await api("/api/state")).control, "paused");
  assert.equal(
    (
      await request("/api/input", {
        ...(await frame()),
        type: "text",
        text: "blocked",
      })
    ).status,
    409,
  );
  await api("/api/control", { action: "resume" });
  assert.equal((await api("/api/state")).control, "agent");
  report.checks.push(
    "interrupt remains paused; explicit resume returns control to model",
  );
  await api("/api/demo", {});
  const deadline = Date.now() + 40000;
  while ((await api("/api/state")).active && Date.now() < deadline) {
    await frame();
    await sleep(700);
  }
  const done = await api("/api/state");
  assert.equal(done.active, false);
  assert.equal(done.lastExecution.status, "succeeded");
  assert.equal(await page.locator("#count").textContent(), "12");
  report.checks.push(
    "model completes 12 real input/click iterations after resume while preview remains responsive",
  );
  await page.reload();
  await frame("ready.jpg");
  report.success = true;
} finally {
  await browser.close();
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Sandbox preview test ${report.success ? "PASSED" : "FAILED"}: ${directory}`,
  );
}
