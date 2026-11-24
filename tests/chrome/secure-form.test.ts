import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecureFormControl } from "@cua/contracts";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createCUA, PendingUserChannel } from "@cua/core";
import { LocalBrowserProvider } from "@cua/browser-local";
import {
  chromiumCapabilities,
  ChromiumTargetResolver,
} from "@cua/browser-chromium";
import {
  inspectSecureFormElement,
  deliverSecureFormElement,
} from "../../packages/browser-chromium/src/secure-form.ts";

const enabled = process.env.CUA_REAL_CHROME === "1";
const html = `<!doctype html><title>Passenger fixture</title>
<form method="post"><fieldset><legend>Passenger 1</legend>
<label>Name<input id="name" required></label>
<label>Birth date<input id="date" type="date" required></label>
<label>Country<select id="country" required><option value="">Choose</option><option value="wrong">CN</option><option value="CN">China</option></select></label>
<label>Passport<input id="passport"></label><label>Email<input id="email" type="email"></label>
<label>Phone<input id="phone" type="tel"></label><label>Password<input id="password" type="password"></label>
</fieldset><input id="other"><button>Continue</button></form>
<script>window.events=[];document.addEventListener('input',e=>window.events.push(e.target.id));document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitted=true};</script>`;

async function setup() {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const local = new LocalBrowserProvider({ channel: "chrome", headless: true });
  let connection!: Awaited<ReturnType<typeof local.connect>>;
  const channel = new PendingUserChannel();
  const cua = createCUA({
    browser: {
      descriptor: local.descriptor,
      connect: async (ctx) => (connection = await local.connect(ctx)),
    },
    capabilities: chromiumCapabilities(),
    targetResolvers: [new ChromiumTargetResolver()],
    userChannel: channel,
  });
  try {
    const browser = await cua.connect();
    const tab = await browser.tabs.create({ url: origin });
    const page = (await connection.get(tab.id)).page;
    const fields = [
      "name",
      "date",
      "country",
      "passport",
      "email",
      "phone",
      "password",
    ].map((id) => ({
      id,
      label: id,
      groupId: "p1",
      control: ((
        {
          date: "date",
          country: "select",
          email: "email",
          phone: "tel",
          password: "password",
        } as Record<string, SecureFormControl>
      )[id] ?? "text") as SecureFormControl,
      target: tab.locator(`#${id}`),
    }));
    const request = () =>
      tab.secureForm.request({
        title: "Passenger 1",
        groups: [{ id: "p1", label: "Passenger 1" }],
        fields,
        timeoutMs: 10000,
      });
    const pending = async () => {
      for (let i = 0; i < 200; i++) {
        const r = channel
          .listForSession(cua.engine.sessionId)
          .find((r) => r.type === "secure_form");
        if (r?.type === "secure_form") return r;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Private request not available");
    };
    const values = {
      name: randomUUID(),
      date: "1993-02-17",
      country: "",
      passport: randomUUID(),
      email: `${randomUUID()}@example.test`,
      phone: "0912345678",
      password: randomUUID(),
    };
    const submit = async () => {
      const r = await pending();
      values.country = r.fields
        .find((f) => f.id === "country")!
        .options!.find((o) => o.label === "China")!.id;
      return channel.answerSecureForm(r.id, {
        action: "submit",
        schemaRevision: r.schemaRevision,
        submissionId: randomUUID(),
        values,
      });
    };
    return {
      cua,
      tab,
      browser,
      page,
      origin,
      channel,
      request,
      pending,
      submit,
      values,
      close: async () => {
        await cua.engine.close();
        server.close();
      },
    };
  } catch (error) {
    await cua.engine.close();
    server.close();
    throw error;
  }
}

test(
  "real Chrome: seven private fields, exact select values, focus isolation and cross-document protection",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const s = await setup();
    try {
      await s.page.locator("#other").focus();
      const run = s.request();
      const pending = await s.pending();
      await s.submit();
      const result = await run;
      assert.equal(result.status, "filled");
      assert.equal(result.businessOutcome, "unverified");
      assert.equal(result.confirmedFieldIds.length, 7);
      const actual = await s.page
        .locator("input,select")
        .evaluateAll((nodes) =>
          Object.fromEntries(
            nodes.map((n) => [n.id, (n as HTMLInputElement).value]),
          ),
        );
      assert.ok(
        Object.entries(s.values).every(
          ([k, v]) => actual[k] === (k === "country" ? "CN" : v),
        ),
        "All private fields must reach their bound controls",
      );
      assert.equal(actual.other, "");
      assert.equal(
        await s.page.evaluate(() => document.activeElement?.id),
        "other",
      );
      assert.equal(
        await s.page.evaluate(() => (window as any).submitted),
        undefined,
      );
      assert.equal(
        (await s.page.evaluate(() => (window as any).events)).length,
        7,
      );
      s.channel.answerSecureForm(pending.id, {
        action: "submit",
        schemaRevision: pending.schemaRevision,
        submissionId: randomUUID(),
        values: s.values,
      });
      assert.equal(
        (await s.page.evaluate(() => (window as any).events)).length,
        7,
      );
      for (const value of Object.values(s.values))
        assert.ok(
          !JSON.stringify(result).includes(value),
          "Receipt must exclude private input",
        );
      for (const move of [
        async () => {},
        async () => {
          await s.page.evaluate(() =>
            history.pushState({}, "", "/spa#private"),
          );
        },
        async () => {
          await s.page.goto(`${s.origin}/next`);
        },
      ]) {
        await move();
        for (const read of [
          () => s.tab.ax.snapshot(),
          () => s.tab.dom.snapshot(),
          () => s.tab.dom.inspect(),
          () => s.tab.screenshot.capture(),
          () => s.tab.evaluate(() => document.title),
          () => s.tab.info(),
        ])
          await assert.rejects(read(), { code: "SECURE_FORM_PROTECTED" });
      }
      s.cua.engine.reset();
      assert.equal(s.cua.engine.isSecureFormProtected(), true);
    } finally {
      await s.close();
    }
  },
);

