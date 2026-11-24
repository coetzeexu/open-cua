import { createHash, randomUUID } from "node:crypto";
import {
  inspectSecureFormElement,
  deliverSecureFormElement,
} from "./secure-form.js";
import sharp from "sharp";
import type { ElementHandle, Locator } from "playwright";
import {
  CONTRACT_VERSION,
  CuaError,
  operationError,
  type ProviderDescriptor,
  type CapabilityProvider,
  type AXCapability,
  type AXNode,
  type DOMCapability,
  type ScreenshotCapability,
  type ActionCapability,
  type TargetResolver,
  type TabBindingContext,
  type OperationContext,
  type Target,
  type LocatorTarget,
  type LocatorDiagnostics,
  type Screenshot,
} from "@cua/contracts";
import { ChromiumTab, type FrameRecord } from "./binding.js";
import { readUploadFiles, uploadPaths } from "./file-upload.js";
/** Runs in the page. Kept as source so CDP callFunctionOn and Playwright evaluate share one rule. */
export const SENSITIVE_SOURCE = `function(el){ if(!el||el.nodeType!==1) return false; if(el.tagName==="INPUT"&&String(el.type).toLowerCase()==="password") return true; const ac=String(el.getAttribute("autocomplete")||"").toLowerCase().split(/\\s+/); return ac.includes("one-time-code")||ac.includes("current-password")||ac.includes("new-password"); }`;
const TEXT_ROLES =
  /^(\s*- (?:textbox|searchbox|spinbutton|combobox)\b[^\n]*?): (.*)$/;
