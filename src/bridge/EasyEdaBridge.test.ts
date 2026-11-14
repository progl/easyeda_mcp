import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { EasyEdaBridge } from "./EasyEdaBridge.js";
import { BridgeProtocolCompatibilityError, BridgeRpcError, BridgeUnavailableError } from "./errors.js";

const bridges: EasyEdaBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("EasyEdaBridge", () => {
  it("bounds retired runtime IDs to 256 entries", () => {
    const bridge: any = new EasyEdaBridge({ logger: { error: () => {}, warn: () => {}, info: () => {} } });
    for (let i = 0; i < 300; i++)
      bridge.promoteSocket({ readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() }, `runtime-${i}`);
    expect(bridge.retiredRuntimeIds.size).toBe(256);
    expect(bridge.retiredRuntimeIds.has("runtime-0")).toBe(false);
    expect(bridge.retiredRuntimeIds.has("runtime-298")).toBe(true);
  });
  it("keeps legacy reconnect compatible without letting an unidentified retry evict a healthy same-version owner", async () => {
    const bridge = await startBridge();
    const legacy = await connectClient(bridge.endpoint);
    const identified = await connectClient(bridge.endpoint, false);
    identified.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.1.0",
        protocolVersion: "0.1.0",
        capabilities: {},
        runtimeId: "identified"
      })
    );
    await wait(10);
    const retryLegacy = await connectClient(bridge.endpoint);
    await wait(10);
    expect(identified.readyState).toBe(WebSocket.OPEN);
    expect(retryLegacy.readyState).not.toBe(WebSocket.OPEN);
    identified.terminate();
    await wait(10);
    const recoveredLegacy = await connectClient(bridge.endpoint);
    expect(bridge.getStatus().connected).toBe(true);
    for (const client of [legacy, retryLegacy, recoveredLegacy]) client.terminate();
  });
  it("retires runtime A after B takeover and rejects A auto-retry until explicit manual takeover", async () => {
    const bridge = await startBridge();
    const hello = (runtimeId: string, takeover = false) => ({
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.6.12",
      protocolVersion: "0.1.0",
      capabilities: {},
      runtimeId,
      takeover
    });
    const a = await connectClient(bridge.endpoint, false);
    a.send(JSON.stringify(hello("runtime-A")));
    await wait(10);
    const b = await connectClient(bridge.endpoint, false);
    b.send(JSON.stringify(hello("runtime-B")));
    await wait(10);
    expect(a.readyState).not.toBe(WebSocket.OPEN);
    const retryA = await connectClient(bridge.endpoint, false);
    retryA.send(JSON.stringify(hello("runtime-A")));
    await wait(20);
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(retryA.readyState).not.toBe(WebSocket.OPEN);
    const manualA = await connectClient(bridge.endpoint, false);
    manualA.send(JSON.stringify(hello("runtime-A", true)));
    await wait(20);
    expect(manualA.readyState).toBe(WebSocket.OPEN);
    expect(b.readyState).not.toBe(WebSocket.OPEN);
    const retryB = await connectClient(bridge.endpoint, false);
    retryB.send(JSON.stringify(hello("runtime-B")));
    await wait(20);
    expect(manualA.readyState).toBe(WebSocket.OPEN);
    const upgrade = await connectClient(bridge.endpoint, false);
    upgrade.send(JSON.stringify({ ...hello("runtime-C"), version: "0.6.13" }));
    await wait(20);
    const oldManual = await connectClient(bridge.endpoint, false);
    oldManual.send(JSON.stringify(hello("runtime-A", true)));
    await wait(20);
    expect(upgrade.readyState).toBe(WebSocket.OPEN);
    expect(oldManual.readyState).not.toBe(WebSocket.OPEN);
    for (const client of [a, b, retryA, manualA, retryB, upgrade, oldManual]) client.terminate();
  });
  it("allows the same identified runtime to reconnect without retiring itself", async () => {
    const bridge = await startBridge();
    const hello = {
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.6.12",
      protocolVersion: "0.1.0",
      capabilities: {},
      runtimeId: "same-runtime"
    };
    const a = await connectClient(bridge.endpoint, false);
    a.send(JSON.stringify(hello));
    await wait(10);
    const reconnect = await connectClient(bridge.endpoint, false);
    reconnect.send(JSON.stringify(hello));
    await wait(10);
    expect(reconnect.readyState).toBe(WebSocket.OPEN);
    expect((bridge as any).retiredRuntimeIds.has("same-runtime")).toBe(false);
    a.terminate();
    reconnect.terminate();
  });
  it("negotiates heartbeat only with capable peers and ACKs bounded ping IDs without dispatching RPC", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint, false);
    const received: any[] = [];
    client.on("message", (data) => received.push(JSON.parse(data.toString())));
    const hello = {
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.6.9",
      protocolVersion: "0.1.0",
      capabilities: {}
    };
    client.send(JSON.stringify(hello));
    await wait(10);
    expect(received).toEqual([]); // old extension receives no unsupported messages
    client.send(JSON.stringify({ kind: "ping", pingId: "not-negotiated" }));
    await wait(10);
    expect(received).toEqual([]);
    client.send(JSON.stringify({ ...hello, capabilities: { applicationHeartbeat: true } }));
    await wait(10);
    expect(received).toEqual([{ kind: "heartbeat_offer", version: 1 }]);
    client.send(JSON.stringify({ kind: "ping", pingId: "probe-1" }));
    await wait(10);
    expect(received[1]).toEqual({ kind: "pong", pingId: "probe-1" });
    client.send(JSON.stringify({ kind: "ping", pingId: "x".repeat(129) }));
    await wait(10);
    expect(received).toHaveLength(2);
    expect(bridge.getStatus().connectionState).toBe("connected");
    client.terminate();
  });
  it("exports pending write guard and post-connection hello without document data", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "easyeda-bridge-status-"));
    const file = path.join(dir, "bridge.json");
    const bridge = new EasyEdaBridge({
      port: 0,
      diagnosticsFile: file,
      logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    await bridge.start();
    const client = await connectClient(bridge.endpoint);
    try {
      client.send(
        JSON.stringify({
          kind: "hello",
          client: "easyeda-pro-extension",
          version: "0.6.4",
          protocolVersion: "0.1.0",
          capabilities: {},
          status: { documentName: "PRIVATE" }
        })
      );
      await wait(10);
      const a = JSON.parse(readFileSync(file, "utf8"));
      expect(a).toMatchObject({ connected: true, extensionVersion: "0.6.4", connectionGeneration: 1 });
      expect(readFileSync(file, "utf8")).not.toContain("PRIVATE");
      const pending = bridge.call("confirmedAction", { privateParameter: "SECRET" }, 25);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pendingMutations: 1, lockBusy: true });
      await expect(pending).rejects.toThrow(/timed out/i);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        pendingMutations: 0,
        lockBusy: true,
        uncertainWrite: true
      });
      expect(readFileSync(file, "utf8")).not.toContain("SECRET");
    } finally {
      client.terminate();
      await bridge.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports disconnected status before an extension connects", async () => {
    const bridge = await startBridge();

    expect(bridge.getStatus().connected).toBe(false);
    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it("round-trips RPC calls through a WebSocket extension client", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(
        JSON.stringify({
          kind: "result",
          requestId: message.requestId,
          result: {
            method: message.method,
            params: message.params
          }
        })
      );
    });

    const result = await bridge.call("findComponent", { query: "U1" });

    expect(result).toEqual({
      method: "findComponent",
      params: { query: "U1" }
    });
    client.close();
  });

  it("updates status from hello messages", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.1.0",
        protocolVersion: "0.1.0",
        capabilities: {
          websocket: true,
          pcbDocument: true
        },
        status: {
          documentName: "main pcb"
        }
      })
    );

    await wait(20);

    expect(bridge.getStatus()).toMatchObject({
      connected: true,
      extensionVersion: "0.1.0",
      documentName: "main pcb"
    });
    client.close();
  });

  it("blocks calls when the extension protocol is incompatible", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.1.0",
        protocolVersion: "9.9.9",
        capabilities: {
          websocket: true
        }
      })
    );

    await wait(20);

    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeProtocolCompatibilityError);
    client.close();
  });

  it("turns remote errors into BridgeRpcError", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(
        JSON.stringify({
          kind: "error",
          requestId: message.requestId,
          error: {
            code: "api_unavailable",
            message: "missing EasyEDA API"
          }
        })
      );
    });

    await expect(bridge.call("zoomBoard")).rejects.toBeInstanceOf(BridgeRpcError);
    client.close();
  });

  it("allows a newer extension connection to replace the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const newClient = await connectClient(bridge.endpoint, false);
    newClient.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.6.4",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(
        JSON.stringify({
          kind: "result",
          requestId: message.requestId,
          result: "new-client"
        })
      );
    });

    await wait(20);

    await expect(bridge.call("getContext")).resolves.toBe("new-client");
    oldClient.close();
    newClient.close();
  });

  it("rejects pending calls when a newer extension connection replaces the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const pendingCall = bridge.call("getContext");
    pendingCall.catch(() => undefined);

    await wait(20);
    const newClient = await connectClient(bridge.endpoint, false);
    newClient.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.6.4",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(
        JSON.stringify({
          kind: "result",
          requestId: message.requestId,
          result: "new-client"
        })
      );
    });

    await expect(pendingCall).rejects.toBeInstanceOf(BridgeUnavailableError);
    oldClient.close();
    newClient.close();
  });

  it("does not evict a healthy newer runtime before hello or for an older retry", async () => {
    const bridge = await startBridge(),
      current = await connectClient(bridge.endpoint);
    current.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.6.4",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    await wait(10);
    const candidate = await connectClient(bridge.endpoint, false);
    await wait(10);
    expect(current.readyState).toBe(WebSocket.OPEN);
    expect(bridge.getStatus().extensionVersion).toBe("0.6.4");
    candidate.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.6.3",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    await wait(20);
    expect(current.readyState).toBe(WebSocket.OPEN);
    expect(bridge.getStatus().extensionVersion).toBe("0.6.4");
    current.close();
    candidate.close();
  });
  it("ignores stale socket responses after a valid takeover", async () => {
    const bridge = await startBridge(),
      old = await connectClient(bridge.endpoint);
    const staleServerSocket = [...(bridge as any).wss.clients][0];
    const newer = await connectClient(bridge.endpoint, false);
    newer.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.6.4",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    await wait(10);
    staleServerSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          kind: "hello",
          client: "easyeda-pro-extension",
          version: "99.0.0",
          protocolVersion: "0.1.0",
          capabilities: {}
        })
      )
    );
    expect(bridge.getStatus().extensionVersion).toBe("0.6.4");
    const result = bridge.call("getContext");
    newer.once("message", (data) => {
      const call = JSON.parse(String(data));
      // Model a queued old message arriving after takeover, even if TCP is already closed.
      staleServerSocket.emit(
        "message",
        Buffer.from(JSON.stringify({ kind: "result", requestId: call.requestId, result: "stale" }))
      );
      newer.send(JSON.stringify({ kind: "result", requestId: call.requestId, result: "active" }));
    });
    await expect(result).resolves.toBe("active");
    newer.close();
    old.close();
  });

  it("accepts same-version reconnect but rejects pending writes as uncertain rather than replay-safe", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "easyeda-takeover-")),
      file = path.join(dir, "status.json");
    const bridge = new EasyEdaBridge({
      port: 0,
      diagnosticsFile: file,
      logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    await bridge.start();
    const old = await connectClient(bridge.endpoint);
    const hello = {
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.6.4",
      runtimeId: "old-runtime",
      protocolVersion: "0.1.0",
      capabilities: {}
    };
    old.send(JSON.stringify(hello));
    await wait(10);
    const pending = bridge.call("confirmedAction", { action: "mutation" });
    pending.catch(() => {});
    const newer = await connectClient(bridge.endpoint, false);
    newer.send(JSON.stringify({ ...hello, runtimeId: "new-runtime" }));
    await expect(pending).rejects.toThrow(/never replay/i);
    expect(bridge.getStatus().extensionVersion).toBe("0.6.4");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      lockBusy: true,
      uncertainWrite: true,
      pendingMutations: 0
    });
    old.close();
    newer.close();
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a hello before RPC and ignores pre-hello status traffic", async () => {
    const bridge = await startBridge(),
      client = await connectClient(bridge.endpoint, false);
    client.send(JSON.stringify({ kind: "status", status: { connected: true, extensionVersion: "9.9.9" } }));
    await wait(10);
    expect(bridge.getStatus().connected).toBe(false);
    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);
    client.close();
  });
  it.each(["0.6.5-..", "0.6.5-01", "9".repeat(400) + ".0.0"])(
    "rejects malformed replacement version %s",
    async (version) => {
      const bridge = await startBridge(),
        current = await connectClient(bridge.endpoint);
      const candidate = await connectClient(bridge.endpoint, false);
      candidate.send(
        JSON.stringify({
          kind: "hello",
          client: "easyeda-pro-extension",
          version,
          protocolVersion: "0.1.0",
          capabilities: {}
        })
      );
      await wait(15);
      expect(current.readyState).toBe(WebSocket.OPEN);
      expect(bridge.getStatus().extensionVersion).toBe("0.1.0");
      candidate.close();
      current.close();
    }
  );

  it("falls back to default host and port when env vars are blank strings", () => {
    const prevHost = process.env.EASYEDA_MCP_WS_HOST;
    const prevPort = process.env.EASYEDA_MCP_WS_PORT;
    try {
      process.env.EASYEDA_MCP_WS_HOST = "   ";
      process.env.EASYEDA_MCP_WS_PORT = "";
      const bridge = new EasyEdaBridge();
      expect(bridge.endpoint).toBe("ws://127.0.0.1:8765");
    } finally {
      if (prevHost === undefined) delete process.env.EASYEDA_MCP_WS_HOST;
      else process.env.EASYEDA_MCP_WS_HOST = prevHost;
      if (prevPort === undefined) delete process.env.EASYEDA_MCP_WS_PORT;
      else process.env.EASYEDA_MCP_WS_PORT = prevPort;
    }
  });
});

