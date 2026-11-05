import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerSchematicPruneTools } from "./schematicPruneTools.js";
it("requires explicit board protection and bounded selected IDs in the prepare-only contract", async () => {
  const bridge: any = { call: vi.fn(async () => ({ mutationId: "m", confirmation: "CONFIRM schematic:prunePage m" })) };
  const server = new McpServer({ name: "test", version: "1" });
  registerSchematicPruneTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const args = {
      projectId: "p",
      documentId: "copy-page",
      expectedBoardName: "LOWER",
      protectedBoardName: "Board1",
      componentIds: ["drop"],
      wireIds: ["wire"]
    };
    expect((await client.callTool({ name: "easyeda_prepare_schematic_prune", arguments: args })).isError).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith("prepareSchematicPrune", expect.objectContaining(args), 60000);
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_schematic_prune",
          arguments: { ...args, protectedBoardName: undefined }
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_schematic_prune",
          arguments: { ...args, componentIds: Array.from({ length: 101 }, (_, i) => String(i)) }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
