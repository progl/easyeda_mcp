import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerSchematicPageCopyTools } from "./schematicPageCopyTools.js";

it("exposes only read-only prepare tools with honest destructive previews and explicit owner schemas", async () => {
  const bridge: any = { call: vi.fn(async () => ({ mutationId: "id", confirmation: "exact receipt" })) };
  const server = new McpServer({ name: "test", version: "1" });
  registerSchematicPageCopyTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(4);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      if (tool.name.includes("prepare")) expect(tool.description).toMatch(/confirm/i);
    }
    const copy = await client.callTool({
      name: "easyeda_prepare_schematic_page_copy",
      arguments: {
        projectId: "p",
        sourcePageId: "src",
        destinationSchematicUuid: "dst"
      }
    });
    expect(copy.isError).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith(
      "prepareSchematicPageCopy",
      {
        projectId: "p",
        sourcePageId: "src",
        destinationSchematicUuid: "dst"
      },
      60000
    );
    const before = bridge.call.mock.calls.length;
    const missingOwner = await client.callTool({
      name: "easyeda_prepare_schematic_page_delete",
      arguments: {
        projectId: "p",
        pageUuid: "page"
      }
    });
    expect(missingOwner.isError).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(before);
    const removal = await client.callTool({
      name: "easyeda_prepare_schematic_page_delete",
      arguments: {
        projectId: "p",
        pageUuid: "page",
        owningSchematicUuid: "sch",
        protectedBoardName: "Original"
      }
    });
    expect(removal.isError).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith(
      "prepareSchematicPageDelete",
      {
        projectId: "p",
        pageUuid: "page",
        owningSchematicUuid: "sch",
        protectedBoardName: "Original"
      },
      60000
    );
  } finally {
    await client.close();
    await server.close();
  }
});