for (const mutation of ["replace", "rebind", "option", "autofill"] as const)
  test(
    `real Chrome: pending form detects ${mutation} and stops remaining writes`,
    { skip: !enabled, timeout: 60000 },
    async () => {
      const s = await setup();
      try {
        const run = s.request();
        await s.pending();
        await s.page.evaluate((kind) => {
          const input = document.querySelector<HTMLInputElement>("#name")!;
          if (kind === "replace") input.replaceWith(input.cloneNode(true));
          if (kind === "rebind") input.name = "passenger2";
          if (kind === "option")
            document
              .querySelector("#country option:last-child")!
              .setAttribute("value", "different");
          if (kind === "autofill") input.value = "Human entered";
        }, mutation);
        await s.submit();
        const result = await run;
        // A later field can change after earlier fields have already been delivered.
        assert.equal(
          result.status,
          mutation === "option" ? "partial_or_unknown" : "stale",
        );
        assert.equal(
          result.confirmedFieldIds.length,
          mutation === "option" ? 2 : 0,
        );
        assert.equal(await s.page.locator("#passport").inputValue(), "");
        assert.equal(await s.page.locator("#country").inputValue(), "");
      } finally {
        await s.close();
      }
    },
  );

test(
  "real Chrome: input event replacing remaining controls stops delivery without replay",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const s = await setup();
    try {
      await s.page.evaluate(() =>
        document.querySelector("#name")!.addEventListener("input", () => {
          const next = document.querySelector("#date")!;
          next.replaceWith(next.cloneNode(true));
        }),
      );
      const run = s.request();
      await s.submit();
      const result = await run;
      assert.equal(result.status, "partial_or_unknown");
      assert.deepEqual(result.confirmedFieldIds, ["name"]);
      assert.equal(await s.page.locator("#date").inputValue(), "");
      assert.equal(await s.page.locator("#passport").inputValue(), "");
    } finally {
      await s.close();
    }
  },
);

test(
  "real Chrome: atomic delivery rejects a newly disabled fieldset",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const s = await setup();
    try {
      const node = await s.page.locator("#name").elementHandle();
      const expected = await node!.evaluate(inspectSecureFormElement);
      await s.page
        .locator("fieldset")
        .evaluate((n) => ((n as HTMLFieldSetElement).disabled = true));
      const result = await node!.evaluate(deliverSecureFormElement, {
        kind: "fill" as const,
        value: randomUUID(),
        expected,
      });
      assert.equal(result, "stale");
      assert.equal(await s.page.locator("#name").inputValue(), "");
    } finally {
      await s.close();
    }
  },
);
