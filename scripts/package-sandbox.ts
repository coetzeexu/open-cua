import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const target = process.argv.find((a) => a.startsWith("--target="))?.slice(9);
if (target && !["win32-x64", "linux-x64", "darwin-arm64"].includes(target))
  throw Error("Supported targets: win32-x64, linux-x64, darwin-arm64");
const mac = target === "darwin-arm64";
const outputDirectory = resolve(mac ? "artifacts/macos" : "artifacts/sandbox");
const archiveName = mac
  ? "cua-macos-arm64.tgz"
  : `cua-sandbox${target ? "-" + target : ""}.tgz`;
const output = resolve(outputDirectory, archiveName);
const stage = await mkdtemp(join(tmpdir(), "cua-package-"));
try {
  // A portable package: compiled workspaces + exact dependency lock. Resolve
  // dependencies for the requested target instead of copying local node_modules.
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const runtimePackages = (await readdir("packages")).filter(
    (name) => name !== "preview" && name !== "testing",
  );
  root.scripts = {
    "test:sandbox": "node deploy/sandbox/mock-messages.mjs",
    "mcp:http": "node deploy/sandbox/http.mjs",
  };
  root.dependencies = {
    "@cua/cli": "workspace:*",
    "@cua/browser-chromium": "workspace:*",
    "@modelcontextprotocol/sdk":
      root.devDependencies["@modelcontextprotocol/sdk"],
  };
  delete root.devDependencies;
  await writeFile(join(stage, "package.json"), JSON.stringify(root, null, 2));
  await cp("bun.lock", join(stage, "bun.lock"));
  await cp("AGENT_QUICKSTART.md", join(stage, "AGENT_QUICKSTART.md"));
  if (mac) await cp("docs/macos-install.md", join(stage, "INSTALL_MACOS.md"));
  for (const name of runtimePackages) {
    const dest = join(stage, "packages", name);
    await mkdir(dest, { recursive: true });
    await cp(`packages/${name}/package.json`, join(dest, "package.json"));
    await cp(`packages/${name}/dist`, join(dest, "dist"), { recursive: true });
    await cp(`packages/${name}/src`, join(dest, "src"), { recursive: true });
    if (name === "runner")
      await cp(`packages/${name}/README.md`, join(dest, "README.md"));
  }
  for (const dir of ["deploy/sandbox", "examples", "docs", "skills"])
    await cp(dir, join(stage, dir), {
      recursive: true,
      filter: (source) =>
        !["docs/cases", "docs/reports", "examples/recipes"].some(
          (directory) => resolve(source) === resolve(directory),
        ) &&
        ![
          "preview.mjs",
          "bridge.mjs",
          "start-preview.ps1",
          "check-preview.mjs",
        ].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
  const lock = spawnSync(
    process.execPath,
    ["install", "--lockfile-only", "--ignore-scripts"],
    { cwd: stage, stdio: "inherit" },
  );
  if (lock.status !== 0) throw Error("Runtime lockfile generation failed");
  if (target) {
    const [os, cpu] = target.split("-");
    const install = spawnSync(
      process.execPath,
      [
        "install",
        "--production",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--linker=hoisted",
        `--os=${os}`,
        `--cpu=${cpu}`,
      ],
      { cwd: stage, stdio: "inherit" },
    );
    if (install.status !== 0)
      throw Error("Target runtime dependency installation failed");
    // Windows extraction must not require symlink privileges. Materialize workspace
    // packages; Node resolves the hoisted runtime dependencies normally.
    for (const name of runtimePackages) {
      const pkg = JSON.parse(
        await readFile(`packages/${name}/package.json`, "utf8"),
      );
      const dest = join(stage, "node_modules", pkg.name);
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      for (const item of ["package.json", "dist", "src"])
        await cp(join(stage, "packages", name, item), join(dest, item), {
          recursive: true,
        });
    }
    const materialize = async (directory: string) => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        if (name === ".bin") {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
          const source = await realpath(path);
          await rm(path);
          await cp(source, path, { recursive: true, dereference: true });
        } else if (stat.isDirectory()) await materialize(path);
      }
    };
    await materialize(join(stage, "node_modules"));
    const stem = `node-v24.18.0-${os === "win32" ? "win" : os}-${cpu}`;
    const archive =
      stem +
      (os === "win32" ? ".zip" : os === "darwin" ? ".tar.gz" : ".tar.xz");
    const base = "https://nodejs.org/dist/v24.18.0/";
    console.log(`Preparing ${archive}`);
    const [bytes, checksums] = await Promise.all([
      process.env.CUA_NODE_ARCHIVE
        ? readFile(process.env.CUA_NODE_ARCHIVE)
        : fetch(base + archive, { signal: AbortSignal.timeout(180000) }).then(
            async (response) => {
              if (!response.ok) throw Error("Node runtime download failed");
              return new Uint8Array(await response.arrayBuffer());
            },
          ),
      fetch(base + "SHASUMS256.txt", { signal: AbortSignal.timeout(30000) }),
    ]);
    if (!checksums.ok) throw Error("Node runtime checksum download failed");
    const checksum = (await checksums.text())
      .split("\n")
      .find((line) => line.trim().endsWith(" " + archive))
      ?.trim()
      .split(/\s+/)[0];
    if (
      !checksum ||
      createHash("sha256").update(bytes).digest("hex") !== checksum
    )
      throw Error("Node runtime checksum mismatch");
    const download = join(stage, archive);
    await writeFile(download, bytes);
    await mkdir(join(stage, "runtime"));
    const extract =
      os === "win32"
        ? spawnSync("unzip", [
            "-q",
            "-j",
            download,
            `${stem}/node.exe`,
            "-d",
            join(stage, "runtime"),
          ])
        : spawnSync("tar", [
            os === "darwin" ? "-xzf" : "-xJf",
            download,
            "--strip-components=2",
            "-C",
            join(stage, "runtime"),
            `${stem}/bin/node`,
          ]);
    if (extract.status !== 0) throw Error("Node runtime extraction failed");
    await rm(download);
    await writeFile(
      join(stage, "runtime", "target.json"),
      JSON.stringify({ target, node: "24.18.0", bunRequired: false }, null, 2),
    );
  }
  await mkdir(outputDirectory, { recursive: true });
  const tar = spawnSync(
    "tar",
    [
      ...(process.platform === "darwin"
        ? ["--no-xattrs", "--no-mac-metadata"]
        : []),
      "-czf",
      output,
      "-C",
      stage,
      ".",
    ],
    {
      stdio: "inherit",
    },
  );
  if (tar.status !== 0) throw Error("Sandbox archive failed");
  const digest = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  await writeFile(output + ".sha256", `${digest}  ${archiveName}\n`);
  if (mac)
    await cp(
      "docs/macos-install.md",
      join(outputDirectory, "INSTALL_MACOS.md"),
    );
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
