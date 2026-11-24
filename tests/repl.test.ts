import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplKernel } from "@cua/repl";
import type { Warning } from "@cua/contracts";
const make = () => {
  const values: unknown[] = [];
  const warnings: Warning[] = [];
  const errors: { scopeId?: string; message: string }[] = [];
  const kernel = new ReplKernel({
    globals: { out: (value: unknown) => values.push(value) },
    warning: (w) => warnings.push(w),
    callbackError: (scope, error) =>
      errors.push({ scopeId: scope?.id, message: String(error) }),
  });
  let sequence = 0;
  return {
    kernel,
    values,
    warnings,
    errors,
    run: (code: string) =>
      kernel.execute(code, { id: String(++sequence), closed: false }),
  };
};
test("lexical state, repeated const, no implicit expression output, and dynamic imports", async () => {
  const { run, values, warnings, kernel } = make();
  await run("const x=3; let y=4; var z=5;");
  await run("const x=7; y++; out([x,y,z]); 100;");
  assert.deepEqual(JSON.parse(JSON.stringify(values)), [[7, 5, 5]]);
  assert.equal(warnings[0].code, "CONST_REDECLARED");
  await run('var mod=await import("node:path");out(mod.basename("/a/b"));');
  assert.equal(values[1], "b");
  await assert.rejects(run('await import("node:process")'));
  kernel.dispose();
});
test("failed cells preserve initialized lexical values but not unreached var/function", async () => {
  const { run, values, kernel } = make();
  await run("let keep=9; const old=8;");
  await assert.rejects(
    run("let a=1,b=missing; var unreachable=3; function absent(){}"),
  );
  await run("out([keep,a,typeof b,typeof unreachable,typeof absent]);");
  assert.deepEqual(JSON.parse(JSON.stringify(values[0])), [
    9,
    1,
    "undefined",
    "undefined",
    "undefined",
  ]);
  await assert.rejects(run("var first=2,second=missing;"));
  await run("out([first,typeof second]);");
  assert.deepEqual(JSON.parse(JSON.stringify(values[1])), [2, "undefined"]);
  await assert.rejects(run("const old=missing;"));
  await run("out(old);");
  assert.equal(values[2], 8);
  kernel.dispose();
});
test("var declaration/write and reached function commit even on failure", async () => {
  const { run, values, kernel } = make();
  await assert.rejects(run('early=4; throw Error("stop"); var early;'));
  await run("out(early);");
  await assert.rejects(
    run('function f(){return 6}; var declared; throw Error("stop");'),
  );
  await run("out([f(),typeof declared]);");
  assert.equal(values[0], 4);
  assert.deepEqual(JSON.parse(JSON.stringify(values[1])), [6, "undefined"]);
  kernel.dispose();
});
test("parse and static link errors do not corrupt prior state", async () => {
  const { run, values, kernel } = make();
  await run("let x=1;");
  await assert.rejects(run("let ="), (e) =>
    ["SYNTAX_ERROR", "SYNTAX_INCOMPLETE"].includes((e as any).code),
  );
  await assert.rejects(run('import fs from "node:fs"'), {
    code: "STATIC_IMPORT_UNSUPPORTED",
  });
  await run("out(x)");
  assert.equal(values[0], 1);
  kernel.dispose();
});
test("ALS flows through module await and injected callback exceptions", async () => {
  const { run, errors, kernel } = make();
  await run(
    'await new Promise(r=>setTimeout(r,1));setTimeout(()=>{throw Error("owned")},1);',
  );
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(errors[0].scopeId, "1");
  assert.match(errors[0].message, /owned/);
  kernel.dispose();
});
test("string code generation and process global are unavailable", async () => {
  const { run, values, kernel } = make();
  await run("out(typeof process)");
  assert.equal(values[0], "undefined");
  await assert.rejects(run('eval("1")'));
  kernel.dispose();
});
