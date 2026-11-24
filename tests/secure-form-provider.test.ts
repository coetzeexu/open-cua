import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  inspectSecureFormElement,
  secureFormDeliverySource,
} from "../packages/browser-chromium/src/secure-form.ts";
import { ChromiumActionProvider } from "../packages/browser-chromium/src/capabilities.ts";
import { ChromiumTab } from "../packages/browser-chromium/src/binding.ts";

const documentWith = (html: string) => {
  const window = new Window({ url: "https://forms.test/passengers" });
  window.document.body.innerHTML = html;
  return window.document;
};
const inspect = (el: unknown) => inspectSecureFormElement(el as Element);

test("native schema includes constraints and no existing input value", () => {
  const doc = documentWith(
    '<form method="post"><label for="passport">Passport</label><input id="passport" name="passenger1" required maxlength="20" value="PRIVATE-123"><input id="birth" type="date" min="1900-01-01" max="2026-01-01"></form>',
  );
  const field = inspect(doc.querySelector("#passport"))!;
  assert.equal(field.control, "text");
  assert.equal(field.required, true);
  assert.equal(field.nonEmpty, true);
  assert.equal(field.maxLength, 20);
  assert.ok(!JSON.stringify(field).includes("PRIVATE-123"));
  assert.equal(inspect(doc.querySelector("#birth"))!.min, "1900-01-01");
  const revision = field.bindingRevision;
  doc.querySelector("#passport")!.setAttribute("name", "passenger2");
  assert.notEqual(
    inspect(doc.querySelector("#passport"))!.bindingRevision,
    revision,
  );
});

test("native select excludes disabled/hidden options and rejects ambiguous values", () => {
  const doc = documentWith(
    '<select required><option value="">Choose</option><option value="CN">China</option><optgroup disabled><option value="MY">Malaysia</option></optgroup><option hidden value="US">United States</option></select>',
  );
  const el = doc.querySelector("select")!;
  const d = inspect(el)!;
  assert.equal(d.control, "select");
  assert.equal(d.options!.find((o) => o.value === "CN")!.disabled, false);
  assert.equal(d.options!.find((o) => o.value === "MY")!.disabled, true);
  assert.equal(d.options!.find((o) => o.value === "US")!.disabled, true);
  el.insertAdjacentHTML(
    "beforeend",
    '<option value="CN">Different target</option>',
  );
  assert.equal(inspect(el), undefined);
});

test("unsupported native constraints, widgets and OTP fail closed", () => {
  for (const html of [
    '<input autocomplete="one-time-code">',
    '<input type="number">',
    '<input role="combobox">',
    "<input readonly>",
    '<input pattern="[A-Z]+">',
    '<input minlength="3">',
    '<input type="email" multiple>',
    '<input type="date" step="7">',
    '<input list="saved"><datalist id="saved"><option value="Private address"></datalist>',
    "<select multiple><option>x</option></select>",
    "<select><option disabled>x</option></select>",
    '<div role="textbox" contenteditable>hello</div>',
  ]) {
    const doc = documentWith(html);
    assert.equal(inspect(doc.body.firstElementChild), undefined, html);
  }
});

