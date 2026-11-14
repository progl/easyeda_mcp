import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerNativePreflightTools } from "./nativePreflightTools.js";
it("registers a read-only preflight and requires explicit source identity for ERC", async () => {
  const bridge: any = {
    endpoint: "local",
    getStatus: () => ({ connected: true }),
    call: vi.fn(async () => ({ readOnly: true }))
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerNativePreflightTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    expect((await client.callTool({ name: "easyeda_get_native_preflight", arguments: {} })).isError).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledWith(
      "getNativePreflight",
      expect.objectContaining({ includeSourceErc: false }),
      30000
    );
    expect(
      (await client.callTool({ name: "easyeda_get_native_preflight", arguments: { includeSourceErc: true } })).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
