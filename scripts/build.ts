import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
for (const name of readdirSync("packages")) {
  const entrypoints = [`packages/${name}/src/index.ts`];
  if (name === "repl") entrypoints.push(`packages/${name}/src/worker.ts`);
  const result = await Bun.build({
    entrypoints,
    outdir: `packages/${name}/dist`,
    target: "node",
    format: "esm",
    packages: "external",
    sourcemap: "external",
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Build failed: ${name}`);
}
for (const file of ["index.html", "app.js", "style.css"])
  copyFileSync(
    `packages/dashboard/src/${file}`,
    `packages/dashboard/dist/${file}`,
  );
for (const [entry, html] of [
  ["ui", "browser"],
  ["login-ui", "login"],
  ["secure-form-ui", "secure-form"],
]) {
  const ui = await Bun.build({
    entrypoints: [`packages/mcp/src/${entry}.ts`],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!ui.success) throw new AggregateError(ui.logs, "MCP App UI build failed");
  const script = (await ui.outputs[0].text()).replaceAll(
    "</script",
    "<\\/script",
  );
  writeFileSync(
    `packages/mcp/dist/${html}.html`,
    readFileSync(`packages/mcp/src/${html}.html`, "utf8").replace(
      "__APP_SCRIPT__",
      () => script,
    ),
  );
}
console.log("Built all workspace packages for Node.js.");
