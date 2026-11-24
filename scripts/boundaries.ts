import { readdirSync, readFileSync } from "node:fs";
const allowed = {
  contracts: [],
  core: ["contracts"],
  "browser-chromium": ["contracts"],
  "browser-local": ["contracts", "browser-chromium"],
  "browser-agentbay": ["contracts", "browser-chromium"],
  "browser-sandbox": ["contracts", "browser-chromium"],
  repl: ["contracts"],
  history: [],
  runner: [],
  recipes: ["history", "contracts", "service"],
  dashboard: ["history", "recipes"],
  service: ["contracts", "core", "repl", "history"],
  mcp: ["contracts", "service"],
  cli: [
    "runner",
    "dashboard",
    "history",
    "recipes",
    "contracts",
    "service",
    "mcp",
    "browser-local",
    "browser-chromium",
    "browser-agentbay",
    "browser-sandbox",
  ],
  preview: ["contracts", "service", "browser-chromium", "browser-sandbox"],
  testing: ["contracts", "core"],
} as Record<string, string[]>;
for (const name of readdirSync("packages")) {
  const pkg = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith("@cua/") && !allowed[name].includes(dep.slice(5)))
      throw Error(`${name} -> ${dep} violates dependency boundary`);
  }
  for (const file of readdirSync(`packages/${name}/src`, {
    recursive: true,
  }).filter((f) => String(f).endsWith(".ts"))) {
    const source = readFileSync(`packages/${name}/src/${file}`, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\()\s*['"](@cua\/[^'"/]+|\.\.\/\.\.\/)/g,
    )) {
      const dep = match[1];
      if (!dep.startsWith("@cua/") || !allowed[name].includes(dep.slice(5)))
        throw Error(`${name}/${file}: illegal import ${dep}`);
    }
  }
}
console.log("Package dependency boundaries verified.");
