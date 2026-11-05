import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { registerSchematicPageTools } from "./schematicPageTools.js";
describe("schematic page MCP tools", () => {
  it("registers page, block and connectivity contracts and forwards validated requests", async () => {
    const bridge: any = { call: vi.fn(async () => ({ prepared: true })) };
    const server = new McpServer({ name: "test", version: "1" });
    registerSchematicPageTools(server, bridge);
    const client = new Client({ name: "test", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "easyeda_list_schematic_pages",
          "easyeda_prepare_schematic_page",
          "easyeda_prepare_schematic_block_transfer",
          "easyeda_audit_schematic_connectivity"
        ])
      );
      const r = await client.callTool({
        name: "easyeda_prepare_schematic_block_transfer",
        arguments: { components: ["R1"], destinationPageId: "p2" }
      });
      expect(r.isError).toBeFalsy();
      expect(bridge.call).toHaveBeenCalledWith(
        "prepareSchematicBlockTransfer",
        expect.objectContaining({ components: ["R1"], destinationPageId: "p2", dx: 0, dy: 0 }),
        60000
      );
      const bad = await client.callTool({
        name: "easyeda_prepare_schematic_block_transfer",
        arguments: { components: [], destinationPageId: "p2" }
      });
      expect(bad.isError).toBe(true);
      const audit = await client.callTool({
        name: "easyeda_audit_schematic_connectivity",
        arguments: { nativeNetlistTimeoutMs: 15000, timeoutMs: 60000 }
      });
      expect(audit.isError).toBeFalsy();
      expect(bridge.call).toHaveBeenCalledWith(
        "auditSchematicConnectivity",
        expect.objectContaining({ nativeNetlistTimeoutMs: 15000 }),
        60000
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
