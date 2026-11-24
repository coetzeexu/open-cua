import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCUA, PendingUserChannel } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
const enabled = process.env.CUA_REAL_CHROME === "1";
const SECRET = "Real-Chrome-Secret-42";
const OTP = "918273";
test(
  "real local Chrome: redaction, write refusal, secure input, protection and headless handoff",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url === "/home"
          ? "<title>Home</title><p>signed in</p>"
          : `<!doctype html><title>Login</title><form method="post" onsubmit="event.preventDefault();window.sent=[this.u.value,this.p.value];document.title='Sent'">
<label>User <input name=u></label>
<label>Pass <input name=p type=password></label>
<label>Code <input name=c autocomplete="one-time-code" value="${OTP}"></label>
<button>Sign in</button></form><a href="#x">Hash navigation</a>
<button onclick="history.pushState({},'', '/spa')">Push state</button>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const channel = new PendingUserChannel();
    const notices: string[] = [];
    const cua = createCUA({
      browser: new LocalBrowserProvider({ channel: "chrome", headless: true }),
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
      operationTimeoutMs: 15000,
      userChannel: channel,
      onUserNotice: (_s, w) => notices.push(w.message),
    });
    try {
      const browser = await cua.connect();
      const tab = await browser.tabs.create({
        url: `http://localhost:${port}/`,
      });
      for (const type of ["password", "otp"]) {
        await assert.rejects(
          tab.auth.request({
            fields: [
              {
                id: "s",
                label: "Secret",
                type,
                target: tab.locator("input[name=u]"),
              },
            ],
          }),
          { code: "AUTH_LOCATOR_INVALID" },
        );
      }
      await tab.evaluate(() => {
        document.querySelector("form")!.method = "get";
      });
      await assert.rejects(
        tab.auth.request({
          fields: [
            {
              id: "p",
              label: "Password",
              type: "password",
              target: tab.locator("input[name=p]"),
            },
          ],
        }),
        { code: "AUTH_LOCATOR_INVALID" },
      );
      await tab.evaluate(() => {
        document.querySelector("form")!.method = "post";
        document.querySelector("button")!.setAttribute("formmethod", "get");
      });
      await assert.rejects(
        tab.auth.request({
          fields: [
            {
              id: "p",
              label: "Password",
              type: "password",
              target: tab.locator("input[name=p]"),
            },
          ],
          submit: { target: tab.getByRole("button", { name: "Sign in" }) },
        }),
        { code: "AUTH_LOCATOR_INVALID" },
      );
      await tab.evaluate(() =>
        document.querySelector("button")!.removeAttribute("formmethod"),
      );
      assert.equal(notices.length, 0);
      // Simulate a user typing directly in the page; observation must not leak it.
      await tab.locator("input[name=u]").fill("alice");
      await assert.rejects(tab.locator("input[name=p]").fill(SECRET), {
        code: "SECURE_INPUT_REQUIRED",
      });
      const dom = JSON.stringify(await tab.dom.snapshot());
      assert.doesNotMatch(dom, new RegExp(OTP));
      assert.match(dom, /redacted/);
      assert.match(dom, /alice/, "ordinary fields stay visible");
      const ax = await tab.ax.snapshot({ full: true });
      const code = ax.nodes.find((n) => n.name === "Code");
      assert.equal(code?.sensitive, true);
      assert.equal(code?.value, "[redacted]");
      assert.doesNotMatch(JSON.stringify(ax), new RegExp(OTP));
      const pending = tab.auth.request({
        fields: [
          {
            id: "user",
            label: "User",
            type: "text",
            target: tab.locator("input[name=u]"),
          },
          {
            id: "pass",
            label: "Password",
            type: "password",
            target: tab.locator("input[name=p]"),
          },
        ],
        submit: { target: tab.getByRole("button", { name: "Sign in" }) },
      });
      while (!notices.length) await new Promise((r) => setTimeout(r, 10));
      const id = /cua auth ([\w-]+)/.exec(notices[0])![1];
      assert.equal(
        channel.submitCredentials(id, { user: "bob", pass: SECRET }),
        true,
      );
      const result = await pending;
      assert.equal(result.status, "submitted");
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
      await assert.rejects(
        tab.evaluate(() => (window as any).sent),
        {
          code: "CREDENTIAL_PROTECTED",
        },
      );
      await assert.rejects(tab.screenshot.capture(), {
        code: "CREDENTIAL_PROTECTED",
      });
      const after = await tab.ax.snapshot({ full: true });
      assert.equal(after.title, "Sent");
      assert.doesNotMatch(JSON.stringify(after), new RegExp(SECRET));
      for (const [role, name] of [
        ["link", "Hash navigation"],
        ["button", "Push state"],
      ]) {
        await tab.getByRole(role, { name, exact: true }).click();
        await assert.rejects(
          tab.evaluate(() => document.querySelector("input")?.value),
          { code: "CREDENTIAL_PROTECTED" },
        );
        await assert.rejects(tab.dom.inspect(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await assert.rejects(tab.dom.snapshot(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await assert.rejects(tab.screenshot.capture(), {
          code: "CREDENTIAL_PROTECTED",
        });
        assert.doesNotMatch(
          JSON.stringify(await tab.ax.snapshot({ full: true })),
          new RegExp(SECRET),
        );
      }
      await tab.goto(`http://localhost:${port}/home`);
      assert.equal(await tab.evaluate(() => document.title), "Home");
      await assert.rejects(tab.handoff.request(), {
        code: "CAPABILITY_UNAVAILABLE",
      });
    } finally {
      await cua.engine.close();
      server.close();
    }
  },
);

test(
  "real Chrome: external handoff protects newly entered iframe credentials through same-document navigation",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url === "/child"
          ? "<label>Password<input type=password></label><a href=\"#x\">Hash</a><button onclick=\"history.pushState({},'','/child-spa')\">SPA</button>"
          : '<iframe src="/child"></iframe>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const local = new LocalBrowserProvider({
      channel: "chrome",
      headless: true,
    });
    let connection!: Awaited<ReturnType<typeof local.connect>>;
    const channel = new PendingUserChannel();
    const cua = createCUA({
      browser: {
        descriptor: local.descriptor,
        connect: async (ctx) => {
          connection = await local.connect(ctx);
          // Supply a host-controlled synthetic handoff; no real user browser is opened.
          Object.defineProperty(connection, "handoff", {
            value: async () => ({ kind: "user_browser" }),
          });
          return connection;
        },
      },
      capabilities: chromiumCapabilities(),
      targetResolvers: [new ChromiumTargetResolver()],
      userChannel: channel,
    });
    try {
      const tab = await (
        await cua.connect()
      ).tabs.create({
        url: `http://127.0.0.1:${(server.address() as any).port}/`,
      });
      const hostTab = await connection.get(tab.id);
      assert.equal((await hostTab.frames()).length, 2);
      const h = await tab.handoff.request();
      const frame = hostTab.page.frames().find((f) => f.parentFrame())!;
      await frame.locator("input").fill(SECRET);
      assert.equal(channel.resume(h.handoffId), true);
      assert.equal((await tab.handoff.wait()).status, "resumed");
      for (const navigate of [
        async () => {},
        async () => {
          await frame.getByRole("link").click();
        },
        async () => {
          await frame.getByRole("button").click();
        },
      ]) {
        await navigate();
        await assert.rejects(
          tab.evaluate(() => 1),
          { code: "CREDENTIAL_PROTECTED" },
        );
        await assert.rejects(tab.dom.inspect(), {
          code: "CREDENTIAL_PROTECTED",
        });
        await assert.rejects(tab.dom.snapshot(), {
          code: "CREDENTIAL_PROTECTED",
        });
        assert.doesNotMatch(
          JSON.stringify(await tab.ax.snapshot({ full: true })),
          new RegExp(SECRET),
        );
      }
      await tab.goto(`http://127.0.0.1:${(server.address() as any).port}/new`);
      assert.equal(await tab.evaluate(() => 1), 1);
    } finally {
      await cua.engine.close();
      server.close();
    }
  },
);
