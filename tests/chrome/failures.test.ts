import { test } from "node:test";
import assert from "node:assert/strict";
import { createCUA, CUAEngine, DefaultPolicyProvider } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
  ChromiumBinding,
  diagnose,
} from "@cua/browser-chromium";
import { CUAService } from "@cua/service";
const enabled = process.env.CUA_REAL_CHROME === "1";
const setup = () => {
  const provider = new LocalBrowserProvider({ channel: "chrome" });
  const options = {
    browser: provider,
    capabilities: chromiumCapabilities(),
    targetResolvers: [new ChromiumTargetResolver()],
    operationTimeoutMs: 10000,
  };
  return { provider, options, cua: createCUA(options) };
};
test(
  "real Chrome: asynchronous evaluate abandonment and synchronous loop recovery",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const { cua } = setup();
    try {
      const b = await cua.connect();
      const t = await b.tabs.create();
      await t.evaluate(() => {
        document.body.innerHTML = "<button>stable</button>";
      });
      await assert.rejects(
        t.evaluate(
          () => new Promise((r) => setTimeout(() => r(1), 500)),
          undefined,
          { timeoutMs: 50 },
        ),
        { code: "EVALUATE_ABANDONED" },
      );
      assert.equal(await t.evaluate(() => 1), 1);
      await assert.rejects(
        t.evaluate(
          () => {
            while (true) {}
          },
          undefined,
          { timeoutMs: 50 },
        ),
        { code: "EVALUATE_ABANDONED" },
      );
      try {
        assert.equal(await t.evaluate(() => 2), 2);
      } catch (error) {
        assert.equal((error as any).code, "TAB_QUARANTINED");
        await t.close();
        const fresh = await b.tabs.create();
        assert.equal(await fresh.evaluate(() => 2), 2);
      }
    } finally {
      await cua.engine.close();
    }
  },
);
test(
  "real Chrome: all locator diagnostic kinds, ref argument and post-resolution clone replacement",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const { cua } = setup();
    try {
      const b = await cua.connect();
      const t = await b.tabs.create();
      await t.evaluate(() => {
        document.body.innerHTML =
          '<button id="original" onclick="window.clicks=(window.clicks||0)+1">Original</button><button class="many">A</button><button class="many">B</button><button id="hidden" style="display:none">Hidden</button><button id="covered" style="position:absolute;left:300px;top:20px">Covered</button><div style="position:absolute;left:300px;top:20px;width:200px;height:100px;z-index:2">cover</div>';
      });
      const connection = (await cua.engine.connect()) as ChromiumBinding;
      const binding = await connection.get(t.id);
      for (const [selector, kind] of [
        ["#missing", "no_matches"],
        [".many", "multiple_matches"],
        ["#hidden", "no_visible_match"],
        ["#covered", "intercepted"],
        ["#original", "action_failed"],
      ])
        assert.equal(
          (await diagnose(binding.page.locator(selector))).kind,
          kind,
        );
      const snapshot = await t.ax.snapshot();
      const ref = snapshot.nodes.find(
        (n) => n.name === "Original" && n.role === "button",
      )!.ref!;
      assert.equal(await t.evaluate((el) => el.textContent, ref), "Original");
      const scopeId = cua.engine.coordinator.openScope();
      let resolved: any;
      await cua.engine.coordinator.run(
        {
          scopeId,
          sessionId: cua.engine.sessionId,
          generation: cua.engine.generation,
          kind: "resolve",
          tab: binding,
          timeoutMs: 500,
          policy: async () => {},
        },
        async (ctx) => {
          resolved = await new ChromiumTargetResolver().resolve(
            ref,
            {
              binding,
              sessionId: cua.engine.sessionId,
              generation: cua.engine.generation,
            },
            ctx,
          );
        },
      );
      await binding.page.evaluate(() => {
        const el = document.querySelector("#original")!;
        el.replaceWith(el.cloneNode(true));
      });
      const action = await chromiumCapabilities().action.bind({
        binding,
        sessionId: cua.engine.sessionId,
        generation: cua.engine.generation,
      });
      await assert.rejects(
        cua.engine.coordinator.run(
          {
            scopeId,
            sessionId: cua.engine.sessionId,
            generation: cua.engine.generation,
            kind: "click",
            tab: binding,
            timeoutMs: 500,
            policy: async () => {},
          },
          (ctx) => action.perform("click", resolved, [], ctx),
        ),
        { code: "REF_STALE" },
      );
      await resolved.dispose();
      assert.equal(await t.evaluate(() => (window as any).clicks ?? 0), 0);
    } finally {
      await cua.engine.close();
    }
  },
);
test(
  "real Chrome: cancelled queued action generates zero input events",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const { provider, options } = setup();
    let connection: ChromiumBinding | undefined;
    const connect = provider.connect.bind(provider);
    provider.connect = async () => (connection = await connect());
    const service = new CUAService({
      profiles: { local: () => options },
      executeWaitMs: 10,
    });
    const { sessionId } = await service.createSession();
    const finish = async (r: any) => {
      while (r.status === "running")
        r = await service.getExecution({
          sessionId,
          executionId: r.executionId,
          cursor: r.cursor,
        });
      return r;
    };
    try {
      let r = await finish(
        await service.execute({
          sessionId,
          code: 'var b=await cua.connect();var t=await b.tabs.create();await t.evaluate(()=>{document.body.innerHTML=`<button id="slow">Slow</button><button id="queued">Queued</button>`;window.events=[];document.addEventListener("mousedown",e=>window.events.push(e.target.id));});',
        }),
      );
      assert.equal(r.status, "succeeded", JSON.stringify(r));
      r = await service.execute({
        sessionId,
        code: 'var first=t.locator("#slow").click({delay:500}).catch(()=>{});var queued=t.locator("#queued").click().catch(()=>{});await Promise.all([first,queued]);',
      });
      const tab = (await connection!.tabs())[0];
      await tab.page.waitForFunction(() => (window as any).events.length > 0);
      r = await service.cancelExecution({
        sessionId,
        executionId: r.executionId,
      });
      assert.equal(r.status, "cancelled");
      await new Promise((r) => setTimeout(r, 600));
      assert.deepEqual(await tab.page.evaluate(() => (window as any).events), [
        "slow",
      ]);
    } finally {
      await service.close();
    }
  },
);