/** Replaces current values of sensitive fields in an aria snapshot without sending them anywhere. */
export function redactAriaSnapshot(text: string, secrets: string[]): string {
  const values = new Set(secrets.filter((s) => s.length > 0));
  if (!values.size) return text;
  return text
    .split("\n")
    .map((line) => {
      const match = TEXT_ROLES.exec(line);
      if (!match) return line;
      let value = match[2].trim();
      if (value.startsWith('"') && value.endsWith('"'))
        try {
          value = JSON.parse(value);
        } catch {}
      return values.has(value) ? `${match[1]}: "[redacted]"` : line;
    })
    .join("\n");
}
async function sensitiveValues(frame: FrameRecord): Promise<string[]> {
  // Mirrors SENSITIVE_SOURCE without page-side eval, which strict CSP would block.
  return frame.frame.evaluate(() => {
    const test = (el: Element) => {
      if (
        el.tagName === "INPUT" &&
        (el as HTMLInputElement).type === "password"
      )
        return true;
      const ac = String(el.getAttribute("autocomplete") ?? "")
        .toLowerCase()
        .split(/\s+/);
      return (
        ac.includes("one-time-code") ||
        ac.includes("current-password") ||
        ac.includes("new-password")
      );
    };
    const out: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (test(el)) out.push(String((el as HTMLInputElement).value ?? ""));
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  });
}
const descriptor = (
  id: string,
  capabilities: string[],
  targetTypes?: string[],
): ProviderDescriptor => ({
  id,
  contractVersion: CONTRACT_VERSION,
  bindingKind: "chromium",
  capabilities,
  targetTypes,
});
const tabOf = ({ binding }: TabBindingContext) => {
  if (!(binding instanceof ChromiumTab))
    throw operationError("CAPABILITY_UNAVAILABLE");
  return binding;
};
async function frameAllowed(
  tab: ChromiumTab,
  frame: FrameRecord,
  ctx: OperationContext,
) {
  const url = frame.frame.url();
  await ctx.policy(
    url === "about:blank" && frame.frame.parentFrame()
      ? frame.frame.parentFrame()!.url()
      : url,
  );
}
export class ChromiumAXProvider implements CapabilityProvider<AXCapability> {
  readonly descriptor = descriptor("chromium-ax", ["ax"]);
  async bind(binding: TabBindingContext): Promise<AXCapability> {
    const tab = tabOf(binding);
    return {
      snapshot: async (ctx, options) => {
        const nodes: AXNode[] = [];
        const warnings: { code: string; message: string }[] = [];
        for (const frame of tab.framesById.values()) {
          try {
            ctx.check();
            await frameAllowed(tab, frame, ctx);
            const cdp = await tab.frameCDP(frame);
            const tree = await cdp.send("Accessibility.getFullAXTree", {
              frameId: frame.protocolFrameId,
            });
            const start = nodes.length;
            for (const node of tree.nodes) {
              if (node.ignored) continue;
              const role = String(node.role?.value ?? "");
              const name = String(node.name?.value ?? "");
              let ref;
              let sensitive = Boolean(
                options?.redactEditableValues &&
                  (node.value ||
                    node.properties?.some(
                      (p) => p.name === "editable" && p.value?.value,
                    )),
              );
              if (
                node.backendDOMNodeId &&
                ![
                  "RootWebArea",
                  "generic",
                  "StaticText",
                  "InlineTextBox",
                  "LineBreak",
                ].includes(role)
              ) {
                const existing = [...tab.refs.values()].find(
                  (r) =>
                    r.backendId === node.backendDOMNodeId &&
                    r.ref.frameId === frame.id &&
                    r.ref.epoch === frame.epoch &&
                    r.ref.generation === binding.generation,
                );
                if (existing) {
                  existing.usedAt = Date.now();
                  ref = existing.ref;
                }
                // Keep stable refs, but never cache sensitivity: sites can change field types.
                {
                  let objectId: string | undefined;
                  try {
                    const remote = await cdp.send("DOM.resolveNode", {
                      backendNodeId: node.backendDOMNodeId,
                      executionContextId: frame.contextId,
                    });
                    objectId = remote.object.objectId;
                    if (objectId) {
                      const refId = existing?.ref.refId ?? randomUUID();
                      const result = await cdp.send("Runtime.callFunctionOn", {
                        objectId,
                        functionDeclaration: `function(key,id,protect){ if(this.nodeType!==1) return null; let root=this.getRootNode(); if(root instanceof ShadowRoot && root.mode==="closed") return null; globalThis[key].set(id,new WeakRef(this)); return (${SENSITIVE_SOURCE})(this) || (protect && (this.matches("input,textarea,select") || this.isContentEditable)); }`,
                        arguments: [
                          { value: frame.registry },
                          { value: refId },
                          { value: options?.redactEditableValues ?? false },
                        ],
                        returnByValue: true,
                      });
                      if (typeof result.result.value !== "boolean") {
                        // Unresolvable/closed-shadow controls get no ref and no visible value.
                        sensitive = true;
                      }
                      if (typeof result.result.value === "boolean") {
                        sensitive ||= result.result.value;
                        ref = {
                          type: "ref" as const,
                          sessionId: binding.sessionId,
                          generation: binding.generation,
                          tabId: tab.id,
                          frameId: frame.id,
                          epoch: frame.epoch,
                          refId,
                        };
                        tab.refs.set(refId, {
                          ref,
                          backendId: node.backendDOMNodeId,
                          registry: frame.registry,
                          usedAt: Date.now(),
                          sensitive,
                        });
                      }
                    } else sensitive = true;
                  } finally {
                    if (objectId)
                      await cdp
                        .send("Runtime.releaseObject", { objectId })
                        .catch(() => {});
                  }
                }
              }
              nodes.push({
                id: `${frame.id}:${node.nodeId}`,
                role,
                name,
                value: sensitive
                  ? node.value
                    ? "[redacted]"
                    : undefined
                  : node.value
                    ? String(node.value.value)
                    : undefined,
                parentId: node.parentId
                  ? `${frame.id}:${node.parentId}`
                  : undefined,
                frameId: frame.id,
                ref,
                ...(sensitive ? { sensitive: true } : {}),
              });
            }
            // Text inside an editable field mirrors its value (Chrome exposes OTP digits as StaticText children).
            const frameNodes = nodes.slice(start);
            const byId = new Map(frameNodes.map((n) => [n.id, n]));
            const hidden = (n: AXNode): boolean => {
              for (
                let p = n.parentId && byId.get(n.parentId);
                p;
                p = p.parentId && byId.get(p.parentId)
              )
                if (p.sensitive) return true;
              return false;
            };
            for (const n of frameNodes)
              if (hidden(n)) {
                n.name = n.name ? "[redacted]" : n.name;
                if (n.value) n.value = "[redacted]";
              }
          } catch (e) {
            if (frame.frame === tab.page.mainFrame()) throw e;
            warnings.push({
              code: e instanceof CuaError ? e.code : "FRAME_UNAVAILABLE",
              message:
                "A child frame was omitted because it was blocked or unavailable.",
            });
          }
        }
        while (tab.refs.size > 5000) {
          const [id, record] = [...tab.refs].sort(
            (a, b) => a[1].usedAt - b[1].usedAt,
          )[0];
          tab.refs.delete(id);
          tab.expired.add(id);
          const frame = tab.framesById.get(record.ref.frameId);
          if (frame)
            await frame.frame
              .evaluate(({ key, id }) => (globalThis as any)[key]?.delete(id), {
                key: record.registry,
                id,
              })
              .catch(() => {});
        }
        return { nodes, warnings };
      },
    };
  }
}
export class PlaywrightDOMProvider
  implements CapabilityProvider<DOMCapability>
{
  readonly descriptor = descriptor("playwright-dom", ["dom"]);
  async bind(binding: TabBindingContext): Promise<DOMCapability> {
    const tab = tabOf(binding);
    return {
      inspect: async (options, ctx) => {
        const {
          selector = 'a,button,[role="button"],h1,h2,output',
          limit = 50,
          maxTextLength = 500,
          frameId,
        } = options;
        if (
          typeof selector !== "string" ||
          !selector ||
          selector.length > 2000 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200 ||
          !Number.isSafeInteger(maxTextLength) ||
          maxTextLength < 1 ||
          maxTextLength > 2000
        )
          throw new TypeError(
            "dom.inspect requires selector <=2000 chars, limit 1..200, maxTextLength 1..2000",
          );
        const frame = frameId
          ? tab.framesById.get(frameId)
          : tab.registerFrame(tab.page.mainFrame());
        if (!frame) throw operationError("HANDLE_STALE");
        ctx.check();
        await frameAllowed(tab, frame, ctx);
        const observation = await frame.frame.evaluate(
          ({ selector, limit, maxTextLength }) => {
            const matches = document.querySelectorAll(selector);
            const secrets = Array.from(
              document.querySelectorAll(
                'input[type="password"],[autocomplete="one-time-code"],[autocomplete="current-password"],[autocomplete="new-password"]',
              ),
            )
              .map((el) => String((el as HTMLInputElement).value ?? ""))
              .filter(Boolean)
              .sort((a, b) => b.length - a.length);
            const redact = (text: string) =>
              secrets.reduce(
                (value, secret) => value.split(secret).join("[redacted]"),
                text,
              );
            let textTruncated = false;
            const elements = Array.from(
              { length: Math.min(matches.length, limit) },
              (_, index) => matches[index],
            ).map((element) => {
              const copy = element.cloneNode(true) as Element;
              const privateSelector =
                "input,textarea,select,[contenteditable],script,style";
              copy
                .querySelectorAll(privateSelector)
                .forEach((node) => node.remove());
              const text = copy.matches(privateSelector)
                ? ""
                : redact(copy.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim();
              textTruncated ||= text.length > maxTextLength;
              const rect = element.getBoundingClientRect();
              const href =
                element instanceof HTMLAnchorElement
                  ? redact(element.href)
                  : null;
              textTruncated ||= !!href && href.length > 4000;
              return {
                text: text.slice(0, maxTextLength),
                href: href?.slice(0, 4000) ?? null,
                bounds: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              };
            });
            const pageUrl = redact(location.href),
              pageTitle = redact(document.title);
            textTruncated ||= pageUrl.length > 4000 || pageTitle.length > 2000;
            return {
              page: {
                url: pageUrl.slice(0, 4000),
                title: pageTitle.slice(0, 2000),
                readyState: document.readyState,
              },
              capturedAt: Date.now(),
              elements,
              matched: matches.length,
              truncated: matches.length > limit,
              textTruncated,
            };
          },
          { selector, limit, maxTextLength },
        );
        ctx.check();
        return {
          ...observation,
          frameId: frame.id,
          coordinateSystem: "frame-viewport-css",
        };
      },
      snapshot: async (ctx) => {
        const frames: unknown[] = [];
        const warnings: unknown[] = [];
        for (const frame of tab.framesById.values()) {
          try {
            ctx.check();
            await frameAllowed(tab, frame, ctx);
            const text = await frame.frame
              .locator("body")
              .ariaSnapshot({ timeout: ctx.timeoutMs });
            frames.push({
              id: frame.id,
              parentId: frame.frame.parentFrame()
                ? tab.registerFrame(frame.frame.parentFrame()!).id
                : undefined,
              url: frame.frame.url(),
              text: redactAriaSnapshot(text, await sensitiveValues(frame)),
            });
          } catch (e) {
            if (frame.frame === tab.page.mainFrame()) throw e;
            warnings.push({
              code: "FRAME_OMITTED",
              message: "A child frame was blocked or unavailable.",
            });
          }
        }
        return { frames, warnings };
      },
    };
  }
}
export class ChromiumScreenshotProvider
  implements CapabilityProvider<ScreenshotCapability>
{
  readonly descriptor = descriptor("chromium-screenshot", ["screenshot"]);
  async bind(binding: TabBindingContext): Promise<ScreenshotCapability> {
    const tab = tabOf(binding);
    return {
      capture: async (options, ctx) => {
        ctx.check();
        await tab.revision(ctx);
        const geometry = await tab.page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        }));
        const clip = options.clip as
          | { x: number; y: number; width: number; height: number }
          | undefined;
        const raw = await tab.page.screenshot({
          type: "jpeg",
          quality: Number(options.quality ?? 80),
          clip,
          timeout: ctx.timeoutMs,
        });
        let pipeline = sharp(raw);
        if (options.resolution !== "original")
          pipeline = pipeline.resize({
            width: 1568,
            height: 1568,
            fit: "inside",
            withoutEnlargement: true,
          });
        const { data, info } = await pipeline
          .jpeg({ quality: Number(options.quality ?? 80) })
          .toBuffer({ resolveWithObject: true });
        const metadata: Screenshot = {
          imageId: randomUUID(),
          mimeType: "image/jpeg",
          width: info.width,
          height: info.height,
          epoch: tab.epoch,
          viewportRevision: tab.viewportRevision,
          tabId: tab.id,
          sessionId: binding.sessionId,
          generation: binding.generation,
          scaleX: (clip?.width ?? geometry.width) / info.width,
          scaleY: (clip?.height ?? geometry.height) / info.height,
          offsetX: clip?.x ?? 0,
          offsetY: clip?.y ?? 0,
        };
        screenshots.set(metadata.imageId, metadata);
        if (screenshots.size > 1000)
          screenshots.delete(screenshots.keys().next().value!);
        return { metadata, bytes: data };
      },
    };
  }
}
const screenshots = new Map<string, Screenshot>();
interface ChromiumTarget {
  type: "element" | "locator" | "point";
  element?: ElementHandle;
  locator?: Locator;
  point?: { x: number; y: number };
  tab: ChromiumTab;
  frameId?: string;
  secureNodeId?: string;
  secureMetadata?: ReturnType<typeof inspectSecureFormElement>;
  releaseSecureNode?: () => void;
}
const secureNodes = new WeakMap<ChromiumTab, Map<ElementHandle, string>>();
async function secureNodeIdentity(
  target: ChromiumTarget,
  handle: ElementHandle,
) {
  if (target.secureNodeId) return target.secureNodeId;
  let nodes = secureNodes.get(target.tab);
  if (!nodes) secureNodes.set(target.tab, (nodes = new Map()));
  let id: string | undefined;
  for (const [known, identity] of nodes) {
    if (
      await handle
        .evaluate((node, other) => node === other, known)
        .catch(() => false)
    ) {
      id = identity;
      break;
    }
  }
  id ??= randomUUID();
  nodes.set(handle, id);
  target.secureNodeId = id;
  target.releaseSecureNode = () => nodes!.delete(handle);
  return id;
}
function locate(tab: ChromiumTab, target: LocatorTarget): Locator {
  const frame = tab.frame(target.frameId).frame;
  if (target.selector) return frame.locator(target.selector);
  if (target.role)
    return frame.getByRole(target.role as any, {
      name: target.name,
      exact: target.exact,
    });
  if (target.text !== undefined)
    return frame.getByText(target.text, { exact: target.exact });
  throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
}
export class ChromiumTargetResolver implements TargetResolver {
  readonly descriptor = descriptor(
    "chromium-targets",
    [],
    ["ref", "locator", "point"],
  );
  async resolve(
    target: Target,
    binding: TabBindingContext,
    ctx: OperationContext,
  ) {
    const tab = tabOf(binding);
    ctx.check();
    if (
      target.sessionId !== binding.sessionId ||
      target.generation !== binding.generation ||
      target.tabId !== tab.id
    )
      throw operationError("HANDLE_STALE");
    await ctx.policy(tab.page.url());
    if ("frameId" in target && target.frameId)
      await ctx.policy(tab.frame(target.frameId).frame.url());
    if (target.type === "locator") {
      const value: ChromiumTarget = {
        type: "locator",
        locator: locate(tab, target),
        frameId: target.frameId,
        tab,
      };
      return {
        value,
        async dispose() {
          value.releaseSecureNode?.();
          await value.element?.dispose();
        },
      };
    }
    if (target.type === "point") {
      await tab.revision(ctx);
      const shot = screenshots.get(target.screenshotId);
      if (
        !shot ||
        shot.tabId !== tab.id ||
        shot.sessionId !== binding.sessionId ||
        shot.generation !== binding.generation ||
        shot.epoch !== tab.epoch ||
        shot.viewportRevision !== tab.viewportRevision ||
        target.epoch !== shot.epoch ||
        target.viewportRevision !== shot.viewportRevision ||
        !Number.isFinite(target.x) ||
        !Number.isFinite(target.y) ||
        target.x < 0 ||
        target.y < 0 ||
        target.x >= shot.width ||
        target.y >= shot.height
      )
        throw operationError("REF_STALE", {
          message:
            "Screenshot coordinates expired; capture and observe the page again.",
        });
      return {
        value: {
          type: "point",
          point: {
            x: target.x * shot.scaleX + shot.offsetX,
            y: target.y * shot.scaleY + shot.offsetY,
          },
          tab,
        } satisfies ChromiumTarget,
        async dispose() {},
      };
    }
    const frame = tab.frame(target.frameId);
    if (frame.epoch !== target.epoch) throw operationError("REF_STALE");
    if (tab.expired.has(target.refId)) throw operationError("REF_EXPIRED");
    const record = tab.refs.get(target.refId);
    if (!record) throw operationError("REF_STALE");
    const handle = await frame.frame.evaluateHandle(
      ({ key, id }) => (globalThis as any)[key]?.get(id)?.deref(),
      { key: record.registry, id: target.refId },
    );
    const element = handle.asElement();
    if (!element || !(await element.evaluate((el) => el.isConnected))) {
      await handle.dispose();
      throw operationError("REF_STALE");
    }
    record.usedAt = Date.now();
    const value: ChromiumTarget = {
      type: "element",
      element: element as ElementHandle,
      frameId: target.frameId,
      tab,
    };
    return {
      value,
      dispose: async () => {
        value.releaseSecureNode?.();
        await handle.dispose();
      },
    };
  }
}
export async function diagnose(locator: Locator): Promise<LocatorDiagnostics> {
  const handles = await locator.elementHandles();
  const matchCount = handles.length;
  const samples = await Promise.all(
    handles.slice(0, 5).map(async (h) => ({
      tag: await h.evaluate((el) => (el as Element).tagName.toLowerCase()),
      role: (await h.getAttribute("role")) ?? "",
      name: (await h.getAttribute("aria-label")) ?? "",
      text: ((await h.textContent()) ?? "").slice(0, 120),
      visible: await h.isVisible(),
      enabled: await h.isEnabled(),
    })),
  );
  const visibleCount = (
    await Promise.all(handles.map((h) => h.isVisible()))
  ).filter(Boolean).length;
  let intercepted = false;
  if (matchCount === 1 && visibleCount === 1)
    intercepted = await handles[0].evaluate((el) => {
      const r = (el as Element).getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return !!hit && !el.contains(hit) && hit !== el;
    });
  await Promise.all(handles.map((h) => h.dispose()));
  return {
    kind:
      matchCount === 0
        ? "no_matches"
        : matchCount > 1
          ? "multiple_matches"
          : visibleCount === 0
            ? "no_visible_match"
            : intercepted
              ? "intercepted"
              : "action_failed",
    matchCount,
    visibleCount,
    samples,
  };
}
export class ChromiumActionProvider
  implements CapabilityProvider<ActionCapability>
{
  readonly descriptor = descriptor("chromium-action", ["action"]);
  async bind(binding: TabBindingContext): Promise<ActionCapability> {
    const tab = tabOf(binding);
    return {
      describe: async (resolved, ctx) => {
        ctx.check();
        const target = resolved.value as ChromiumTarget;
        const handles = target.element
          ? [target.element]
          : target.locator
            ? await target.locator.elementHandles()
            : [];
        try {
          if (handles.length !== 1)
            return {
              count: handles.length,
              visible: false,
              enabled: false,
              editable: false,
              sensitive: false,
            };
          const [h] = handles;
          if (!(await h.evaluate((node) => node.isConnected)))
            return {
              count: 0,
              visible: false,
              enabled: false,
              editable: false,
              sensitive: false,
            };
          const authForm = await h.evaluate((node) => {
            const el = node as HTMLInputElement | HTMLButtonElement;
            const form = el.form;
            if (!form) return null;
            return {
              method: el.hasAttribute("formmethod")
                ? el.formMethod
                : form.method,
              action: el.hasAttribute("formaction")
                ? el.formAction
                : form.action,
            };
          });
          const sensitive = await h.evaluate((node) => {
            const el = node as Element;
            if (
              el instanceof HTMLInputElement &&
              el.type.toLowerCase() === "password"
            )
              return true;
            const ac = String(el.getAttribute("autocomplete") ?? "")
              .toLowerCase()
              .split(/\s+/);
            return (
              ac.includes("one-time-code") ||
              ac.includes("current-password") ||
              ac.includes("new-password")
            );
          });
          const metadata = await h.evaluate(inspectSecureFormElement);
          const secureForm = metadata
            ? {
                ...metadata,
                bindingRevision: createHash("sha256")
                  .update(metadata.bindingRevision ?? "")
                  .digest("hex"),
                nodeId: await secureNodeIdentity(target, h),
              }
            : undefined;
          if (secureForm) {
            if (!target.element) target.element = h;
            target.secureMetadata ??= metadata;
          }
          return {
            secureForm,
            count: 1,
            visible: await h.isVisible(),
            enabled: await h.isEnabled(),
            editable: await h.isEditable().catch(() => false),
            sensitive,
            authForm,
          };
        } finally {
          if (!target.element)
            await Promise.all(handles.map((h) => h.dispose()));
        }
      },
      deliverSecureForm: async (kind, resolved, value, ctx) => {
        const target = resolved.value as ChromiumTarget;
        if (!target.element || !target.secureMetadata)
          throw operationError("AUTH_LOCATOR_INVALID");
        ctx.check();
        await ctx.policy(tab.page.url());
        if (target.frameId)
          await ctx.policy(tab.frame(target.frameId).frame.url());
        ctx.check();
        ctx.dispatch();
        try {
          const result = await target.element.evaluate(
            deliverSecureFormElement,
            {
              kind,
              value,
              expected: target.secureMetadata,
            },
          );
          if (result !== "filled")
            throw operationError("ACTION_OUTCOME_UNKNOWN");
          ctx.afterDispatch();
        } catch {
          // Never expose page exceptions, private arguments, or Playwright call logs.
          throw operationError("ACTION_OUTCOME_UNKNOWN");
        }
      },
      focusedSensitive: async (ctx) => {
        ctx.check();
        for (const frame of tab.framesById.values()) {
          const focused = await frame.frame
            .evaluate(() => {
              let el: Element | null = document.activeElement;
              while (el?.shadowRoot?.activeElement)
                el = el.shadowRoot.activeElement;
              if (!el || el === document.body) return false;
              if (
                el instanceof HTMLInputElement &&
                el.type.toLowerCase() === "password"
              )
                return true;
              const ac = String(el.getAttribute("autocomplete") ?? "")
                .toLowerCase()
                .split(/\s+/);
              return (
                ac.includes("one-time-code") ||
                ac.includes("current-password") ||
                ac.includes("new-password")
              );
            })
            .catch(() => false);
          if (focused) return true;
        }
        return false;
      },
      perform: async (kind, resolved, args, ctx) => {
        const target = resolved?.value as ChromiumTarget | undefined;
        const value = target?.element ?? target?.locator;
        if (kind === "setInputFiles") {
          const paths = uploadPaths(args[0]);
          if (!value) throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
          // Pin one node before file I/O; never upload to a replacement locator match.
          const handles = target?.element
            ? [target.element]
            : await target!.locator!.elementHandles();
          try {
            if (handles.length !== 1)
              throw operationError("TARGET_NOT_ACTIONABLE", {
                message: "setInputFiles requires exactly one input[type=file].",
              });
            const handle = handles[0];
            const validate = async () => {
              ctx.check();
              await ctx.policy(tab.page.url());
              if (target?.frameId)
                await ctx.policy(tab.frame(target.frameId).frame.url());
              const state = await handle.evaluate((el) => ({
                connected: el.isConnected,
                file: el instanceof HTMLInputElement && el.type === "file",
                disabled: el instanceof Element && el.matches(":disabled"),
                directory:
                  el instanceof Element && el.hasAttribute("webkitdirectory"),
                multiple: el instanceof Element && el.hasAttribute("multiple"),
              }));
              if (!state.connected) throw operationError("REF_STALE");
              if (!state.file || state.directory)
                throw operationError("ACTION_UNSUPPORTED_FOR_TARGET", {
                  message:
                    "setInputFiles supports file inputs, not directory inputs or other elements.",
                });
              if (state.disabled) throw operationError("TARGET_NOT_ACTIONABLE");
              if (paths.length > 1 && !state.multiple)
                throw operationError("INVALID_ARGUMENT", {
                  message:
                    "Multiple files require an input with the multiple attribute.",
                });
              ctx.check();
            };
            await validate();
            const files = await readUploadFiles(paths, ctx);
            await validate();
            ctx.dispatch();
            try {
              await handle.setInputFiles(files, { timeout: ctx.timeoutMs });
              ctx.afterDispatch();
            } catch {
              throw operationError("ACTION_OUTCOME_UNKNOWN", {
                message:
                  "File selection did not complete normally. Observe input.files before deciding whether to retry.",
              });
            }
          } finally {
            if (!target?.element)
              await Promise.all(handles.map((handle) => handle.dispose()));
          }
          return;
        }
        if (
          ![
            "click",
            "fill",
            "select",
            "press",
            "hover",
            "scroll",
            "drag",
          ].includes(kind) ||
          (["fill", "select"].includes(kind) && !value) ||
          (["click", "hover", "drag"].includes(kind) && !target)
        )
          throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
        const frames = new Set<string>(target?.frameId ? [target.frameId] : []);
        const step = async () => {
          ctx.check();
          await ctx.policy(tab.page.url());
          for (const id of frames) await ctx.policy(tab.frame(id).frame.url());
          ctx.dispatch();
        };
        const opts = { timeout: ctx.timeoutMs + 5000, signal: ctx.signal };
        let diagnostic: LocatorDiagnostics | undefined;
        if (target?.locator && !target.element) {
          diagnostic = await diagnose(target.locator);
          if (
            ["no_matches", "multiple_matches", "no_visible_match"].includes(
              diagnostic.kind,
            )
          )
            throw operationError("TARGET_NOT_ACTIONABLE", {
              diagnostics: { locator: diagnostic },
            });
        }
        if (
          target?.element &&
          !(await target.element.evaluate((el) => el.isConnected))
        )
          throw operationError("REF_STALE");
        try {
          // We cannot prove Playwright's internal actionability stage is side-effect free. From here errors are unknown.
          await step();
          if (kind === "click") {
            if (target?.point)
              await tab.page.mouse.click(target.point.x, target.point.y);
            else if (value)
              await value.click({ ...opts, ...((args[0] as object) ?? {}) });
            else throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
          } else if (kind === "fill" && value)
            await value.fill(String(args[0]), opts);
          else if (kind === "select" && value)
            await value.selectOption(args[0] as string | string[], opts);
          else if (kind === "press") {
            if (value) await value.press(String(args[0]), opts);
            else await tab.page.keyboard.press(String(args[0]));
          } else if (kind === "hover") {
            if (value) await value.hover(opts);
            else if (target?.point)
              await tab.page.mouse.move(target.point.x, target.point.y);
            else throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
          } else if (kind === "scroll") {
            const delta = args[0] as { x: number; y: number };
            if (value) await value.hover(opts);
            else if (target?.point)
              await tab.page.mouse.move(target.point.x, target.point.y);
            await step();
            await tab.page.mouse.wheel(delta.x, delta.y);
            tab.viewportRevision++;
          } else if (kind === "drag") {
            const destination = await new ChromiumTargetResolver().resolve(
              args[0] as Target,
              binding,
              ctx,
            );
            try {
              const end = destination.value as ChromiumTarget;
              if (end.frameId) frames.add(end.frameId);
              const box = value ? await value.boundingBox() : undefined;
              const endBox = end.element
                ? await end.element.boundingBox()
                : end.locator
                  ? await end.locator.boundingBox()
                  : undefined;
              const start =
                target?.point ??
                (box
                  ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
                  : undefined);
              const finish =
                end.point ??
                (endBox
                  ? {
                      x: endBox.x + endBox.width / 2,
                      y: endBox.y + endBox.height / 2,
                    }
                  : undefined);
              if (!start || !finish)
                throw operationError("ACTION_OUTCOME_UNKNOWN");
              await step();
              await tab.page.mouse.move(start.x, start.y);
              await step();
              await tab.page.mouse.down();
              await step();
              await tab.page.mouse.move(finish.x, finish.y);
              await step();
              await tab.page.mouse.up();
            } finally {
              await destination.dispose();
            }
          } else throw operationError("ACTION_UNSUPPORTED_FOR_TARGET");
          ctx.afterDispatch();
        } catch (e) {
          if (e instanceof CuaError) throw e;
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (target?.locator)
            try {
              diagnostic = await Promise.race([
                diagnose(target.locator),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(Error("diagnostic timeout")),
                    1000,
                  );
                }),
              ]);
            } catch {
            } finally {
              clearTimeout(timer);
            }
          throw operationError("ACTION_OUTCOME_UNKNOWN", {
            message:
              "The browser action did not complete normally. Observe the page before deciding what to do.",
            diagnostics: diagnostic ? { locator: diagnostic } : undefined,
          });
        }
      },
    };
  }
}
export const chromiumCapabilities = () => ({
  ax: new ChromiumAXProvider(),
  dom: new PlaywrightDOMProvider(),
  screenshot: new ChromiumScreenshotProvider(),
  action: new ChromiumActionProvider(),
});
