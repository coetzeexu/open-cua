import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
test(
  "real Chrome via stdio MCP: mock model observes, fills, clicks, screenshots and resets",
  { skip: process.env.CUA_REAL_CHROME !== "1", timeout: 60000 },
  async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        "<!doctype html><title>Mock checkout</title><input aria-label=\"Message\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Submit</button><output></output>",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const client = new Client(
      { name: "mock-model", version: "1" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("packages/cli/dist/index.js"), "serve"],
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (d) => stderr.push(String(d)));
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 8);
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      const call = async (code: string, requestId?: string) => {
        let r: any = await client.callTool({
          name: "cua_exec",
          arguments: { code, requestId },
        });
        while (r.structuredContent?.status === "running")
          r = await client.callTool({
            name: "cua_poll",
            arguments: { executionId: r.structuredContent.executionId },
          });
        assert.equal(
          r.structuredContent?.status,
          "succeeded",
          JSON.stringify(r),
        );
        return r;
      };
      let r = await call(
        `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(url)}});output.json(await tab.ax.snapshot());`,
      );
      assert.ok(
        r.content.some(
          (c: any) => c.type === "text" && c.text.includes("Submit"),
        ),
      );
      r = await call(
        'await tab.getByRole("textbox",{name:"Message"}).fill("mock model delivered");await tab.getByRole("button",{name:"Submit"}).click();output.json(await tab.ax.snapshot());',
        "mock-action-1",
      );
      assert.ok(
        r.content.some(
          (c: any) =>
            c.type === "text" && c.text.includes("mock model delivered"),
        ),
      );
      r = await call("output.image(await tab.screenshot.capture());");
      assert.ok(
        r.content.some(
          (c: any) =>
            c.type === "image" &&
            c.mimeType === "image/jpeg" &&
            c.data.length > 100,
        ),
      );
      await client.callTool({ name: "cua_reset", arguments: {} });
      r = await call(
        'var browser=await cua.connect();var tab=(await browser.tabs.list())[0];output.text(await tab.evaluate(()=>document.querySelector("output").textContent));',
      );
      assert.equal(r.content[0].text, "mock model delivered");
      const closed: any = await client.callTool({
        name: "cua_close",
        arguments: {},
      });
      assert.equal(closed.structuredContent.closed, true);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
