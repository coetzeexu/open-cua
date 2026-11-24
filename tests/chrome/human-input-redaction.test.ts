import { test } from "node:test";
import assert from "node:assert/strict";
import { createCUA } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
const enabled = process.env.CUA_REAL_CHROME === "1";

test(
  "real Chrome: human input in ordinary fields is redacted after return, including cached AX and text descendants",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const cua = createCUA({
      browser: new LocalBrowserProvider({ channel: "chrome", headless: true }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
    });
    const html = `<!doctype html><title>Human input regression</title>
    <label>Plain<input id=plain autocomplete=off></label>
    <label>Notes<textarea id=notes></textarea></label>
    <div id=editor contenteditable=true role=textbox aria-label=Editor></div>
    <div id=bare contenteditable=true></div>
    <div id=shadow></div>
    <input id=dynamic aria-label=Dynamic value=dynamic-private-value>
    <button onclick="document.querySelector('output').textContent=++window.count">Count</button><output>0</output>
    <script>window.count=0;document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow<input id=shadowInput></label>'</script>`;
    let view: Awaited<ReturnType<typeof cua.engine.openHumanView>> | undefined;
    try {
      let browser = await cua.connect();
      let tab = await browser.tabs.create({
        url: "data:text/html," + encodeURIComponent(html),
      });
      const tabId = tab.id;
      // Seed cached references before field classification changes or human input arrives.
      await tab.ax.snapshot({ full: true });
      await tab.evaluate(() => {
        (document.querySelector("#dynamic") as HTMLInputElement).type =
          "password";
      });
      const dynamic = await tab.ax.snapshot({ full: true });
      assert.equal(
        dynamic.nodes.find((n) => n.name === "Dynamic")?.value,
        "[redacted]",
      );
      assert.ok(
        !JSON.stringify(dynamic.nodes).includes("dynamic-private-value"),
      );
      view = await cua.engine.openHumanView(tabId);
      const secrets = [
        "private-plain-872",
        "private-notes-391",
        "private-editor-405",
        "private-shadow-216",
        "private-bare-634",
      ];
      for (const [i, selector] of [
        "#plain",
        "#notes",
        "#editor",
        "#shadowInput",
        "#bare",
      ].entries()) {
        await tab.locator(selector).click();
        const frame = await view.capture();
        await view.input({ type: "text", text: secrets[i], frameId: frame.id });
      }
      // Same protection transition used by Service.resumeSession after human control.
      await cua.engine.protectHumanPages();
      browser = await cua.connect();
      tab = await browser.tabs.get(tabId);
      const full = await tab.ax.snapshot({ full: true });
      for (const secret of secrets)
        assert.ok(!JSON.stringify(full).includes(secret));
      for (const label of ["Plain", "Notes", "Editor", "Shadow"]) {
        const node = full.nodes.find(
          (n) => n.name === label && n.role === "textbox",
        );
        assert.ok(node, label);
        assert.equal(node.sensitive, true, label);
        if (node.value) assert.equal(node.value, "[redacted]", label);
      }
      await tab.getByRole("button", { name: "Count", exact: true }).click();
      const diff = await tab.ax.snapshot({ since: full.observationId });
      for (const secret of secrets)
        assert.ok(!JSON.stringify(diff).includes(secret));
      assert.ok(diff.nodes.some((n) => n.name === "1"));
      cua.engine.reset();
      browser = await cua.connect();
      tab = await browser.tabs.get(tabId);
      for (const secret of secrets)
        assert.ok(
          !JSON.stringify(await tab.ax.snapshot({ full: true })).includes(
            secret,
          ),
        );
      await assert.rejects(
        tab.evaluate(() => 1),
        { code: "CREDENTIAL_PROTECTED" },
      );
      // Navigation to a new document lifts protection; ordinary public values remain useful.
      await tab.goto(
        "data:text/html,<label>Public<input value=public-value></label>",
      );
      assert.ok(
        JSON.stringify(await tab.ax.snapshot({ full: true })).includes(
          "public-value",
        ),
      );
    } finally {
      await view?.close();
      await cua.engine.close();
    }
  },
);
