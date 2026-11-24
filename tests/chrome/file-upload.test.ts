import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCUA } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";

test(
  "file inputs: bytes reach server, events, iframe/ref/hidden, clear and pre-dispatch rejection",
  {
    skip: process.env.CUA_REAL_CHROME !== "1",
    timeout: 60000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-upload-"));
    const first = join(root, "成本 卡.csv");
    const second = join(root, "second.txt");
    const large = join(root, "large.bin");
    const content = "sku,quantity\nCUA-TEST,1\n";
    await writeFile(first, content);
    await writeFile(second, "second file");
    const sparse = await open(large, "w");
    await sparse.truncate(50 * 1024 * 1024 + 1);
    await sparse.close();
    let received = "";
    const server = createServer(async (req, res) => {
      if (req.url === "/upload") {
        for await (const chunk of req) received += chunk.toString();
        res.end("received");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        req.url === "/frame"
          ? '<input id="frame-file" aria-label="Frame file" type="file">'
          : `<!doctype html><title>File upload fixture</title>
        <input id="single" aria-label="Single file" type="file">
        <input id="multi" type="file" multiple>
        <input id="hidden" type="file" style="display:none">
        <input id="disabled" type="file" disabled><input id="directory" type="file" webkitdirectory>
        <input id="text"><input class="ambiguous" type="file"><input class="ambiguous" type="file">
        <iframe src="http://localhost:${(server.address() as any).port}/frame"></iframe>
        <button id="send">Upload</button><output></output>
        <script>window.events=[];single.addEventListener('input',()=>events.push('input'));single.addEventListener('change',()=>events.push('change'));
        send.onclick=async()=>{const data=new FormData();data.append('file',single.files[0]);document.querySelector('output').textContent=await(await fetch('/upload',{method:'POST',body:data})).text()};</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    let denyUploads = false;
    const cua = createCUA({
      browser: new LocalBrowserProvider({ channel: "chrome", headless: true }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
      operationTimeoutMs: 10000,
      policy: {
        async check(_url, context) {
          if (denyUploads && context.kind === "actions.setInputFiles") {
            const { operationError } = await import("@cua/contracts");
            throw operationError("POLICY_BLOCKED");
          }
        },
      },
    });
    try {
      const browser = await cua.connect();
      const tab = await browser.tabs.create({
        url: `http://127.0.0.1:${(server.address() as any).port}`,
      });
      await tab.locator("#single").setInputFiles(first);
      assert.deepEqual(
        await tab.evaluate(async () => {
          const f = (document.querySelector("#single") as HTMLInputElement)
            .files![0];
          return {
            name: f.name,
            type: f.type,
            text: await f.text(),
            events: (window as any).events,
          };
        }),
        {
          name: "成本 卡.csv",
          type: "text/csv",
          text: content,
          events: ["input", "change"],
        },
      );
      await tab.locator("#send").click();
      await tab.waitForFunction(
        () => document.querySelector("output")!.textContent === "received",
      );
      assert.ok(
        received.includes(content),
        "the server receives actual file bytes",
      );
      await tab.actions.setInputFiles(tab.locator("#multi").target, [
        first,
        second,
      ]);
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("#multi") as HTMLInputElement).files!
              .length,
        ),
        2,
      );
      await tab.locator("#hidden").setInputFiles(first);
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("#hidden") as HTMLInputElement).files![0]
              .size,
        ),
        Buffer.byteLength(content),
      );
      const snapshot = await tab.ax.snapshot({ full: true });
      const ref = snapshot.nodes.find(
        (n) => n.name === "Frame file" && n.ref,
      )?.ref;
      assert.ok(ref);
      await tab.actions.setInputFiles(ref, first);
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("input") as HTMLInputElement).files![0]
              .name,
          undefined,
          { frameId: ref.frameId },
        ),
        "成本 卡.csv",
      );
      await tab
        .locator("#frame-file", { frameId: ref.frameId })
        .setInputFiles([]);
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("input") as HTMLInputElement).files!.length,
          undefined,
          { frameId: ref.frameId },
        ),
        0,
      );
      await tab.evaluate(
        () => {
          const el = document.querySelector("input")!;
          el.replaceWith(el.cloneNode());
        },
        undefined,
        { frameId: ref.frameId },
      );
      await assert.rejects(tab.actions.setInputFiles(ref, first), {
        code: "REF_STALE",
      });
      for (const [selector, paths, code] of [
        ["#single", "relative.csv", "INVALID_ARGUMENT"],
        ["#single", join(root, "missing.csv"), "INVALID_ARGUMENT"],
        ["#single", root, "INVALID_ARGUMENT"],
        ["#single", large, "INVALID_ARGUMENT"],
        ["#single", [first, second], "INVALID_ARGUMENT"],
        ["#multi", Array(21).fill(first), "INVALID_ARGUMENT"],
        ["#text", first, "ACTION_UNSUPPORTED_FOR_TARGET"],
        ["#directory", first, "ACTION_UNSUPPORTED_FOR_TARGET"],
        ["#disabled", first, "TARGET_NOT_ACTIONABLE"],
        [".ambiguous", first, "TARGET_NOT_ACTIONABLE"],
        ["#missing", first, "TARGET_NOT_ACTIONABLE"],
      ] as [string, string | string[], string][]) {
        await assert.rejects(tab.locator(selector).setInputFiles(paths), {
          code,
          outcome: "not_executed",
        });
      }
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("#single") as HTMLInputElement).files![0]
              .name,
        ),
        "成本 卡.csv",
        "failed selections leave previous file intact",
      );
      denyUploads = true;
      await assert.rejects(tab.locator("#single").setInputFiles([]), {
        code: "POLICY_BLOCKED",
      });
      denyUploads = false;
      await tab.locator("#single").setInputFiles([]);
      assert.equal(
        await tab.evaluate(
          () =>
            (document.querySelector("#single") as HTMLInputElement).files!
              .length,
        ),
        0,
      );
    } finally {
      await cua.engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
