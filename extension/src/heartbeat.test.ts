import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBridgeConnection } from "./connection.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function fixture() {
  const sent: any[] = [],
    registrations: any[] = [];
  let sendError: Error | undefined;
  const close = vi.fn(),
    onMessage = vi.fn(async () => {});
  const register = vi.fn((_id, _uri, message, open) => registrations.push({ message, open }));
  const conn = createBridgeConnection({
    api: () => ({
      sys_WebSocket: {
        register,
        close,
        send: (_id: string, data: string) => {
          if (sendError) throw sendError;
          sent.push(JSON.parse(data));
        }
      }
    }),
    bridgeConfig: {
      host: "127.0.0.1",
      port: 8765,
      openTimeoutMs: 100,
      heartbeatIntervalMs: 1000,
      heartbeatAckTimeoutMs: 500,
      reconnectDelayMs: [0, 100, 200]
    },
    onMessage,
    getCapabilities: () => ({})
  });
  await conn.ensureConnected({ reason: "startup", manual: false });
  await registrations[0].open();
  const receive = async (data: any, index = 0) => registrations[index].message({ data: JSON.stringify(data) });
  return {
    conn,
    sent,
    registrations,
    close,
    register,
    onMessage,
    receive,
    setSendError: (error: Error) => {
      sendError = error;
    }
  };
}
it("negotiates ACK support and accepts a delayed matching ACK without reconnecting", async () => {
  const f = await fixture();
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  const ping = f.sent.find((m) => m.kind === "ping");
  expect(ping?.pingId).toEqual(expect.any(String));
  await vi.advanceTimersByTimeAsync(400);
  await f.receive({ kind: "pong", pingId: ping.pingId });
  await vi.advanceTimersByTimeAsync(101);
  expect(f.conn.getState().phase).toBe("connected");
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.onMessage).not.toHaveBeenCalled();
  f.conn.dispose();
});
it("detects silent-drop send with no ACK, closes only its registration, and retries transport without RPC replay", async () => {
  const f = await fixture();
  await f.receive({ kind: "call", requestId: "mutation-once", method: "confirmedAction", params: {} });
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  const ping = f.sent.find((m) => m.kind === "ping");
  await f.receive({ kind: "pong", pingId: ping.pingId + "stale" });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.conn.getState().phase).toBe("idle");
  expect(f.conn.getState().lastError?.code).toBe("heartbeat_ack_timeout");
  expect(f.close).toHaveBeenLastCalledWith(f.conn.getState().registrationId, 1000, expect.any(String));
  await vi.advanceTimersByTimeAsync(100);
  expect(f.register).toHaveBeenCalledTimes(2);
  await f.receive({ kind: "pong", pingId: ping.pingId }); // retired attempt callback
  expect(f.conn.getState().phase).toBe("connecting");
  expect(f.sent.some((m) => m.kind === "call")).toBe(false);
  expect(f.onMessage).toHaveBeenCalledTimes(1);
  f.conn.dispose();
});
it("does not invent ACK support for an old server or loop reconnects against it", async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.conn.getState().phase).toBe("connected");
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.sent.some((m) => m.kind === "ping")).toBe(false);
  expect((await f.conn.getStatus()).heartbeat).toMatchObject({ mode: "legacy_unverified" });
  f.conn.dispose();
});
it("does not let an old ACK satisfy the next probe on the same socket", async () => {
  const f = await fixture();
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  const first = f.sent.find((m) => m.kind === "ping");
  await f.receive({ kind: "pong", pingId: first.pingId });
  await vi.advanceTimersByTimeAsync(1000);
  const probes = f.sent.filter((m) => m.kind === "ping");
  expect(probes).toHaveLength(2);
  expect(probes[1].pingId).not.toBe(first.pingId);
  await f.receive({ kind: "pong", pingId: first.pingId });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.conn.getState().lastError?.code).toBe("heartbeat_ack_timeout");
  f.conn.dispose();
});
it("cancels pending ACK timeout and ignores late ACK/offer after explicit disable", async () => {
  const f = await fixture();
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  f.conn.dispose();
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.conn.getState().phase).toBe("idle");
  expect(f.register).toHaveBeenCalledTimes(1);
});

it("blocks actual SDK permission errors without scheduling heartbeat or reconnect loops", async () => {
  const f = await fixture();
  f.setSendError(new Error("错误：未启用扩展和独立脚本的外部交互权限！"));
  await f.receive({ kind: "heartbeat_offer", version: 1 });
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.conn.getState().phase).toBe("blocked");
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.conn.getState().heartbeatAckTimer).toBeUndefined();
  f.conn.dispose();
});
it("stops a retired runtime and requests takeover only after explicit manual Reconnect", async () => {
  const f = await fixture();
  const original = f.sent.find((m) => m.kind === "hello");
  expect(original.runtimeId).toBe(f.conn.getState().registrationId);
  expect(original.takeover).toBe(false);
  await f.receive({ kind: "runtime_retired", reason: "Newer window owns the bridge." });
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.conn.getState().phase).toBe("blocked");
  expect(f.register).toHaveBeenCalledTimes(1);
  f.conn.reconnect();
  await f.registrations[1].open();
  expect(f.sent.filter((m) => m.kind === "hello").at(-1)).toMatchObject({
    runtimeId: original.runtimeId,
    takeover: true
  });
  f.conn.dispose();
});
