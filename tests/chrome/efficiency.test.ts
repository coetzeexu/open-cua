import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CUAService } from "@cua/service";
import { FileHistoryStore, analyzeRun } from "@cua/history";
import {
  RecipeStore,
  requestAssistance,
  runRecipe,
  reviewRecipe,
} from "@cua/recipes";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
import { traced } from "../recipe-provenance.js";

test(
  "local browser: structured observations and detour distillation preserve one successful effect from failed cell",
  { skip: process.env.CUA_REAL_CHROME !== "1", timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cua-efficiency-chrome-"));
    let submissions = 0;
    const server = createServer(async (req, res) => {
      if (req.url === "/submit" && req.method === "POST") {
        submissions++;
        let body = "";
        for await (const part of req) body += part;
        res.end(body);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><title>Efficiency fixture</title><label>Date<input id="date"></label><button onclick="fetch('/submit',{method:'POST',body:document.querySelector('input').value}).then(r=>r.text()).then(t=>document.querySelector('output').textContent=t)">Export</button><output></output><a href="/one">First result</a><a href="/two">Second result</a><input type="password" value="fixture-private-value"><span>fixture-private-value</span>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const history = new FileHistoryStore({ directory: join(root, "history") });
    const store = new RecipeStore({ directory: join(root, "recipes") });
    const service = new CUAService({
      historyStore: history,
      defaultProfile: "local",
      profiles: {
        local: () => ({
          browser: new LocalBrowserProvider({
            channel: "chrome",
            headless: true,
          }),
          capabilities: chromiumCapabilities(),
          targetResolvers: [new ChromiumTargetResolver()],
          operationTimeoutMs: 2000,
        }),
      },
    });
    try {
      const session = await service.createSession();
      const exec = (code: string) =>
        service.execute({ sessionId: session.sessionId, code });
      const bad = await exec(
        `var browser=await cua.connect();var tab=await browser.tabs.create({url:${JSON.stringify(url)}}); await tab.navigate(${JSON.stringify(url)});`,
      );
      assert.equal(bad.status, "failed");
      const observed = await exec(
        'output.json(await tab.dom.inspect({selector:"a",limit:1,maxTextLength:5})); output.json(await tab.dom.inspect({selector:"input,span"}));',
      );
      assert.equal(observed.status, "succeeded", JSON.stringify(observed));
      const view = JSON.parse(
        observed.output.find((o) => o.type === "json")!.text!,
      );
      assert.equal(view.matched, 2);
      assert.equal(view.truncated, true);
      assert.equal(view.textTruncated, true);
      assert.equal(view.elements[0].href, `${url}/one`);
      assert.equal(view.elements[0].text, "First");
      assert.equal(view.coordinateSystem, "frame-viewport-css");
      assert.equal(typeof view.capturedAt, "number");
      assert.ok(view.elements[0].bounds.width > 0);
      assert.ok(view.frameId);
      assert.equal(view.page.title, "Efficiency fixture");
      assert.ok(
        !JSON.stringify(observed.output).includes("fixture-private-value"),
      );
      const failedAfterEffect = await exec(
        'output.json(await tab.dom.inspect()); output.json(await tab.dom.inspect()); await new Promise(r=>setTimeout(r,100)); await tab.getByRole("textbox",{name:"Date",exact:true}).fill("2026-10-01"); await tab.getByRole("button",{name:"Export",exact:true}).click(); await tab.waitForFunction(()=>!!document.querySelector("output").textContent); await tab.scroll(0,300);',
      );
      assert.equal(failedAfterEffect.status, "failed");
      assert.equal(submissions, 1);
      const finish = await exec(
        'output.json(await tab.dom.inspect({selector:"output"}));',
      );
      assert.equal(finish.status, "succeeded");
      assert.ok(finish.output[0].text!.includes("2026-10-01"));
      history.complete(session.runId, true);
      await service.closeSession({ sessionId: session.sessionId });
      const source = history.read(session.runId),
        analysis = analyzeRun(source);
      assert.ok(
        analysis.failedCellEffects.some((o) => o.kind === "actions.click"),
      );
      assert.ok(analysis.redundantObservationCandidates.length > 0);
      assert.equal(analysis.metrics.fixedWaitLiteralMs, 100);
      const proposal = traced(
        {
          name: "export-once",
          description: "Export and verify fixture receipt",
          sourceRunId: session.runId,
          parameters: {
            url: { type: "string", required: true },
            date: { type: "string", required: true },
          },
          preconditions: ["Local fixture with one export per run"],
          script:
            'var browser=await cua.connect();var tab=await browser.tabs.create({url:params.url}); await tab.getByRole("textbox",{name:"Date",exact:true}).fill(params.date); await tab.getByRole("button",{name:"Export",exact:true}).click(); await tab.waitForFunction(()=>!!document.querySelector("output").textContent);',
          verify:
            'var receipt=await tab.dom.inspect({selector:"output"});return receipt.page.url.startsWith(params.url) && receipt.elements[0].text === params.date;',
        },
        history,
      );
      assert.deepEqual(reviewRecipe(proposal, source).blockers, []);
      const assisted: any = await requestAssistance({
        store,
        history,
        kind: "distill",
        runId: session.runId,
        trigger: "manual",
        model: async () => proposal,
      });
      assert.equal(
        submissions,
        1,
        "distillation never replays the failed cell",
      );
      const validated = await runRecipe({
        service,
        store,
        name: proposal.name,
        version: assisted.draft.version,
        params: { url, date: "2026-10-02" },
        validate: true,
      });
      assert.equal(validated.passed, true, JSON.stringify(validated));
      assert.equal(submissions, 2);
      assert.equal(validated.metrics!.failedExecutions, 0);
      assert.equal(validated.metrics!.fixedWaitLiteralMs, 0);
      assert.ok(validated.metrics!.operations < analysis.metrics.operations);
      store.activate(proposal.name, assisted.draft.version, history);
      const run = await runRecipe({
        service,
        store,
        name: proposal.name,
        params: { url, date: "2026-10-03" },
        model: async () => {
          throw Error("model should not run");
        },
      });
      assert.equal(run.passed, true);
      assert.equal(submissions, 3, "exactly one submission per authorized run");
      history.append(
        session.runId,
        "execution.started",
        { code: 'output.text("new source work")' },
        { executionId: "late-source-cell" },
      );
      assert.throws(
        () => store.activate(proposal.name, assisted.draft.version, history),
        /SOURCE_HISTORY_CHANGED|INCOMPLETE_HISTORY/,
      );
      console.log(
        JSON.stringify({
          source: analysis.metrics,
          validation: validated.metrics,
          submissions,
        }),
      );
    } finally {
      await service.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
