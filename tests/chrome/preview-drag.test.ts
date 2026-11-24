import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalBrowserProvider } from "@cua/browser-local";
import { startPreview } from "@cua/preview";
import type { ChromiumBinding } from "@cua/browser-chromium";

test(
  "preview streams a human drag through scaled image and disables native image dragging",
  { skip: process.env.CUA_REAL_CHROME !== "1" },
  async () => {
    const provider = new LocalBrowserProvider({
      channel: "chrome",
      headless: true,
    });
    let binding: ChromiumBinding;
    const preview = await startPreview({
      port: 0,
      provider: {
        descriptor: provider.descriptor,
        resourceKey: provider.resourceKey,
        async connect(context) {
          binding = await provider.connect(context);
          return binding;
        },
      },
    });
    const address = preview.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      "X-CUA-Preview-Token": preview.token,
      "Content-Type": "application/json",
    };
    const post = async (path: string, data: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      });
    try {
      const remote = binding!.context
        .pages()
        .find((p) => p.url().startsWith("data:"))!;
      await remote.setContent(
        '<style>body{margin:80px}input{width:500px}button{margin:50px}</style><input aria-label="slider" type="range" min="0" max="100" value="0"><button onclick="this.textContent=\'clicked\'">test</button>',
      );
      const ui = await binding!.context.newPage();
      await ui.setViewportSize({ width: 1440, height: 900 });
      await ui.goto(base + "/#" + preview.token);
      await ui.waitForFunction(
        () =>
          document.querySelector<HTMLImageElement>("#screen")!.naturalWidth > 0,
      );
      assert.equal(
        (await post("/api/control", { action: "take" })).status,
        200,
      );
      await ui.waitForFunction(
        () => document.querySelector("#mode")!.textContent === "人工控制",
      );
      const rect = await ui.locator("#screen").boundingBox();
      assert.ok(rect);
      const viewport = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      const scale = Math.min(
        rect.width / viewport.width,
        rect.height / viewport.height,
      );
      const offset = {
        x: rect.x + (rect.width - viewport.width * scale) / 2,
        y: rect.y + (rect.height - viewport.height * scale) / 2,
      };
      const slider = await remote.locator("input").boundingBox();
      assert.ok(slider);
      const y = offset.y + (slider.y + slider.height / 2) * scale;
      await ui.mouse.move(offset.x + (slider.x + 8) * scale, y);
      await ui.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await ui.mouse.move(
          offset.x + (slider.x + 8 + ((slider.width - 16) * i) / 12) * scale,
          y,
        );
        await new Promise((r) => setTimeout(r, 90));
      }
      // The slider moves before mouseup: this is a live drag, not replay on release.
      await remote.waitForFunction(
        () =>
          Number(document.querySelector<HTMLInputElement>("input")!.value) > 90,
      );
      await ui.mouse.up();
      assert.equal(
        await ui.locator("#screen").getAttribute("draggable"),
        "false",
      );
      const button = await remote.locator("button").boundingBox();
      assert.ok(button);
      await ui.mouse.click(
        offset.x + (button.x + button.width / 2) * scale,
        offset.y + (button.y + button.height / 2) * scale,
      );
      await remote.getByRole("button", { name: "clicked" }).waitFor();
      assert.equal((await post("/api/scenario", {})).status, 404);
    } finally {
      await preview.close();
      await provider.shutdown();
    }
  },
);
