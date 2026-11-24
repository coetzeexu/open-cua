import type { SecureFormDescriptor } from "@cua/contracts";

/** Executes in the page. Only structural metadata crosses to the trusted host. */
export function inspectSecureFormElement(
  node: Element,
): Omit<SecureFormDescriptor, "nodeId"> | undefined {
  if (
    !node.isConnected ||
    node.matches(":disabled") ||
    node.getAttribute("aria-disabled") === "true"
  )
    return;
  const tag = node.tagName;
  const el = node as HTMLInputElement | HTMLSelectElement;
  const autocomplete = (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  if (autocomplete.includes("one-time-code")) return;
  let control: SecureFormDescriptor["control"];
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    if (
      !["text", "email", "tel", "password", "date"].includes(input.type) ||
      input.readOnly ||
      input.disabled ||
      input.list
    )
      return;
    if (
      input.getAttribute("role") &&
      !["textbox", "searchbox"].includes(input.getAttribute("role")!)
    )
      return;
    if (input.type === "email" && input.multiple) return;
    if (
      input.hasAttribute("pattern") ||
      input.minLength > 0 ||
      (input.type === "date" &&
        input.hasAttribute("step") &&
        input.step !== "1" &&
        input.step !== "any")
    )
      return;
    control = input.type as SecureFormDescriptor["control"];
  } else if (tag === "SELECT") {
    const select = el as HTMLSelectElement;
    if (
      select.multiple ||
      select.disabled ||
      select.size > 1 ||
      (select.getAttribute("role") &&
        select.getAttribute("role") !== "combobox")
    )
      return;
    control = "select";
  } else return;
  // Include binding context so reusing a node for a different record invalidates approval.
  // This stays private; it is hashed by the host and never supplied to the model.
  const attributeNames = [
    "id",
    "name",
    "autocomplete",
    "aria-label",
    "aria-labelledby",
    "form",
    "type",
  ];
  const ancestors: unknown[] = [];
  let parent = node.parentElement;
  for (let i = 0; parent && i < 12; i++, parent = parent.parentElement) {
    ancestors.push([
      parent.tagName,
      attributeNames.map((key) => parent!.getAttribute(key)),
      parent.tagName === "FIELDSET"
        ? parent.querySelector(":scope > legend")?.textContent?.slice(0, 2048)
        : null,
    ]);
  }
  const form = el.form;
  const bindingRevision = JSON.stringify({
    attributes: attributeNames.map((key) => node.getAttribute(key)),
    ancestors,
    labels: Array.from(el.labels ?? []).map((label) =>
      label.textContent?.slice(0, 2048),
    ),
    form: form
      ? [
          attributeNames.map((key) => form.getAttribute(key)),
          form.method,
          form.action,
        ]
      : null,
  });
  if (bindingRevision.length > 16384) return;
  const descriptor: Omit<SecureFormDescriptor, "nodeId"> = {
    control,
    required: el.required,
    nonEmpty: el.value !== "",
    bindingRevision,
  };
  if (control === "select") {
    const options = Array.from((el as HTMLSelectElement).options);
    if (!options.length || options.length > 500) return;
    const seen = new Set<string>();
    descriptor.options = [];
    for (const option of options) {
      const label = option.label ?? option.textContent?.trim() ?? "";
      if (
        seen.has(option.value) ||
        option.value.length > 2048 ||
        label.length > 512
      )
        return;
      seen.add(option.value);
      const group = option.parentElement;
      const style = option.ownerDocument.defaultView?.getComputedStyle(option);
      const groupStyle =
        group?.tagName === "OPTGROUP"
          ? option.ownerDocument.defaultView?.getComputedStyle(group)
          : undefined;
      const disabled =
        option.disabled ||
        (group?.tagName === "OPTGROUP" &&
          (group as HTMLOptGroupElement).disabled) ||
        option.hidden ||
        option.getAttribute("aria-disabled") === "true" ||
        option.getAttribute("aria-hidden") === "true" ||
        !!group?.hidden ||
        group?.getAttribute("aria-hidden") === "true" ||
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        groupStyle?.display === "none" ||
        groupStyle?.visibility === "hidden";
      descriptor.options.push({
        value: option.value,
        label,
        disabled: !!disabled,
      });
    }
    if (
      !descriptor.options.some(
        (option) => !option.disabled && (!el.required || option.value !== ""),
      )
    )
      return;
  } else {
    const input = el as HTMLInputElement;
    if (input.maxLength >= 0) descriptor.maxLength = input.maxLength;
    if (control === "date") {
      if (input.min) descriptor.min = input.min;
      if (input.max) descriptor.max = input.max;
    }
  }
  return descriptor;
}

/** Native, node-bound write. Never delegates private values to keyboard focus. */
export function writeSecureFormElement(
  node: Element,
  payload: { kind: "fill" | "select"; value: string },
): "filled" | "stale" | "unconfirmed" {
  const win = node.ownerDocument.defaultView;
  if (!win || !node.isConnected) return "stale";
  const rect = node.getBoundingClientRect();
  const style = win.getComputedStyle(node);
  if (
    !rect.width ||
    !rect.height ||
    style.visibility === "hidden" ||
    style.display === "none"
  )
    return "stale";
  const control = node as HTMLInputElement | HTMLSelectElement;
  if (control.disabled || node.getAttribute("aria-disabled") === "true")
    return "stale";
  const isSelect = node.tagName === "SELECT";
  if (
    (payload.kind === "select") !== isSelect ||
    (!isSelect && node.tagName !== "INPUT")
  )
    return "stale";
  const prototype = isSelect
    ? (win as any).HTMLSelectElement.prototype
    : (win as any).HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return "stale";
  setter.call(node, payload.value);
  if (control.value !== payload.value) return "unconfirmed";
  node.dispatchEvent(
    new (win as any).Event("input", { bubbles: true, composed: true }),
  );
  node.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
  return control.value === payload.value ? "filled" : "unconfirmed";
}

/** Inline both evaluators so descriptor validation and writing run in one page turn. */
export const secureFormDeliverySource = `(node, payload) => {
  const inspect = ${inspectSecureFormElement.toString()};
  const write = ${writeSecureFormElement.toString()};
  if (node.ownerDocument !== document) return 'stale';
  const current = inspect(node);
  if (!current || JSON.stringify(current) !== JSON.stringify(payload.expected)) return 'stale';
  return write(node, payload);
}`;

// ElementHandle.evaluate treats a string as an expression, not as a callable.
// Compile our static source so Playwright invokes it with the bound node and payload.
export const deliverSecureFormElement = new Function(
  `return (${secureFormDeliverySource});`,
)() as (
  node: Element,
  payload: {
    kind: "fill" | "select";
    value: string;
    expected: ReturnType<typeof inspectSecureFormElement>;
  },
) => "filled" | "stale" | "unconfirmed";
