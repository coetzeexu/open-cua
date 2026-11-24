import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ChromiumTab, ChromiumAXProvider } from "@cua/browser-chromium";

for (const kind of ["input", "textarea", "contenteditable"]) {
  test(`AX redacts protected ${kind} values and descendant text even with cached refs`, async () => {
    const secret = "synthetic-private-value";
    const el: any = {
      nodeType: 1,
      tagName: kind === "contenteditable" ? "DIV" : kind.toUpperCase(),
      type: "text",
      isContentEditable: kind === "contenteditable",
      getRootNode: () => ({}),
      getAttribute: () => "",
      matches: () => kind !== "contenteditable",
    };
    const context: any = { WeakRef, ShadowRoot: class {}, registry: new Map() };
    const frame: any = {
      id: "main",
      epoch: 0,
      registry: "registry",
      frame: { url: () => "https://fixture.test/" },
    };
    const tab: any = Object.create(ChromiumTab.prototype);
    Object.assign(tab, {
      id: "tab",
      refs: new Map(),
      expired: new Set(),
      framesById: new Map([["main", frame]]),
      page: { mainFrame: () => frame.frame },
      frameCDP: async () => ({
        send: async (method: string, params: any) => {
          if (method === "Accessibility.getFullAXTree")
            return {
              nodes: [
                {
                  nodeId: "1",
                  role: { value: "textbox" },
                  name: { value: "Field" },
                  value: { value: secret },
                  backendDOMNodeId: 1,
                },
                {
                  nodeId: "2",
                  parentId: "1",
                  role: { value: "generic" },
                  name: { value: "" },
                  backendDOMNodeId: 2,
                },
                {
                  nodeId: "3",
                  parentId: "2",
                  role: { value: "StaticText" },
                  name: { value: secret },
                },
                {
                  nodeId: "4",
                  parentId: "3",
                  role: { value: "InlineTextBox" },
                  name: { value: secret },
                },
                {
                  nodeId: "5",
                  role: { value: "button" },
                  name: { value: "Continue" },
                  backendDOMNodeId: 5,
                },
              ],
            };
          if (method === "DOM.resolveNode")
            return { object: { objectId: String(params.backendNodeId) } };
          if (method === "Runtime.callFunctionOn") {
            const target =
              params.objectId === "5"
                ? {
                    ...el,
                    tagName: "BUTTON",
                    isContentEditable: false,
                    matches: () => false,
                  }
                : el;
            return {
              result: {
                value: runInNewContext(
                  "(" + params.functionDeclaration + ")",
                  context,
                ).apply(
                  target,
                  params.arguments.map((a: any) => a.value),
                ),
              },
            };
          }
          return {};
        },
      }),
    });
    const ax = await new ChromiumAXProvider().bind({
      binding: tab,
      sessionId: "s",
      generation: 0,
    });
    const op: any = {
      check: () => {},
      policy: async () => {},
      timeoutMs: 1000,
    };
    const first = await ax.snapshot(op);
    assert.ok(JSON.stringify(first).includes(secret));
    const after = await ax.snapshot(op, { redactEditableValues: true });
    assert.ok(!JSON.stringify(after).includes(secret));
    assert.equal(after.nodes[0].value, "[redacted]");
    assert.equal(after.nodes[0].ref?.refId, first.nodes[0].ref?.refId);
    assert.equal(after.nodes.at(-1)?.name, "Continue");
    if (kind === "input") {
      el.type = "password";
      assert.ok(
        !JSON.stringify(await ax.snapshot(op)).includes(secret),
        "sensitivity must be rechecked on cached refs",
      );
    }
  });
}
