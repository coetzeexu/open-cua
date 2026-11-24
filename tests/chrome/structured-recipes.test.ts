import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUAService } from "@cua/service";
import { FileHistoryStore } from "@cua/history";
import { RecipeStore, runRecipe, type RecipeDraft } from "@cua/recipes";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
import { traced } from "../recipe-provenance.js";

test(
  "local Chrome structured inputs: real form submission, activation, different row count, immutable input and preflight rejection",
  { skip: process.env.CUA_REAL_CHROME !== "1", timeout: 90000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cua-structured-"));
    const history = new FileHistoryStore({ directory: join(root, "history") });
    const store = new RecipeStore({ directory: join(root, "recipes") });
    const receipts: any[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/save") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const value = JSON.parse(raw);
        receipts.push(value);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Structured recipe fixture</title><label>Memo<input id="memo"></label><div id="rows"></div><button id="add">Add</button><button id="save">Save</button><output></output><script>
    add.onclick=()=>{const i=rows.children.length;const row=document.createElement('div');row.innerHTML='<input id="code-'+i+'"><input id="quantity-'+i+'" type="number">';rows.appendChild(row)};
    save.onclick=async()=>{const value={memo:memo.value,rows:[...rows.children].map((r)=>({code:r.children[0].value,quantity:Number(r.children[1].value)}))};document.querySelector('output').textContent=JSON.stringify(await(await fetch('/save',{method:'POST',body:JSON.stringify(value)})).json())};</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const providers: LocalBrowserProvider[] = [];
    const service = new CUAService({
      historyStore: history,
      profiles: {
        local: () => {
          const browser = new LocalBrowserProvider({
            channel: "chrome",
            headless: true,
          });
          providers.push(browser);
          return {
            browser,
            capabilities: chromiumCapabilities(),
            targetResolvers: [new ChromiumTargetResolver()],
          };
        },
      },
    });
    const params = {
      url,
      order: {
        memo: "validation",
        rows: [
          { code: "A", quantity: 2.5 },
          { code: "B", quantity: 4 },
        ],
      },
    };
    const script = `var browser=await cua.connect();var tab=await browser.tabs.create({url:params.url});await tab.locator('#memo').fill(params.order.memo);for(var i=0;i<params.order.rows.length;i++){await tab.locator('#add').click();await tab.locator('#code-'+i).fill(params.order.rows[i].code);await tab.locator('#quantity-'+i).fill(String(params.order.rows[i].quantity));}await tab.locator('#save').click();await tab.waitForFunction(()=>!!document.querySelector('output').textContent);output.json(await tab.evaluate(()=>JSON.parse(document.querySelector('output').textContent)));`;
    const verify = `return (await tab.info()).url.startsWith(params.url) && await tab.evaluate(order=>JSON.stringify(JSON.parse(document.querySelector('output').textContent))===JSON.stringify(order),params.order) && Object.isFrozen(params.order.rows[0]);`;
    try {
      const source = await service.createSession({
        goal: "Structured fixture source",
      });
      const execution = await service.execute({
        sessionId: source.sessionId,
        code: "var params=" + JSON.stringify(params) + ";" + script,
      });
      assert.equal(execution.status, "succeeded", JSON.stringify(execution));
      history.complete(source.runId, true);
      await service.closeSession({ sessionId: source.sessionId });
      const draft: RecipeDraft = {
        name: "structured-fixture",
        description: "Structured rows in a local fixture",
        sourceRunId: source.runId,
        preconditions: ["local synthetic fixture"],
        parameters: {
          url: { type: "string", required: true },
          order: {
            type: "object",
            required: true,
            properties: {
              memo: { type: "string", required: true },
              rows: {
                type: "array",
                required: true,
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    code: { type: "string", required: true },
                    quantity: { type: "number", required: true, minimum: 0.01 },
                  },
                },
              },
            },
          },
        },
        script,
        verify,
      };
      const recipe = store.save(traced(draft, history));
      const validation = await runRecipe({
        service,
        store,
        name: recipe.name,
        version: recipe.version,
        validate: true,
        params,
      });
      assert.equal(validation.passed, true, JSON.stringify(validation));
      store.activate(recipe.name, recipe.version, history);
      const trialParams = {
        url,
        order: {
          memo: "normal-run",
          rows: [
            { code: "C", quantity: 1 },
            { code: "D", quantity: 3.75 },
            { code: "E", quantity: 8 },
          ],
        },
      };
      let modelCalls = 0;
      const trial = await runRecipe({
        service,
        store,
        name: recipe.name,
        params: trialParams,
        model: async () => {
          modelCalls++;
          throw Error("Model should not run");
        },
      });
      assert.equal(trial.passed, true, JSON.stringify(trial));
      assert.equal(modelCalls, 0);
      assert.deepEqual(receipts, [
        params.order,
        params.order,
        trialParams.order,
      ]);
      const before = history.list().length;
      await assert.rejects(
        runRecipe({
          service,
          store,
          name: recipe.name,
          params: {
            url,
            order: { memo: "invalid", rows: [{ code: "F", quantity: "9" }] },
          },
        }),
        /params.order.rows\[0\].quantity/,
      );
      assert.equal(history.list().length, before);
      assert.equal(receipts.length, 3);
      if (process.env.CUA_STRUCTURED_REPORT)
        writeFileSync(
          process.env.CUA_STRUCTURED_REPORT,
          JSON.stringify(
            {
              scope: "local synthetic fixture, not T+ acceptance",
              validation: {
                passed: validation.passed,
                runId: validation.runId,
              },
              trial: { passed: trial.passed, runId: trial.runId },
              receipts,
              modelCalls,
            },
            null,
            2,
          ),
        );
    } finally {
      await service.close();
      for (const p of providers) await p.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
