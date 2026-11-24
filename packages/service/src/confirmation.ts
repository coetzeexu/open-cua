import net from "node:net";
import { chmod, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { privateDirectory } from "./platform.js";
import type { DefaultPolicyProvider, PendingUserChannel } from "@cua/core";
export class ConfirmationServer {
  readonly socketPath: string;
  private server?: net.Server;
  private token?: string;
  private clients = new Set<net.Socket>();
  constructor(
    readonly options: {
      instanceId: string;
      policies: () => DefaultPolicyProvider[];
      status: () => unknown;
      releaseSession?: (input: {
        sessionId: string;
        force: boolean;
      }) => Promise<unknown>;
      directory?: string;
      human?: PendingUserChannel;
    },
  ) {
    if (!/^[\w-]+$/.test(options.instanceId))
      throw Error("Invalid instance ID");
    this.socketPath = join(
      options.directory ?? join(homedir(), ".cua", "run"),
      `${options.instanceId}.sock`,
    );
  }
  async start() {
    await privateDirectory(dirname(this.socketPath));
    if (process.platform === "win32")
      this.token = randomBytes(32).toString("hex");
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.once("close", () => this.clients.delete(socket));
      socket.on("error", () => {});
      let data = "";
      let handled = false;
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("data", async (chunk) => {
        if (handled) return;
        data += chunk.toString();
        if (data.length > 65536) {
          socket.destroy();
          return;
        }
        if (!data.includes("\n")) return;
        handled = true;
        try {
          const request = JSON.parse(data.slice(0, data.indexOf("\n")));
          if (this.token) {
            const supplied = Buffer.from(
              typeof request.token === "string" ? request.token : "",
            );
            const expected = Buffer.from(this.token);
            if (
              supplied.length !== expected.length ||
              !timingSafeEqual(supplied, expected)
            ) {
              socket.end('{"ok":false}\n');
              return;
            }
          }
          let result: unknown = { ok: false };
          if (request.method === "status")
            result = {
              ok: true,
              instanceId: this.options.instanceId,
              sessions: this.options.status(),
            };
          else if (
            request.method === "session-close" &&
            typeof request.id === "string" &&
            typeof request.force === "boolean" &&
            this.options.releaseSession
          ) {
            socket.setTimeout(0);
            result = {
              ok: true,
              result: await this.options.releaseSession({
                sessionId: request.id,
                force: request.force,
              }),
            };
          } else if (typeof request.id === "string") {
            const human = this.options.human;
            const view = human?.inspect(request.id);
            if (human && view) {
              result =
                request.method === "inspect"
                  ? { ok: true, human: view }
                  : request.method === "credentials" &&
                      view.type === "credentials"
                    ? {
                        ok: human.submitCredentials(request.id, request.values),
                      }
                    : request.method === "resume" && view.type === "handoff"
                      ? { ok: human.resume(request.id) }
                      : request.method === "deny"
                        ? { ok: human.decline(request.id) }
                        : { ok: false };
            } else
              for (const policy of this.options.policies()) {
                const confirmation = policy.confirmation(request.id);
                if (confirmation) {
                  result =
                    request.method === "inspect"
                      ? { ok: true, confirmation }
                      : request.method === "approve" ||
                          request.method === "deny"
                        ? {
                            ok: policy.decide(
                              request.id,
                              request.method === "approve",
                            ),
                          }
                        : { ok: false };
                  break;
                }
              }
          }
          socket.end(JSON.stringify(result) + "\n");
        } catch (error) {
          socket.end(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : "Request failed",
            }) + "\n",
          );
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        if (this.token) this.server!.listen(0, "127.0.0.1", resolve);
        else this.server!.listen(this.socketPath, resolve);
      });
      if (this.token) {
        const address = this.server.address() as net.AddressInfo;
        await writeFile(
          this.socketPath,
          JSON.stringify({ port: address.port, token: this.token }),
          { flag: "wx", mode: 0o600 },
        );
      } else await chmod(this.socketPath, 0o600);
    } catch (error) {
      this.server.close();
      throw error;
    }
  }
  async close() {
    for (const client of this.clients) client.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }
}
export async function socketRequest(
  path: string,
  request: unknown,
  timeoutMs = 2000,
): Promise<any> {
  let port: number | undefined;
  if (process.platform === "win32") {
    const descriptor = JSON.parse(await readFile(path, "utf8"));
    if (
      !Number.isInteger(descriptor.port) ||
      descriptor.port < 1 ||
      descriptor.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(descriptor.token)
    )
      throw Error("Invalid local confirmation endpoint");
    port = descriptor.port;
    request = { ...(request as object), token: descriptor.token };
  }
  return new Promise((resolve, reject) => {
    const socket = port
      ? net.createConnection({ host: "127.0.0.1", port })
      : net.createConnection(path);
    let data = "";
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(Error("Confirmation socket timed out")),
    );
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024)
        socket.destroy(Error("Response too large"));
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}
export async function listInstanceSockets(
  directory = join(homedir(), ".cua", "run"),
) {
  try {
    return (await readdir(directory))
      .filter((name) => /^[\w-]+\.sock$/.test(name))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}
