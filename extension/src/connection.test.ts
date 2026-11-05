import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeConnection, WS_ID, LEGACY_WS_ID } from "./connection.js";

describe("Extension BridgeConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps retrying a delayed server with backoff capped at 30 seconds, then resets after open", async () => {
    const startedAt = Date.now();
    const attempts: number[] = [];
    let available = false;
    let open: (() => Promise<void>) | undefined;
    const register = vi.fn((_id, _uri, _message, onOpen) => {
      attempts.push(Date.now() - startedAt);
      if (!available) throw new Error("ECONNREFUSED");
      open = onOpen;
    });
    const send = vi.fn();
    const conn = createBridgeConnection({
      api: () => ({ sys_WebSocket: { register, send } }),
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 2500,
        heartbeatIntervalMs: 15000,
        reconnectDelayMs: [0, 1000, 2500, 5000]
      },
      onMessage: async () => {},
      getCapabilities: () => ({})
    });
    await conn.ensureConnected({ reason: "startup", manual: false });
    await vi.advanceTimersByTimeAsync(98500);
    expect(attempts).toEqual([0, 1000, 3500, 8500, 18500, 38500, 68500, 98500]);
    available = true;
    await vi.advanceTimersByTimeAsync(30000);
    await open?.();
    expect(conn.getState().phase).toBe("connected");
    expect(conn.getState().attemptIndex).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    conn.dispose();
    const count = register.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(register).toHaveBeenCalledTimes(count);
  });

  it("cancels pending transport retries on dispose and ignores stale callbacks", async () => {
    const registrations: any[] = [];
    const register = vi.fn((_id, _uri, message, open) => registrations.push({ message, open }));
    const onMessage = vi.fn(async () => {}),
      send = vi.fn();
    const conn = createBridgeConnection({
      api: () => ({ sys_WebSocket: { register, send } }),
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 100,
        heartbeatIntervalMs: 15000,
        reconnectDelayMs: [0, 1000]
      },
      onMessage,
      getCapabilities: () => ({})
    });
    await conn.ensureConnected({ reason: "startup", manual: false });
    await vi.advanceTimersByTimeAsync(100);
    conn.dispose();
    await registrations[0].open();
    await registrations[0].message({ data: "stale" });
    await vi.advanceTimersByTimeAsync(120000);
    await conn.ensureConnected({ reason: "automatic", manual: false });
    expect(register).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("uses one retry after a heartbeat send failure and resets backoff after reconnection", async () => {
    const registrations: any[] = [];
    let transportDown = false;
    const register = vi.fn((_id, _uri, message, open) => registrations.push({ message, open }));
    const send = vi.fn(() => {
      if (transportDown) throw new Error("socket closed");
    });
    const conn = createBridgeConnection({
      api: () => ({ sys_WebSocket: { register, send } }),
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 100,
        heartbeatIntervalMs: 10000,
        reconnectDelayMs: [0, 1000, 2500]
      },
      onMessage: async () => {},
      getCapabilities: () => ({})
    });
    await conn.ensureConnected({ reason: "startup", manual: false });
    await registrations[0].open();
    transportDown = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(conn.getState().attemptIndex).toBe(1);
    expect(register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(register).toHaveBeenCalledTimes(2);
    transportDown = false;
    await registrations[1].open();
    expect(conn.getState().attemptIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(register).toHaveBeenCalledTimes(2);
    conn.dispose();
  });

  it("registers websocket and transitions through connection lifecycle", async () => {
    let _registeredOnMessage: ((event: MessageEvent<string>) => Promise<void>) | undefined;
    let registeredOnOpen: (() => Promise<void>) | undefined;
    const sentMessages: string[] = [];

    const mockApi = {
      sys_WebSocket: {
        register: vi.fn((_id: string, _uri: string, onMsg: any, onOpen: any) => {
          _registeredOnMessage = onMsg;
          registeredOnOpen = onOpen;
        }),
        send: vi.fn((_id: string, data: string) => {
          sentMessages.push(data);
        })
      },
      sys_Dialog: {
        showInformationMessage: vi.fn()
      },
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => ({ uuid: "doc-1", name: "Board.pcb", documentType: 3 }))
      }
    };

    let connectionChangedCalled = false;
    const conn = createBridgeConnection({
      api: () => mockApi,
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 2000,
        heartbeatIntervalMs: 10000,
        reconnectDelayMs: [0, 1000, 2000]
      },
      onMessage: async () => {},
      getCapabilities: () => ({ drcCheck: true }),
      onConnectionChanged: () => {
        connectionChangedCalled = true;
      }
    });

    expect(conn.getState().phase).toBe("idle");

    await conn.ensureConnected({ reason: "test", manual: false });
    expect(conn.getState().phase).toBe("connecting");
    expect(mockApi.sys_WebSocket.register).toHaveBeenCalledWith(
      conn.getState().registrationId,
      "ws://127.0.0.1:8765",
      expect.any(Function),
      expect.any(Function)
    );

    // Trigger onOpen
    await registeredOnOpen?.();
    expect(conn.getState().phase).toBe("connected");
    expect(connectionChangedCalled).toBe(true);
    expect(sentMessages.length).toBeGreaterThan(0);

    const hello = JSON.parse(sentMessages[0]);
    expect(hello.kind).toBe("hello");
    expect(hello.capabilities).toEqual({ drcCheck: true, applicationHeartbeat: true });
    expect(hello.status.connected).toBe(true);
  });

  it("handles open timeout and schedules reconnection", async () => {
    const mockApi = {
      sys_WebSocket: {
        register: vi.fn(),
        send: vi.fn()
      },
      sys_Dialog: {
        showInformationMessage: vi.fn()
      }
    };

    const conn = createBridgeConnection({
      api: () => mockApi,
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 1500,
        heartbeatIntervalMs: 10000,
        reconnectDelayMs: [0, 1000]
      },
      onMessage: async () => {},
      getCapabilities: () => ({})
    });

    await conn.ensureConnected({ reason: "timeout-test", manual: false });
    expect(conn.getState().phase).toBe("connecting");

    // Advance past timeout
    vi.advanceTimersByTime(1600);

    // After failure with retry left:
    expect(conn.getState().phase).toBe("idle");
    expect(conn.getState().lastError?.code).toBe("bridge_open_timeout");
  });
  it("closes the SDK ID before registering again and ignores stale attempt callbacks", async () => {
    const registrations: any[] = [],
      order: string[] = [];
    const onMessage = vi.fn(async () => {}),
      send = vi.fn();
    const api = () => ({
      sys_WebSocket: {
        close: vi.fn((id: string) => order.push(`close:${id}`)),
        register: vi.fn((_id, _uri, message, open) => {
          order.push("register");
          registrations.push({ message, open });
        }),
        send
      },
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "p", documentType: 1 }) }
    });
    const conn = createBridgeConnection({
      api,
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 2000,
        heartbeatIntervalMs: 10000,
        reconnectDelayMs: [0, 100]
      },
      onMessage,
      getCapabilities: () => ({})
    });
    await conn.ensureConnected({ reason: "startup", manual: false });
    await registrations[0].open();
    conn.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([
      `close:${LEGACY_WS_ID}`,
      `close:${conn.getState().registrationId}`,
      "register",
      `close:${conn.getState().registrationId}`,
      "register"
    ]);
    expect(WS_ID).not.toBe(LEGACY_WS_ID);
    expect(conn.getState().registrationId).toContain(WS_ID + "/");
    const sent = send.mock.calls.length;
    await registrations[0].open();
    await registrations[0].message({ data: "stale" });
    expect(send).toHaveBeenCalledTimes(sent);
    expect(onMessage).not.toHaveBeenCalled();
    await registrations[1].open();
    await registrations[1].message({ data: "current" });
    expect(onMessage).toHaveBeenCalledWith("current");
  });
  it.each(["missing-api", "permission-denied"])(
    "reports %s as blocked without granting permissions or retrying",
    async (mode) => {
      const register =
        mode === "missing-api"
          ? undefined
          : vi.fn(() => {
              throw new Error("External interaction permission denied");
            });
      const api = () => ({
        sys_WebSocket: { register, send: vi.fn() },
        sys_Dialog: { showInformationMessage: vi.fn() }
      });
      const conn = createBridgeConnection({
        api,
        bridgeConfig: {
          host: "127.0.0.1",
          port: 8765,
          openTimeoutMs: 2000,
          heartbeatIntervalMs: 10000,
          reconnectDelayMs: [0, 100]
        },
        onMessage: async () => {},
        getCapabilities: () => ({})
      });
      await conn.ensureConnected({ reason: "activation", manual: false });
      expect(conn.getState().phase).toBe("blocked");
      expect(conn.getState().lastError?.message).toMatch(/unavailable|permission denied/i);
      await vi.advanceTimersByTimeAsync(10000);
      if (register) expect(register).toHaveBeenCalledTimes(1);
    }
  );
  it("isolates same-version runtimes so disposing or retrying one cannot close the other registration", async () => {
    const registry = new Set<string>();
    const sdk = {
      register: vi.fn((id: string) => registry.add(id)),
      close: vi.fn((id: string) => registry.delete(id)),
      send: vi.fn()
    };
    const options = {
      api: () => ({ sys_WebSocket: sdk }),
      bridgeConfig: {
        host: "127.0.0.1",
        port: 8765,
        openTimeoutMs: 2000,
        heartbeatIntervalMs: 10000,
        reconnectDelayMs: [0, 100]
      },
      onMessage: async () => {},
      getCapabilities: () => ({})
    };
    const a = createBridgeConnection(options),
      b = createBridgeConnection(options);
    await a.ensureConnected({ reason: "entry-loaded", manual: false });
    await b.ensureConnected({ reason: "entry-loaded", manual: false });
    const first = a.getState().registrationId,
      second = b.getState().registrationId;
    expect(first).not.toBe(second);
    expect(registry.has(second)).toBe(true);
    a.dispose();
    expect(registry.has(second)).toBe(true);
    a.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.has(second)).toBe(true);
    b.dispose();
    a.dispose();
  });
});

