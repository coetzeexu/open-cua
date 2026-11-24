import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseModule } from "meriyah";
import { executionError, type Warning } from "@cua/contracts";
type AST = { type: string; start: number; end: number; [key: string]: any };
export interface CellScope {
  id: string;
  closed: boolean;
}
export interface KernelHooks {
  globals?: Record<string, unknown>;
  warning(warning: Warning): void;
  callbackError(scope: CellScope | undefined, error: unknown): void;
}
export class ReplKernel {
  readonly als = new AsyncLocalStorage<CellScope>();
  private context: vm.Context;
  private bindings = new Map<string, unknown>();
  private constants = new Set<string>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private hooks: KernelHooks) {
    const wrap =
      (fn: Function, scope = this.als.getStore()) =>
      (...args: unknown[]) =>
        this.als.run(scope!, () => {
          try {
            fn(...args);
          } catch (e) {
            hooks.callbackError(scope, e);
          }
        });
    const timeout = (fn: Function, ms?: number, ...args: unknown[]) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        wrap(fn)(...args);
      }, ms);
      this.timers.add(t);
      return t;
    };
    const interval = (fn: Function, ms?: number, ...args: unknown[]) => {
      const t = setInterval(wrap(fn), ms, ...args);
      this.timers.add(t);
      return t;
    };
    this.context = vm.createContext(
      {
        ...hooks.globals,
        setTimeout: timeout,
        setInterval: interval,
        setImmediate: (fn: Function, ...args: unknown[]) =>
          timeout(fn, 0, ...args),
        queueMicrotask: (fn: Function) => queueMicrotask(wrap(fn)),
        clearTimeout: (t: ReturnType<typeof setTimeout>) => {
          clearTimeout(t);
          this.timers.delete(t);
        },
        clearInterval: (t: ReturnType<typeof setTimeout>) => {
          clearInterval(t);
          this.timers.delete(t);
        },
        clearImmediate: (t: ReturnType<typeof setTimeout>) => {
          clearTimeout(t);
          this.timers.delete(t);
        },
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        AbortController,
        structuredClone,
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
  }
  async execute(code: string, scope: CellScope): Promise<void> {
    let tree: AST;
    try {
      tree = parseModule(code, {
        next: true,
        ranges: true,
        loc: true,
      }) as unknown as AST;
    } catch (e) {
      const message = String((e as Error).message);
      throw executionError(
        /Unexpected token.*(?:end|EOF)|end of (?:input|source)/i.test(message)
          ? "SYNTAX_INCOMPLETE"
          : "SYNTAX_ERROR",
        "none",
        message,
      );
    }
    if (tree.body.some((n: AST) => n.type === "ImportDeclaration"))
      throw executionError(
        "STATIC_IMPORT_UNSUPPORTED",
        "none",
        "Use await import() for modules.",
      );
    if (tree.body.some((n: AST) => n.type.startsWith("Export")))
      throw executionError(
        "SYNTAX_ERROR",
        "none",
        "Cells export bindings automatically; explicit export is unsupported.",
      );
    const declarations = new Map<string, string>();
    const initialized = new Set<string>();
    const edits: { start: number; end: number; text: string }[] = [];
    const marker = `__cua_${randomUUID().replaceAll("-", "")}`;
    const collect = (node: AST, inFunction = false) => {
      if (!node || typeof node !== "object") return;
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      ) {
        if (
          node.type === "FunctionDeclaration" &&
          !inFunction &&
          tree.body.includes(node)
        ) {
          declarations.set(node.id.name, "function");
          edits.push({
            start: node.end,
            end: node.end,
            text: `;${marker}(${JSON.stringify(node.id.name)});`,
          });
        }
        return;
      }
      if (node.type === "ClassDeclaration" && tree.body.includes(node)) {
        declarations.set(node.id.name, "class");
        return;
      }
      if (
        node.type === "VariableDeclaration" &&
        (node.kind === "var" || tree.body.includes(node))
      ) {
        for (const decl of node.declarations) {
          if (decl.id.type !== "Identifier")
            throw executionError(
              "SYNTAX_ERROR",
              "none",
              "Top-level destructuring declarations are unsupported; declare named bindings separately.",
            );
          const name = decl.id.name;
          declarations.set(name, node.kind);
          if (node.kind === "var") {
            if (decl.init) {
              edits.push(
                {
                  start: decl.init.start,
                  end: decl.init.start,
                  text: `${marker}(${JSON.stringify(name)}, (`,
                },
                { start: decl.init.end, end: decl.init.end, text: "))" },
              );
            } else if (tree.body.includes(node))
              edits.push({
                start: node.end,
                end: node.end,
                text: `;${marker}(${JSON.stringify(name)});`,
              });
            else
              throw executionError(
                "SYNTAX_ERROR",
                "none",
                "Uninitialized var inside loops or blocks is unsupported; initialize it explicitly.",
              );
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value))
          value.forEach((v) => {
            if (v?.type) collect(v);
          });
        else if (value?.type) collect(value);
      }
    };
    collect(tree);
    // Capture writes before a later var declaration is reached, without changing expression values.
    const writes = (node: AST) => {
      if (!node || typeof node !== "object") return;
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
          "ClassDeclaration",
          "ClassExpression",
        ].includes(node.type)
      )
        return;
      const target =
        node.type === "AssignmentExpression"
          ? node.left
          : node.type === "UpdateExpression"
            ? node.argument
            : undefined;
      if (
        target?.type === "Identifier" &&
        declarations.get(target.name) === "var"
      )
        edits.push(
          {
            start: node.start,
            end: node.start,
            text: `${marker}(${JSON.stringify(target.name)}, (`,
          },
          { start: node.end, end: node.end, text: "))" },
        );
      for (const value of Object.values(node)) {
        if (Array.isArray(value))
          value.forEach((v) => {
            if (v?.type) writes(v);
          });
        else if (value?.type) writes(value);
      }
    };
    writes(tree);
    for (const [name, kind] of declarations)
      if (kind === "const" && this.constants.has(name))
        this.hooks.warning({
          code: "CONST_REDECLARED",
          message: `const ${name} replaces the previous cell binding.`,
          scopeId: scope.id,
        });
    let transformed = code;
    for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end))
      transformed =
        transformed.slice(0, e.start) + e.text + transformed.slice(e.end);
    const previous = [...this.bindings.keys()];
    const inherited = previous.filter((n) => !declarations.has(n));
    const all = [...new Set([...previous, ...declarations.keys()])];
    const prevName = `${marker}_prev`;
    const prefix = `import * as ${prevName} from '@prev';\nconst ${marker}=import.meta.capture;delete import.meta.capture;\n${inherited.map((n) => `let ${n}=${prevName}[${JSON.stringify(n)}];`).join("\n")}\n`;
    const previousValues = new Map(this.bindings);
    const prev = new vm.SyntheticModule(
      previous,
      function () {
        for (const name of previous)
          this.setExport(name, previousValues.get(name));
      },
      { context: this.context },
    );
    const module = new vm.SourceTextModule(
      `${prefix}${transformed}\nexport {${all.join(",")}};`,
      {
        context: this.context,
        identifier: `cell:${scope.id}`,
        initializeImportMeta(meta) {
          (meta as unknown as Record<string, unknown>).capture = (
            name: string,
            value: unknown,
          ) => {
            initialized.add(name);
            return value;
          };
        },
        importModuleDynamically: async (specifier) => {
          if (specifier === "node:process" || specifier === "process")
            throw Error("Importing process is disabled.");
          return import(specifier);
        },
      },
    );
    try {
      await module.link((specifier) => {
        if (specifier === "@prev") return prev;
        throw Error("Unsupported static module");
      });
    } catch (e) {
      throw executionError("SYNTAX_ERROR", "none", String(e));
    }
    try {
      await this.als.run(scope, () => module.evaluate());
    } finally {
      for (const name of all) {
        const kind = declarations.get(name);
        if ((kind === "var" || kind === "function") && !initialized.has(name))
          continue;
        try {
          this.bindings.set(
            name,
            (module.namespace as Record<string, unknown>)[name],
          );
          if (kind === "const") this.constants.add(name);
          else if (kind) this.constants.delete(name);
        } catch {
          /* An uninitialized lexical binding stays absent; earlier committed values survive. */
        }
      }
    }
  }
  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
