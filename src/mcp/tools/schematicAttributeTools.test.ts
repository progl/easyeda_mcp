import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerSchematicAttributeTools } from "./schematicAttributeTools.js";
it("exposes bounded read-only parent inventory and preserves target", async () => {
  const bridge: any = {
    endpoint: "local",
    getStatus: () => ({ connected: true }),
    call: vi.fn(async () => ({ attributes: [] }))
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerSchematicAttributeTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    expect(
      (
        await client.callTool({
          name: "easyeda_get_schematic_attributes",
          arguments: { parentIds: ["w1"], target: { documentId: "page" } }
        })
      ).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledWith(
      "getSchematicAttributes",
      expect.objectContaining({ parentIds: ["w1"], target: { documentId: "page" } }),
      60000
    );
    expect(
      (await client.callTool({ name: "easyeda_get_schematic_attributes", arguments: { parentIds: [] } })).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