it("identifies the owner runtime in hello, live status and diagnostics without page data", async () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Firefox/145.0 https://private.invalid/?secret=yes" });
  let open: (() => Promise<void>) | undefined;
  const sent: any[] = [];
  const conn = createBridgeConnection({
    api: () => ({
      sys_WebSocket: {
        register: (_id: any, _uri: any, _msg: any, onOpen: any) => {
          open = onOpen;
        },
        send: (_id: any, payload: string) => sent.push(JSON.parse(payload))
      }
    }),
    bridgeConfig: {
      host: "127.0.0.1",
      port: 8765,
      openTimeoutMs: 2500,
      heartbeatIntervalMs: 15000,
      reconnectDelayMs: [0]
    },
    onMessage: async () => {},
    getCapabilities: () => ({})
  });
  try {
    await conn.ensureConnected({ reason: "test", manual: false });
    await open?.();
    const hello = sent.find((p) => p.kind === "hello"),
      status: any = await conn.getStatus(),
      diagnostics: any = await conn.collectDiagnostics();
    expect(hello.browserIdentity).toMatchObject({ browserName: "Firefox", version: "145.0", appKind: "browser" });
    expect(status.browserIdentity).toEqual(hello.browserIdentity);
    expect(diagnostics.browserIdentity).toEqual(hello.browserIdentity);
    expect(diagnostics.connection.runtimeId).toBe(hello.runtimeId);
    expect(JSON.stringify(hello)).not.toContain("private.invalid");
  } finally {
    conn.dispose();
    vi.unstubAllGlobals();
  }
});