// These handles execute the same page evaluator without launching a browser.
const handle = (node: any) => ({
  evaluate: async (fn: Function, arg?: any) => fn(node, arg?.__node ?? arg),
  __node: node,
  isVisible: async () => true,
  isEnabled: async () => true,
  isEditable: async () => true,
  dispose: async () => {},
  fill: async (value: string) => {
    node.value = value;
  },
});
test("host identity distinguishes replacement nodes and delivery pins original locator target", async () => {
  const doc = documentWith('<input id="passenger1"><input id="passenger2">');
  // The evaluator uses this constructor only for the legacy password detector.
  const old = (globalThis as any).HTMLInputElement;
  (globalThis as any).HTMLInputElement = doc.defaultView!.HTMLInputElement;
  try {
    const tab = Object.create(ChromiumTab.prototype) as ChromiumTab;
    Object.defineProperty(tab, "page", {
      value: { url: () => "https://forms.test/passengers" },
    });
    const action = await new ChromiumActionProvider().bind({
      binding: tab,
      sessionId: "s",
      generation: 1,
    });
    const first = doc.querySelector("#passenger1")!;
    const second = doc.querySelector("#passenger2")!;
    let current = first;
    const ctx = {
      check() {},
      policy: async () => {},
      dispatch() {},
      afterDispatch() {},
      timeoutMs: 1000,
      signal: new AbortController().signal,
    } as any;
    const target = {
      type: "locator",
      tab,
      locator: { elementHandles: async () => [handle(current)] },
    };
    const resolved = { value: target, dispose: async () => {} };
    const initial = await action.describe!(resolved, ctx);
    const alias = {
      value: { type: "element", tab, element: handle(first) },
      dispose: async () => {},
    };
    assert.equal(
      (await action.describe!(alias, ctx)).secureForm!.nodeId,
      initial.secureForm!.nodeId,
    );
    current = second;
    const replacement = {
      value: { type: "element", tab, element: handle(second) },
      dispose: async () => {},
    };
    assert.notEqual(
      (await action.describe!(replacement, ctx)).secureForm!.nodeId,
      initial.secureForm!.nodeId,
    );
    await action.perform("fill", resolved, ["PRIVATE"], ctx);
    assert.equal((first as unknown as HTMLInputElement).value, "PRIVATE");
    assert.equal((second as unknown as HTMLInputElement).value, "");
    assert.equal(
      (await action.describe!(resolved, ctx)).secureForm!.nodeId,
      initial.secureForm!.nodeId,
    );
    first.setAttribute("name", "other-passenger");
    assert.notEqual(
      (await action.describe!(resolved, ctx)).secureForm!.bindingRevision,
      initial.secureForm!.bindingRevision,
    );
  } finally {
    (globalThis as any).HTMLInputElement = old;
  }
});

test("private writes survive stolen focus and select values never match another label", () => {
  const doc = documentWith(
    '<input id="first"><input id="other"><select><option value="wrong">CN</option><option value="CN">China</option></select>',
  );
  const first = doc.querySelector("#first")! as any;
  const other = doc.querySelector("#other")! as any;
  const select = doc.querySelector("select")! as any;
  for (const node of [first, other, select])
    node.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const deliver = new Function(
    "document",
    `return (${secureFormDeliverySource})`,
  )(doc);
  let focusEvents = 0;
  first.addEventListener("focus", () => {
    focusEvents++;
    other.focus();
  });
  first.focus();
  assert.equal(doc.activeElement, other, "the page can redirect focus");
  focusEvents = 0;
  const events: string[] = [];
  first.addEventListener("input", () => events.push("input"));
  first.addEventListener("change", () => events.push("change"));
  assert.equal(
    deliver(first, {
      kind: "fill",
      value: "PRIVATE",
      expected: inspect(first),
    }),
    "filled",
  );
  assert.equal(first.value, "PRIVATE");
  assert.equal(other.value, "");
  assert.equal(doc.activeElement, other);
  assert.equal(
    focusEvents,
    0,
    "secure delivery does not focus or type through the keyboard",
  );
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(
    deliver(select, { kind: "select", value: "CN", expected: inspect(select) }),
    "filled",
  );
  assert.equal(select.value, "CN");
  assert.equal(
    select.selectedIndex,
    1,
    "value matching never falls back to an earlier label",
  );
  const previouslyEmpty = inspect(other);
  other.value = "EXTERNAL-INPUT";
  assert.equal(
    deliver(other, {
      kind: "fill",
      value: "OVERWRITE",
      expected: previouslyEmpty,
    }),
    "stale",
  );
  assert.equal(
    other.value,
    "EXTERNAL-INPUT",
    "an empty field becoming occupied requires fresh review",
  );
  const expected = inspect(first);
  first.name = "different-passenger";
  assert.equal(
    deliver(first, { kind: "fill", value: "WRONG", expected }),
    "stale",
  );
  assert.equal(first.value, "PRIVATE");
});
