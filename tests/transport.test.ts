import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChromiumCDPTransport } from "@cua/browser-chromium";
import type { CDPTransport } from "@cua/contracts";
class ReplaySession extends EventEmitter {
  calls: string[] = [];
  fail = false;
  async send(method: string) {
    this.calls.push(method);
    if (this.fail) throw Error("connection lost after dispatch");
    if (method === "Runtime.enable")
      this.emit("event", {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 1 } },
      });
    return { result: { value: 1 } };
  }
  async detach() {
    this.emit("close");
  }
}
test("CDP replay forwards events, reattaches before dispatch, never replays an uncertain send", async () => {
  const sessions: ReplaySession[] = [];
  const transport: CDPTransport = new ChromiumCDPTransport(async () => {
    const s = new ReplaySession();
    sessions.push(s);
    return s as any;
  });
  const events: unknown[] = [];
  const off = transport.subscribe("Runtime.executionContextCreated", (e) =>
    events.push(e),
  );
  await transport.request("Runtime.enable");
  assert.equal(events.length, 1);
  await sessions[0].detach();
  await transport.request("Runtime.evaluate", { expression: "1" });
  assert.equal(sessions.length, 2);
  sessions[1].fail = true;
  await assert.rejects(transport.request("Input.dispatchMouseEvent"));
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[1].calls, [
    "Runtime.evaluate",
    "Input.dispatchMouseEvent",
  ]);
  off();
  await transport.close();
});
test("CDP command timeout is unknown and does not retry", async () => {
  let count = 0;
  const session = new ReplaySession();
  session.send = async () => {
    count++;
    return new Promise(() => {});
  };
  const transport = new ChromiumCDPTransport(async () => session as any, 5);
  await assert.rejects(transport.request("Runtime.callFunctionOn"), {
    code: "OPERATION_TIMEOUT",
    outcome: "unknown",
  });
  assert.equal(count, 1);
  await transport.close();
});