test(
  "real Chrome: attach hides user tabs, validates claims and preserves deliverables",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const { createServer } = await import("node:net");
    const portServer = createServer();
    await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
    const port = (portServer.address() as any).port;
    await new Promise<void>((r) => portServer.close(() => r()));
    const owner = new LocalBrowserProvider({
      channel: "chrome",
      launchOptions: { args: [`--remote-debugging-port=${port}`] },
    });
    const original = await owner.connect();
    const user = await original.create();
    await user.page.setContent("<title>user page</title><button>User</button>");
    const attached = createCUA({
      browser: new LocalBrowserProvider({
        mode: "attach",
        endpoint: `http://127.0.0.1:${port}`,
      }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
    });
    try {
      const browser = await attached.connect();
      assert.equal((await browser.tabs.list()).length, 0);
      const discovered = (await browser.userTabs.list())[0];
      await user.page.setContent("<title>changed</title><button>User</button>");
      await assert.rejects(browser.userTabs.claim(discovered), {
        code: "HANDLE_STALE",
      });
      const claimed = await browser.userTabs.claim(
        (await browser.userTabs.list())[0],
      );
      await claimed.getByRole("button", { name: "User" }).click();
      const scratch = await browser.tabs.create();
      const deliverable = await browser.tabs.create();
      await deliverable.markDeliverable();
      await deliverable.evaluate(() => {
        document.title = "delivery";
      });
      await scratch.evaluate(() => {
        document.title = "scratch";
      });
      const connection = (await attached.engine.connect()) as ChromiumBinding;
      const scratchPage = (await connection.get(scratch.id)).page;
      const deliveredPage = (await connection.get(deliverable.id)).page;
      await attached.engine.close();
      assert.equal(user.page.isClosed(), false);
      assert.equal(scratchPage.isClosed(), true);
      const titles = await Promise.all(
        original.context.pages().map((page) => page.title()),
      );
      assert.ok(titles.includes("delivery"));
      assert.ok(!titles.includes("scratch"));
      assert.equal(original.browser.isConnected(), true);
    } finally {
      await attached.engine.close();
      await original.close();
    }
  },
);

test(
  "real Chrome: policy blocks redirect destination and filters denied iframe",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, {
          location: `http://denied.test:${(server.address() as any).port}/secret`,
        });
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        req.headers.host?.startsWith("denied.test")
          ? "<button>Secret frame action</button>"
          : `<title>Allowed</title><button>Visible</button><iframe src="http://denied.test:${(server.address() as any).port}/secret"></iframe>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const allowed = `http://allowed.test:${port}`,
      denied = `http://denied.test:${port}`;
    const cua = createCUA({
      browser: new LocalBrowserProvider({
        channel: "chrome",
        launchOptions: {
          args: [
            "--no-proxy-server",
            "--host-resolver-rules=MAP *.test 127.0.0.1",
          ],
        },
      }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
      policy: new DefaultPolicyProvider({ allow: [allowed], deny: [denied] }),
    });
    try {
      const b = await cua.connect();
      const t = await b.tabs.create({ url: allowed });
      const snap = await t.ax.snapshot();
      assert.ok(snap.nodes.some((n) => n.name === "Visible"));
      assert.ok(!snap.nodes.some((n) => n.name === "Secret frame action"));
      assert.ok(snap.warnings.some((w) => w.code === "POLICY_BLOCKED"));
      const dom = (await t.dom.snapshot()) as any;
      assert.ok(!JSON.stringify(dom.frames).includes("Secret frame action"));
      await assert.rejects(t.goto(`${allowed}/redirect`), {
        code: "POLICY_BLOCKED",
        phase: "after_dispatch",
        outcome: "executed",
      });
      await assert.rejects(t.ax.snapshot(), { code: "POLICY_BLOCKED" });
      await assert.rejects(t.getByRole("button").click(), {
        code: "POLICY_BLOCKED",
      });
      await assert.rejects(
        t.evaluate(() => 1),
        { code: "POLICY_BLOCKED" },
      );
    } finally {
      await cua.engine.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
