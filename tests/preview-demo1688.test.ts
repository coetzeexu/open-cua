import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectionUrl,
  topProducts,
  run1688Demo,
  type DemoTask,
} from "../examples/1688/demo1688.js";
const snapshot =
  '- link "分销选品中心":\n  - /url: https://air.1688.com/app/channel-fe/search/index.html#/result';
const products = [1, 2, 3].map((id) => ({
  title: `欧式灯具${id}`,
  url: `https://detail.1688.com/offer/${id}.html`,
}));
test("demo2 reads the observed selection entry and deduplicates valid offers in page order", () => {
  assert.equal(
    selectionUrl(snapshot),
    "https://air.1688.com/app/channel-fe/search/index.html#/result",
  );
  assert.throws(() =>
    selectionUrl(snapshot.replace("air.1688.com", "example.com")),
  );
  assert.deepEqual(
    topProducts([
      products[0],
      { ...products[0], url: products[0]!.url + "?again=1" },
      { title: "bad", url: "javascript:alert(1)" },
      ...products,
    ]).map((p) => p.rank),
    [1, 2, 3],
  );
  assert.throws(() => topProducts(products.slice(0, 2)));
});
test("takeover between mock cells prevents the next browser message", async () => {
  const abort = new AbortController();
  let calls = 0;
  const task: DemoTask = { status: "running", stage: "", products: [] };
  await assert.rejects(
    run1688Demo({
      task,
      signal: abort.signal,
      progress() {},
      async execute() {
        calls++;
        abort.abort();
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(task.products.length, 0);
  assert.notEqual(task.status, "succeeded");
});
test("demo2 only marks details actually viewed before a blocking page", async () => {
  let calls = 0;
  const task: DemoTask = { status: "running", stage: "", products: [] };
  await assert.rejects(
    run1688Demo({
      task,
      signal: new AbortController().signal,
      progress() {},
      async execute() {
        calls++;
        if (calls === 2) return snapshot;
        if (calls === 5) return products;
        if (calls === 7) throw Error("login required");
      },
    }),
  );
  assert.deepEqual(
    task.products.map((p) => p.viewed),
    [true, false, false],
  );
  assert.notEqual(task.status, "succeeded");
});
