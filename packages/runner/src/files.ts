import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  bytes,
  endpoint,
  fetchBounded,
  fields,
  hash,
  object,
  parseJSON,
  requireValue,
  RunnerFault,
  token,
} from "./common.js";
import type {
  OutputFile,
  RunnerConfig,
  ScriptContext,
  ScriptReturn,
} from "./index.js";
import type { Scripts, ScriptBundle } from "./scripts.js";

export class Files {
  constructor(
    private config: RunnerConfig,
    private scripts: Scripts,
  ) {}
  private headers(env: string | undefined, principal: string) {
    const auth = token(env);
    return {
      "X-CUA-Principal": principal,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    };
  }
  async prepare(
    runId: string,
    principal: string,
    bundle: ScriptBundle,
    input: ScriptContext["input"],
    signal: AbortSignal,
  ): Promise<ScriptContext> {
    const root = join(this.config.work_directory, runId);
    await mkdir(join(root, "input"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "output"), { recursive: true, mode: 0o700 });
    const refs = this.scripts.files(bundle.manifest.input_schema, input);
    requireValue(
      refs.length <= this.config.limits.max_files_per_run,
      "FILE_INVALID",
      "Too many input files",
    );
    let total = 0;
    const files: Record<string, string> = Object.create(null);
    for (const { pointer, ref } of refs) {
      signal.throwIfAborted();
      total += ref.size_bytes;
      requireValue(
        ref.size_bytes <= this.config.input_files.max_bytes &&
          total <= this.config.limits.max_run_file_bytes,
        "FILE_INVALID",
        "Input files exceed quota",
      );
      const response = await fetchBounded(
        endpoint(this.config.input_files.base_url, `files/${ref.file_id}`),
        { headers: this.headers(this.config.input_files.token_env, principal) },
        this.config.limits.io_timeout_ms,
        signal,
      );
      requireValue(
        response.ok,
        "FILE_INVALID",
        "Input file is unavailable or unauthorized",
      );
      const data = await bytes(response, ref.size_bytes);
      requireValue(
        data.length === ref.size_bytes && hash(data) === ref.sha256,
        "FILE_INVALID",
        "Input file integrity check failed",
      );
      const path = join(root, "input", `${hash(pointer)}.bin`);
      await writeFile(`${path}.tmp`, data, { flag: "wx", mode: 0o600 });
      await rename(`${path}.tmp`, path);
      files[pointer] = path;
    }
    return { runId, input, files, outputDirectory: join(root, "output") };
  }
  async publish(
    runId: string,
    principal: string,
    result: ScriptReturn,
    signal: AbortSignal,
    receipt: (file: OutputFile) => void,
    inputUsage: { count: number; bytes: number },
  ): Promise<OutputFile[]> {
    const outputFields = (value: unknown, keys: string[]) => {
      try {
        fields(value, keys);
      } catch {
        throw new RunnerFault("OUTPUT_INVALID", "Invalid output structure");
      }
    };
    outputFields(result, ["output", "files"]);
    requireValue(
      Array.isArray(result.files) &&
        result.files.length + inputUsage.count <=
          this.config.limits.max_files_per_run,
      "OUTPUT_INVALID",
      "Invalid output file list or run file count exceeded",
    );
    const expectedRoot = join(this.config.work_directory, runId, "output");
    const root = await realpath(expectedRoot);
    requireValue(
      root === expectedRoot && !(await lstat(expectedRoot)).isSymbolicLink(),
      "OUTPUT_INVALID",
      "Output directory was replaced",
    );
    const snapshot = join(this.config.work_directory, runId, "artifacts");
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    const paths = new Set<string>();
    let total = inputUsage.bytes;
    const pending: Array<{
      data: Buffer;
      file: Omit<OutputFile, "download_url">;
    }> = [];
    // Validate and freeze every file before publishing any of them.
    for (const entry of result.files) {
      signal.throwIfAborted();
      outputFields(entry, ["path", "mime_type"]);
      requireValue(
        typeof entry.path === "string" &&
          !isAbsolute(entry.path) &&
          !entry.path.includes("\\") &&
          entry.path
            .split("/")
            .every((p) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(p)) &&
          !paths.has(entry.path),
        "OUTPUT_INVALID",
        "Invalid or duplicate output path",
      );
      requireValue(
        typeof entry.mime_type === "string" &&
          /^[\w.+-]+\/[\w.+-]+$/.test(entry.mime_type),
        "OUTPUT_INVALID",
        "Invalid output MIME type",
      );
      paths.add(entry.path);
      let path = root;
      for (const part of entry.path.split("/")) {
        path = join(path, part);
        const stat = await lstat(path).catch(() => {
          throw new RunnerFault("OUTPUT_INVALID", "Output file is unavailable");
        });
        requireValue(
          !stat.isSymbolicLink(),
          "OUTPUT_INVALID",
          "Output symlinks are forbidden",
        );
      }
      const resolved = await realpath(path);
      requireValue(
        !relative(root, resolved).startsWith(`..${sep}`) &&
          relative(root, resolved) !== "..",
        "OUTPUT_INVALID",
        "Output escapes work directory",
      );
      requireValue(
        (await lstat(resolved)).isFile(),
        "OUTPUT_INVALID",
        "Output must be a regular file",
      );
      const handle = await open(
        resolved,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      let data: Buffer;
      try {
        const stat = await handle.stat();
        requireValue(
          stat.isFile() &&
            stat.size <= this.config.output_files.max_bytes &&
            total + stat.size <= this.config.limits.max_run_file_bytes,
          "OUTPUT_INVALID",
          "Output exceeds quota or is not a regular file",
        );
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          size += chunk.length;
          requireValue(
            size <= this.config.output_files.max_bytes &&
              total + size <= this.config.limits.max_run_file_bytes,
            "OUTPUT_INVALID",
            "Output grew beyond quota",
          );
          parts.push(chunk);
        }
        data = Buffer.concat(parts);
        total += size;
      } finally {
        await handle.close();
      }
      const fileId = hash(`${runId}/${entry.path}`);
      const name = `${runId}-${entry.path.split("/").at(-1)}`;
      await writeFile(join(snapshot, fileId), data, {
        mode: 0o600,
        flag: "wx",
      });
      pending.push({
        data,
        file: {
          file_id: fileId,
          name,
          size_bytes: data.length,
          sha256: hash(data),
          mime_type: entry.mime_type,
        },
      });
    }
    const published: OutputFile[] = [];
    for (const { data, file } of pending) {
      signal.throwIfAborted();
      try {
        const response = await fetchBounded(
          endpoint(
            this.config.output_files.base_url,
            `runs/${runId}/files/${file.file_id}/${encodeURIComponent(file.name)}`,
          ),
          {
            method: "PUT",
            headers: {
              ...this.headers(this.config.output_files.token_env, principal),
              "Content-Type": file.mime_type,
              "X-Content-SHA256": file.sha256,
            },
            body: new Uint8Array(data),
          },
          this.config.limits.io_timeout_ms,
          signal,
        );
        requireValue(
          response.ok,
          "OUTPUT_PUBLISH_FAILED",
          "Output service rejected the artifact",
        );
        const received = parseJSON(
          (
            await bytes(response, this.config.limits.request_max_bytes)
          ).toString(),
        );
        requireValue(
          object(received) &&
            Object.entries(file).every(([key, v]) => received[key] === v) &&
            typeof received.download_url === "string",
          "OUTPUT_PUBLISH_FAILED",
          "Invalid artifact receipt",
        );
        const url = new URL(received.download_url);
        requireValue(
          url.origin === new URL(this.config.output_files.base_url).origin &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search,
          "OUTPUT_PUBLISH_FAILED",
          "Invalid artifact download URL",
        );
        const artifact = { ...file, download_url: url.href };
        receipt(artifact);
        published.push(artifact);
      } catch {
        throw new RunnerFault(
          "OUTPUT_PUBLISH_FAILED",
          "Output publication failed; business actions must not be replayed",
        );
      }
    }
    return published;
  }
}
