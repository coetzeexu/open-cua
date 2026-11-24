import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { safeId, type FileHistoryStore } from "@cua/history";
import { recipeParameters, type RecipeStore } from "@cua/recipes";
import { DashboardData, artifactReference, runTrace } from "./model.js";
export {
  DashboardData,
  runTrace,
  summarizeRun,
  executionStats,
} from "./model.js";

export interface DashboardRun {
  name: string;
  version: string;
  params: Record<string, unknown>;
  profile: string;
  runId: string;
}
export interface DashboardJob extends DashboardRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created: number;
  finished?: number;
  error?: string;
}
export interface DashboardOptions {
  history: FileHistoryStore;
  recipes: RecipeStore;
  profiles: { name: string; provider: string }[];
  defaultProfile: string;
  configLabel?: string;
  port?: number;
  /** Maximum JSON bytes per run request. Defaults to 64 KiB. */
  maxRunBodyBytes?: number;
  assetsDirectory?: string;
  execute: (input: DashboardRun) => Promise<{
    passed: boolean;
    closed?: boolean;
    result?: { error?: { message?: string } };
  }>;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function startDashboard(options: DashboardOptions) {
  const maxRunBodyBytes = options.maxRunBodyBytes ?? 65536;
  if (
    !Number.isSafeInteger(maxRunBodyBytes) ||
    maxRunBodyBytes < 1 ||
    maxRunBodyBytes > 16 * 1024 * 1024
  )
    throw Error("maxRunBodyBytes must be an integer between 1 and 16777216");
  const token = randomBytes(32).toString("hex");
  const data = new DashboardData(options.history, options.recipes);
  const assets =
    options.assetsDirectory ?? dirname(fileURLToPath(import.meta.url));
  const jobs = new Map<string, DashboardJob>();
  const requests = new Map<string, unknown>();
  let current: Promise<void> | undefined;
  let closing = false;
  let origin = "";
  const pump = () => {
    if (current || closing) return;
    const job = [...jobs.values()].find((j) => j.status === "queued");
    if (!job) return;
    job.status = "running";
    current = (async () => {
      try {
        // Pin the version reviewed in the form; never silently execute a newly activated version.
        if (options.recipes.read(job.name).version !== job.version)
          throw Error("激活版本已变化，请刷新后重新选择执行。");
        const result = await options.execute(job);
        job.status =
          result.passed && result.closed !== false ? "succeeded" : "failed";
        if (job.status === "failed")
          job.error =
            result.result?.error?.message ??
            "执行或业务校验失败，请查看 Trace。";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      } finally {
        job.finished = Date.now();
      }
    })().finally(() => {
      current = undefined;
      pump();
    });
  };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      json(
        res,
        error instanceof HttpError ? error.status : missing ? 404 : 400,
        {
          error: missing
            ? "记录不存在或尚未创建"
            : error instanceof Error
              ? error.message
              : "请求失败",
        },
      );
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const address = new URL(origin);
    const hosts = [address.host, `localhost:${address.port}`];
    if (!hosts.includes(req.headers.host ?? ""))
      throw new HttpError(403, "Host 不允许");
    if (
      req.headers.origin &&
      !hosts.map((h) => `http://${h}`).includes(req.headers.origin)
    )
      throw new HttpError(403, "跨站请求不允许");
    const url = new URL(req.url ?? "/", origin);
    if (
      req.method === "GET" &&
      ["/", "/app.js", "/style.css"].includes(url.pathname)
    ) {
      const filename =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      let body = await readFile(join(assets, filename), "utf8");
      if (filename === "index.html")
        body = body.replace("__SESSION_TOKEN__", token);
      res.setHeader(
        "content-type",
        filename.endsWith("html")
          ? "text/html; charset=utf-8"
          : filename.endsWith("css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
      );
      res.end(body);
      return;
    }
    if (req.headers["x-cua-token"] !== token)
      throw new HttpError(403, "页面会话已失效，请刷新页面。");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, {
        ...data.snapshot(),
        jobs: [...jobs.values()].map(({ params, ...j }) => j),
        profiles: options.profiles,
        defaultProfile: options.defaultProfile,
        configLabel: options.configLabel,
        historyEnabled: options.history.enabled,
      });
      return;
    }
    if (
      req.method === "GET" &&
      parts[0] === "api" &&
      parts[1] === "recipes" &&
      parts.length === 3
    ) {
      const recipe = options.recipes.read(
        safeId(parts[2]),
        url.searchParams.get("version") ?? undefined,
      );
      json(res, 200, {
        ...recipe,
        validations: options.recipes.validations(recipe.name, recipe.version),
      });
      return;
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "runs") {
      const run = options.history.read(safeId(parts[2]));
      if (parts.length === 3) {
        json(res, 200, runTrace(run));
        return;
      }
      if (parts.length === 5 && parts[3] === "artifacts") {
        const event = run.events.find((e) => e.id === parts[4]);
        const ref = event && artifactReference(event);
        if (!ref) throw new HttpError(404, "无可用截图证据");
        const root = await realpath(join(options.history.directory, run.runId));
        const candidate = resolve(root, ref.path);
        if (!candidate.startsWith(root + sep))
          throw new HttpError(403, "附件路径不允许");
        const path = await realpath(candidate);
        if (
          !path.startsWith(root + sep) ||
          (await stat(path)).size > 10 * 1024 * 1024
        )
          throw new HttpError(403, "附件路径或大小不允许");
        res.setHeader("content-type", ref.mimeType);
        res.end(await readFile(path));
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      if (closing) throw new HttpError(503, "服务正在停止");
      if (!options.history.enabled)
        throw new HttpError(409, "请启用 history 后执行，以保留运行记录。");
      if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
        throw new HttpError(415, "需要 JSON 请求");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRunBodyBytes) throw new HttpError(413, "参数过大");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (k) =>
            !["name", "version", "params", "profile", "requestId"].includes(k),
        )
      )
        throw new HttpError(400, "无效的执行请求");
      const id = safeId(body.requestId);
      const prior = jobs.get(id);
      if (prior) {
        if (!isDeepStrictEqual(requests.get(id), body))
          throw new HttpError(
            409,
            "请求标识已用于其他参数，请重新打开执行表单。",
          );
        json(res, 200, prior);
        return;
      }
      if (
        [...jobs.values()].filter((j) =>
          ["queued", "running"].includes(j.status),
        ).length >= 10
      )
        throw new HttpError(429, "执行队列已满，请稍后再试。");
      const recipe = options.recipes.read(safeId(body.name));
      if (body.version !== recipe.version)
        throw new HttpError(409, "只可执行当前激活版本，请刷新版本列表。");
      if (
        !body.params ||
        typeof body.params !== "object" ||
        Array.isArray(body.params)
      )
        throw new HttpError(400, "参数必须为 JSON 对象");
      const params = recipeParameters(recipe, body.params);
      const profile = body.profile ?? options.defaultProfile;
      if (!options.profiles.some((p) => p.name === profile))
        throw new HttpError(400, "Profile 不存在");
      const job: DashboardJob = {
        id,
        name: recipe.name,
        version: recipe.version,
        params,
        profile,
        runId: randomUUID(),
        created: Date.now(),
        status: "queued",
      };
      for (const [key, j] of jobs)
        if (jobs.size >= 200 && j.finished) {
          jobs.delete(key);
          requests.delete(key);
        }
      jobs.set(id, job);
      requests.set(id, body);
      json(res, 202, job);
      pump();
      return;
    }
    throw new HttpError(404, "接口不存在");
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 30152, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("未获得监听地址");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    server,
    async close() {
      closing = true;
      for (const job of jobs.values())
        if (job.status === "queued") {
          job.status = "cancelled";
          job.finished = Date.now();
        }
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await current;
      await stopped;
    },
  };
}
