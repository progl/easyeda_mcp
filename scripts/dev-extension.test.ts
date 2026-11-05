import { expect, test } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
// @ts-expect-error Development script is native JavaScript.
import { startDevPublisher } from "./dev-extension.mjs";
test("explicit local publisher sends the official package envelope and pushes replacements", async () => {
  const server = await startDevPublisher({ port: 0 });
  const socket = new WebSocket(server.url);
  try {
    await once(socket, "open");
    const first = once(socket, "message");
    await server.publish(Buffer.from("first"), "test.eext");
    expect(JSON.parse(String((await first)[0]))).toEqual({
      type: "file",
      topic: "Dev Mode Extension Package Update",
      content: "Zmlyc3Q=",
      fileName: "test.eext",
      fileMimeType: "application/octet-stream"
    });
    const next = once(socket, "message");
    await server.publish(Buffer.from("second"), "test.eext");
    expect(JSON.parse(String((await next)[0])).content).toBe("c2Vjb25k");
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  } finally {
    socket.terminate();
    await server.close();
  }
});
test("publisher rejects invalid packages instead of broadcasting them", async () => {
  const server = await startDevPublisher({ port: 0 });
  try {
    await expect(server.publish(Buffer.alloc(0), "x.eext")).rejects.toThrow();
    await expect(server.publish(Buffer.from("x"), "../x.eext")).rejects.toThrow();
  } finally {
    await server.close();
  }
});
test("stages while paused, tracks register and verifies only a new post-publication hello", async () => {
  let runtime: any = {
    connected: true,
    extensionVersion: "old",
    bridgeSession: "s",
    connectionGeneration: 1,
    helloAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingCalls: 0,
    lockBusy: false
  };
  const server = await startDevPublisher({ port: 0, readDiagnostics: async () => runtime });
  const socket = new WebSocket(server.url);
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "register", tabId: "tab1", timestamp: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await server.stage(Buffer.from("next"), "next.eext", { version: "new" });
    expect(server.status()).toMatchObject({
      paused: true,
      clients: [{ tabId: "tab1", registered: true }],
      verification: { state: "not_published" }
    });
    runtime.lockBusy = true;
    await expect(server.release({ idleConfirmed: true })).rejects.toThrow(/busy/);
    runtime.lockBusy = false;
    const next = once(socket, "message");
    await server.release({ idleConfirmed: true });
    await next;
    expect((await server.checkRuntime()).state).toBe("stale_runtime");
    runtime = {
      ...runtime,
      extensionVersion: "new",
      connectionGeneration: 2,
      helloAt: new Date(Date.now() + 1).toISOString(),
      updatedAt: new Date().toISOString()
    };
    expect((await server.checkRuntime()).state).toBe("runtime_version_confirmed");
  } finally {
    socket.terminate();
    await server.close();
  }
});
test("blocks unknown/busy automatic release and cannot treat a status timestamp as a new hello", async () => {
  let runtime: any;
  const server = await startDevPublisher({ port: 0, readDiagnostics: async () => runtime });
  try {
    await server.stage(Buffer.from("x"), "x.eext", { version: "v" });
    await expect(server.release()).rejects.toThrow(/diagnostics/);
    runtime = {
      connected: true,
      extensionVersion: "v",
      bridgeSession: "s",
      connectionGeneration: 1,
      helloAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingCalls: 1,
      lockBusy: true
    };
    await expect(server.release({ idleConfirmed: true })).rejects.toThrow(/busy/);
    runtime = { ...runtime, pendingCalls: 0, lockBusy: false };
    await server.release();
    runtime.updatedAt = new Date().toISOString();
    expect((await server.checkRuntime()).state).toBe("awaiting_new_hello");
    runtime = { ...runtime, uncertainWrite: true, lockBusy: true };
    await expect(server.release()).rejects.toThrow(/uncertain/);
    await server.release({ idleConfirmed: true });
    expect(server.status().verification.state).toBe("publication_not_installation");
  } finally {
    await server.close();
  }
});
