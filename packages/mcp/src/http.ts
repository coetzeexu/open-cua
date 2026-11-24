import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CUAService } from "@cua/service";
import { createMCPServer } from "./adapter.js";

export interface HttpGatewayOptions {
  /** Single deployment credential. Never returned by HTTP or MCP. */
  token: string;
  apps?: boolean;
  host?: string;
  port?: number;
  /** Exact Host authorities, including non-default ports. Loopback authorities are always allowed. */
  allowedHosts?: string[];
  /** Native harnesses normally omit Origin. Browser origins require an explicit allowlist. */
  allowedOrigins?: string[];
  idleMs?: number;
  maxConnections?: number;
  maxBodyBytes?: number;
}
type Connection = ReturnType<typeof createMCPServer> & {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  lastActivity: number;
  pending: number;
  closing?: Promise<void>;
};
function respond(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}
function scalar(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}
async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw Error("body-limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Stateful Streamable HTTP (SDK 1.x / MCP 2025-11-25). Does not own the supplied Service. */
export async function startHttpGateway(
  service: CUAService,
  options: HttpGatewayOptions,
) {
  if (
    typeof options.token !== "string" ||
    options.token.length < 32 ||
    /\s/.test(options.token)
  )
    throw Error(
      "CUA_MCP_TOKEN must contain at least 32 non-whitespace characters",
    );
  const port = options.port ?? 30151;
  const idleMs = options.idleMs ?? 15 * 60_000;
  const capacity = options.maxConnections ?? 8;
  const bodyLimit = options.maxBodyBytes ?? 1024 * 1024;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isFinite(idleMs) ||
    idleMs < 50 ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    !Number.isInteger(bodyLimit) ||
    bodyLimit < 1
  )
    throw Error("Invalid HTTP gateway limits");
  const hosts = new Set(
    (options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  );
  const origins = new Set(options.allowedOrigins ?? []);
  const expected = Buffer.from(`Bearer ${options.token}`);
  const connections = new Map<string, Connection>();
  const all = new Set<Connection>();
  let closing = false;
  // Serialize admission across cleanup awaits so concurrent initializations cannot
  // exceed capacity or reclaim a connection that is still being initialized.
  let admission: Promise<unknown> = Promise.resolve();
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = admission.then(operation);
    admission = next.catch(() => {});
    return next;
  };
  const ownedSessions = (connection: Connection) => {
    const ids = new Set(connection.adapter.sessionIds());
    return service.status().filter((s) => ids.has(s.sessionId));
  };
  const dispose = (connection: Connection): Promise<void> => {
    if (connection.closing) return connection.closing;
    // Remove authority before awaiting cancellation or browser cleanup.
    if (connection.transport.sessionId)
      connections.delete(connection.transport.sessionId);
    connection.closing = Promise.resolve()
      .then(async () => {
        await connection.close();
        await connection.server.close();
      })
      .finally(() => all.delete(connection));
    return connection.closing;
  };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      if (closing) return respond(res, 503, "Gateway shutting down");
      const host = scalar(req.headers.host)?.toLowerCase();
      if (!host || !hosts.has(host))
        return respond(res, 403, "Host not allowed");
      const origin = scalar(req.headers.origin);
      if (
        (req.headers.origin !== undefined &&
          (!origin || !origins.has(origin))) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return respond(res, 403, "Origin not allowed");
      const provided = Buffer.from(scalar(req.headers.authorization) ?? "");
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return respond(res, 401, "Authentication required");
      }
      if (req.url !== "/mcp") return respond(res, 404, "Not found");
      if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
        res.setHeader("Allow", "GET, POST, DELETE");
        return respond(res, 405, "Method not allowed");
      }
      const sid = scalar(req.headers["mcp-session-id"]);
      if (
        req.headers["mcp-session-id"] !== undefined &&
        (!sid || !/^[A-Za-z0-9-]{1,128}$/.test(sid))
      )
        return respond(res, 400, "Invalid MCP session header");
      let connection = sid ? connections.get(sid) : undefined;
      if (sid && !connection)
        return respond(
          res,
          404,
          "MCP session unavailable; initialize a new session",
        );
      let parsed: unknown;
      if (req.method === "POST") {
        if (
          !(scalar(req.headers["content-type"]) ?? "")
            .toLowerCase()
            .startsWith("application/json")
        )
          return respond(res, 415, "Use application/json");
        if (Number(req.headers["content-length"] ?? 0) > bodyLimit)
          return respond(res, 413, "Request too large");
        try {
          parsed = await readBody(req, bodyLimit);
        } catch (error) {
          return respond(
            res,
            error instanceof Error && error.message === "body-limit"
              ? 413
              : 400,
            "Invalid request body",
          );
        }
      }
      if (!connection) {
        if (req.method !== "POST" || !isInitializeRequest(parsed))
          return respond(res, 400, "Initialize an MCP session first");
        connection = await admit(async () => {
          if (closing) return undefined;
          if (all.size >= capacity) {
            // Only reclaim resource-free, non-pending transports. Browser owners,
            // user waits and initializing requests retain their authority.
            const empty = [...all]
              .filter(
                (c) =>
                  !c.closing &&
                  !c.pending &&
                  c.transport.sessionId &&
                  !ownedSessions(c).length,
              )
              .sort((a, b) => a.lastActivity - b.lastActivity)[0];
            if (empty) await dispose(empty);
          }
          if (closing || all.size >= capacity) return undefined;
          const pair = createMCPServer(service, {
            elicitation: false,
            apps: options.apps,
          });
          let created!: Connection;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized(id) {
              connections.set(id, created);
            },
            onsessionclosed: () => dispose(created),
          });
          created = {
            ...pair,
            transport,
            lastSeen: Date.now(),
            lastActivity: Date.now(),
            pending: 0,
          };
          all.add(created);
          pair.server.onclose = () => {
            void dispose(created).catch(() => {});
          };
          try {
            await pair.server.connect(transport);
          } catch (error) {
            await dispose(created);
            throw error;
          }
          return created;
        });
        if (!connection)
          return respond(
            res,
            closing ? 503 : 429,
            closing
              ? "Gateway shutting down"
              : "MCP connection limit reached; all slots own CUA sessions or have pending requests. Close an owning client/session and retry.",
          );
      }
      if (connection.closing || closing)
        return respond(res, 404, "MCP session unavailable");
      connection.lastSeen = Date.now();
      const activity =
        req.method === "POST" &&
        (parsed as { method?: string })?.method !== "ping";
      if (activity) connection.lastActivity = Date.now();
      // GET SSE may stay open. It must not prevent idle session expiry forever.
      if (req.method !== "GET") connection.pending++;
      try {
        await connection.transport.handleRequest(req, res, parsed);
      } finally {
        if (req.method !== "GET") {
          connection.lastSeen = Date.now();
          if (activity) connection.lastActivity = Date.now();
          connection.pending--;
        }
        if (!connection.transport.sessionId) await dispose(connection);
      }
    })().catch(() => {
      if (!res.headersSent && !res.destroyed)
        respond(res, 500, "MCP request failed");
      else if (!res.destroyed) res.destroy();
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") {
        for (const hostname of ["127.0.0.1", "localhost", "[::1]"])
          hosts.add(`${hostname}:${address.port}`);
      }
      resolve();
    });
  });
  const timer = setInterval(
    () => {
      for (const connection of all) {
        const owned = ownedSessions(connection);
        const busy = owned.some((s) => s.status === "busy" || s.waitingForUser);
        // Transport pings must not pin empty discovery-only clients forever.
        const lastUse = owned.length
          ? connection.lastSeen
          : connection.lastActivity;
        if (!connection.pending && !busy && Date.now() - lastUse > idleMs)
          void dispose(connection).catch(() => {});
      }
    },
    Math.min(30_000, Math.max(25, idleMs / 2)),
  );
  timer.unref();
  let closePromise: Promise<void> | undefined;
  return {
    server,
    connectionCount: () => all.size,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(timer);
      closePromise = (async () => {
        const stopped = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        await Promise.allSettled([...all].map(dispose));
        server.closeAllConnections();
        await stopped;
      })();
      return closePromise;
    },
  };
}
