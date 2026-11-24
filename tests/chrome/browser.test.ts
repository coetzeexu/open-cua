import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCUA } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
const enabled = process.env.CUA_REAL_CHROME === "1";
test(
  "real local Chrome: identity, clone replacement, iframe, screenshot coordinates and dialog",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url === "/frame"
          ? "<button onclick=\"this.textContent='frame clicked'\">Frame action</button>"
          : `<!doctype html><html><title>CUA fixture</title><body><input aria-label="Name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('input').value; window.clicks=(window.clicks||0)+1">Save</button><p id="result"></p><button id="alert" onclick="alert('hello')">Dialog</button><iframe src="http://localhost:${(server.address() as any).port}/frame"></iframe></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    const cua = createCUA({
      browser: new LocalBrowserProvider({ channel: "chrome", headless: true }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
      operationTimeoutMs: 15000,
    });
    try {
      const browser = await cua.connect();
      const tab = await browser.tabs.create({
        url: `http://127.0.0.1:${(server.address() as any).port}`,
      });
      let snapshot = await tab.ax.snapshot();
      assert.equal(snapshot.title, "CUA fixture");
      const ref = snapshot.nodes.find(
        (n) => n.role === "button" && n.name === "Save",
      )?.ref;
      assert.ok(ref);
      await tab.getByRole("textbox", { name: "Name" }).fill("mock model");
      await tab.actions.click(ref);
      await tab.actions.click(ref);
      assert.equal(await tab.evaluate(() => (window as any).clicks), 2);
      assert.equal(
        await tab.evaluate(
          () => document.querySelector("#result")!.textContent,
        ),
        "mock model",
      );
      await tab.evaluate(() => {
        const button = document.querySelector("#save")!;
        button.replaceWith(button.cloneNode(true));
      });
      await assert.rejects(tab.actions.click(ref), { code: "REF_STALE" });
      assert.equal(await tab.evaluate(() => (window as any).clicks), 2);
      snapshot = await tab.ax.snapshot({ full: true });
      const frameRef = snapshot.nodes.find(
        (n) => n.name === "Frame action" && n.role === "button",
      )?.ref;
      assert.ok(frameRef, "cross-origin frame exposes stable identity refs");
      await tab.actions.click(frameRef);
      assert.ok(
        (await tab.ax.snapshot({ full: true })).nodes.some(
          (n) => n.name === "frame clicked",
        ),
      );
      const shot = await tab.screenshot.capture();
      assert.ok(cua.engine.images.get(shot.imageId)!.bytes.length > 100);
      assert.ok(shot.width <= 1568);
      await tab.evaluate(() => window.scrollTo(0, 0));
      await assert.rejects(tab.actions.click(tab.point(shot, 10, 10)), {
        code: "REF_STALE",
      });
      await assert.rejects(
        tab.getByRole("button", { name: "Dialog", exact: true }).click(),
        { code: "INTERRUPTED_BY_DIALOG" },
      );
      const dialog = await tab.dialogs.pending();
      assert.equal(dialog?.message, "hello");
      await assert.rejects(tab.ax.snapshot(), { code: "DIALOG_PENDING" });
      await tab.dialogs.respond(dialog!.id, { accept: true });
      await tab.ax.snapshot();
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      await cua.engine.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
