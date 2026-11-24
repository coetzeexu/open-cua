import { traced } from "../recipe-provenance.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CUAService } from "@cua/service";
import { FileHistoryStore } from "@cua/history";
import {
  RecipeStore,
  runRecipe,
  requestAssistance,
  type RecipeDraft,
} from "@cua/recipes";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";

test(
  "local Chrome: record, distill draft, validate, execute with new parameters, retain failed scene, repair without replay, run new version via CLI",
  { skip: process.env.CUA_REAL_CHROME !== "1", timeout: 90000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cua-recipes-chrome-"));
    const history = new FileHistoryStore({
      directory: join(root, "history"),
      captureOnFailure: true,
    });
    const store = new RecipeStore({
      directory: join(root, "recipes"),
      repair: { mode: "auto" },
    });
    let exports = 0;
    let buttonLabel = "Export";
    const server = createServer(async (req, res) => {
      if (req.url === "/export" && req.method === "POST") {
        exports++;
        let body = "";
        for await (const chunk of req) body += chunk;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ date: body, sequence: exports }));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><title>Recipe fixture</title><label>Date<input id="date"></label><button onclick="fetch('/export',{method:'POST',body:document.querySelector('input').value}).then(r=>r.json()).then(data=>document.querySelector('output').textContent=data.date)">${buttonLabel}</button><output></output>`,
      );
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
            operationTimeoutMs: 2000,
          };
        },
      },
    });
    const recipe = (run: string, label: string): RecipeDraft => ({
      name: "export-fixture",
      description: "Export fixture date and verify exact receipt",
      sourceRunId: run,
      parameters: {
        url: { type: "string", required: true },
        date: { type: "string", required: true },
      },
      preconditions: [
        "Fixture HTTP server running on this machine; browser session starts fresh",
      ],
      script: `var browser=await cua.connect(); var tab=await browser.tabs.create({url:params.url}); output.json(await tab.ax.snapshot()); await tab.getByRole("textbox",{name:"Date",exact:true}).fill(params.date); await tab.getByRole("button",{name:${JSON.stringify(label)},exact:true}).click(); await tab.waitForFunction(() => !!document.querySelector("output").textContent); output.image(await tab.screenshot.capture());`,
      verify:
        'return (await tab.info()).url.startsWith(params.url) && await tab.evaluate((date) => document.querySelector("output").textContent === date, params.date);',
    });
    try {
      const first = await service.createSession({ goal: "Export a date" });
      const original = recipe(first.runId, "Export");
      const executed = await service.execute({
        sessionId: first.sessionId,
        code: `var params={url:${JSON.stringify(url)},date:"2026-10-01"}; ${original.script}`,
      });
      assert.equal(executed.status, "succeeded", JSON.stringify(executed));
      history.complete(first.runId, true);
      await service.closeSession({ sessionId: first.sessionId });
      assert.equal(exports, 1);
      const trace = new FileHistoryStore(history.config).read(first.runId);
      assert.ok(
        trace.events.some(
          (e) => e.type === "sdk.finished" && e.data.method === "ax.snapshot",
        ),
      );
      const image = trace.events.find((e) => e.data?.evidence?.path)!;
      assert.ok(
        existsSync(
          join(history.directory, first.runId, image.data.evidence.path),
        ),
      );
      // A fake host model callback exercises the integration, not a claim of model quality.
      const distilled: any = await requestAssistance({
        store,
        history,
        kind: "distill",
        runId: first.runId,
        trigger: "manual",
        model: async ({ history: recorded }) => {
          assert.ok(recorded.events.some((e) => e.data?.code));
          return traced(original, history);
        },
      });
      const version = distilled.draft.version;
      assert.equal(
        exports,
        1,
        "draft creation must not execute browser actions",
      );
      const validated = await runRecipe({
        service,
        store,
        name: original.name,
        version,
        validate: true,
        params: { url, date: "2026-10-02" },
      });
      assert.equal(validated.passed, true, JSON.stringify(validated));
      assert.equal(validated.environment, "local-browser");
      store.activate(original.name, version);
      let modelCalls = 0;
      const normal = await runRecipe({
        service,
        store,
        name: original.name,
        params: { url, date: "2026-10-03" },
        model: async () => {
          modelCalls++;
          throw Error("No model on happy path");
        },
      });
      assert.equal(normal.passed, true);
      assert.equal(exports, 3);
      assert.equal(modelCalls, 0);
      buttonLabel = "Download";
      const failed = await runRecipe({
        service,
        store,
        name: original.name,
        params: { url, date: "2026-10-04" },
        model: async ({ request, history: recorded, recipe: parent }) => {
          modelCalls++;
          assert.equal(recorded.status, "failed");
          assert.ok(JSON.stringify(recorded).includes("Download"));
          return traced(
            {
              ...recipe(request.runId, "Download"),
              parentVersion: parent!.version,
            },
            history,
          );
        },
      });
      assert.equal(failed.passed, false);
      assert.equal(modelCalls, 1);
      assert.equal(exports, 3);
      assert.ok(
        history
          .read(failed.runId)
          .events.some(
            (e) => e.type === "failure.evidence" && e.data.evidence?.path,
          ),
      );
      const repaired = (failed.assistance as any).draft.version;
      assert.equal(
        store.read(original.name).version,
        version,
        "repair must not activate itself",
      );
      const config = join(root, "config.json"),
        params = join(root, "params.json");
      writeFileSync(
        config,
        JSON.stringify({
          history: history.config,
          recipes: store.config,
          defaultProfile: "local",
          profiles: {
            local: {
              provider: "local",
              local: { channel: "chrome", headless: true },
            },
          },
        }),
      );
      writeFileSync(params, JSON.stringify({ url, date: "2026-10-05" }));
      const cli = async (...args: string[]) => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            resolve("packages/cli/dist/index.js"),
            "recipe",
            ...args,
            "--config",
            config,
          ],
          { maxBuffer: 1024 * 1024 * 8 },
        );
        return JSON.parse(stdout);
      };
      const repairedValidation = await cli(
        "validate",
        original.name,
        repaired,
        "--params",
        params,
      );
      assert.equal(repairedValidation.passed, true);
      assert.equal(exports, 4);
      await cli("activate", original.name, repaired);
      const replay = await cli("run", original.name, "--params", params);
      assert.equal(replay.passed, true);
      assert.equal(exports, 5);
      assert.equal(replay.recipe.version, repaired);
      assert.equal(history.read(replay.runId).businessSuccess, true);
    } finally {
      await service.close();
      await Promise.all(providers.map((p) => p.shutdown()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