async function startBridge(): Promise<EasyEdaBridge> {
  const bridge = new EasyEdaBridge({
    port: 0,
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined
    }
  });
  await bridge.start();
  bridges.push(bridge);
  return bridge;
}

async function connectClient(endpoint: string, hello = true): Promise<WebSocket> {
  const client = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  if (hello) {
    client.send(
      JSON.stringify({
        kind: "hello",
        client: "easyeda-pro-extension",
        version: "0.1.0",
        protocolVersion: "0.1.0",
        capabilities: {}
      })
    );
    await wait(5);
  }
  return client;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

it("reports accepted hello browser identity through live status and preserves it across legacy status frames", () => {
  const bridge: any = new EasyEdaBridge({ logger: { error: () => {}, warn: () => {}, info: () => {} } });
  const browserIdentity = { browserName: "Firefox", version: "145.0", appKind: "browser", source: "user_agent" };
  bridge.handleMessage({
    kind: "hello",
    client: "easyeda-pro-extension",
    version: "0.6.18",
    runtimeId: "owner-firefox",
    protocolVersion: "0.1.0",
    capabilities: {},
    browserIdentity
  });
  expect(bridge.getStatus()).toMatchObject({ runtimeId: "owner-firefox", browserIdentity });
  bridge.handleMessage({ kind: "status", status: { connected: true, updatedAt: new Date().toISOString() } });
  expect(bridge.getStatus().browserIdentity).toEqual(browserIdentity);
  bridge.handleMessage({
    kind: "hello",
    client: "easyeda-pro-extension",
    version: "0.6.18",
    runtimeId: "legacy-owner",
    protocolVersion: "0.1.0",
    capabilities: {}
  });
  expect(bridge.getStatus().browserIdentity).toBeUndefined();
});
