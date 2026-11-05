import { describe, expect, it } from "vitest";
import { createDisconnectedStatus, parseClientMessage } from "./messages.js";

describe("bridge protocol messages", () => {
  it("validates heartbeat probe IDs while retaining the existing protocol messages", () => {
    expect(parseClientMessage('{"kind":"ping","pingId":"probe"}')).toEqual({ kind: "ping", pingId: "probe" });
    for (const pingId of ["", 1, null, "x".repeat(129)])
      expect(() => parseClientMessage(JSON.stringify({ kind: "ping", pingId }))).toThrow(/pingId/);
  });
  it("parses supported client messages", () => {
    const message = parseClientMessage(
      JSON.stringify({
        kind: "result",
        requestId: "abc",
        result: { ok: true }
      })
    );

    expect(message.kind).toBe("result");
  });

  it("rejects unsupported message kinds", () => {
    expect(() => parseClientMessage(JSON.stringify({ kind: "nope" }))).toThrow("Unsupported bridge message kind");
  });

  it("creates actionable disconnected status", () => {
    const status = createDisconnectedStatus();
    expect(status.connected).toBe(false);
    expect(status.message).toContain("EasyEDA Pro extension is not connected");
  });
});

it("keeps browser identity optional for old peers and preserves new coarse diagnostics", () => {
  const legacy = {
    kind: "hello",
    client: "easyeda-pro-extension",
    version: "0.6.18",
    protocolVersion: "0.1.0",
    capabilities: {}
  };
  expect(parseClientMessage(JSON.stringify(legacy))).toEqual(legacy);
  const browserIdentity = { browserName: "Firefox", version: "145.0", appKind: "browser", source: "user_agent" };
  expect(parseClientMessage(JSON.stringify({ ...legacy, browserIdentity }))).toMatchObject({ browserIdentity });
});
