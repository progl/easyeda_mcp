import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerBoardOperationTools, BoardInventorySchema } from "./boardOperationTools.js";
it("preserves explicit copy arguments and exact read-only nested inventory without Source APIs", async () => {
  const inventory = {
    projectId: "p",
    currentBoardName: "Board1",
    target: { documentId: "page" },
    boards: [
      {
        name: "Board1",
        projectId: "p",
        schematic: {
          uuid: "sch",
          name: "Main",
          pageCount: 1,
          pages: [{ uuid: "page", name: "CONTROL", parentSchematicUuid: "sch" }]
        },
        pcb: { uuid: "pcb", name: "PCB1" }
      }
    ],
    activeCounts: null,
    capturedAt: new Date().toISOString(),
    readOnly: true
  };
  expect(BoardInventorySchema.parse(inventory).boards[0].schematic.pages[0].uuid).toBe("page");
  const bridge: any = {
    call: vi.fn(async (method: string) =>
      method === "getBoardInventory" ? inventory : { mutationId: "m", confirmation: "CONFIRM project:copyBoard m" }
    )
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerBoardOperationTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const result: any = await client.callTool({ name: "easyeda_get_board_inventory", arguments: { projectId: "p" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.result.boards[0].schematic.pages[0].uuid).toBe("page");
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_board_operation",
          arguments: { action: "copy", projectId: "p", sourceBoardName: "Board1" }
        })
      ).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith(
      "prepareBoardOperation",
      expect.objectContaining({ action: "copy", projectId: "p", sourceBoardName: "Board1" }),
      60000
    );
  } finally {
    await client.close();
    await server.close();
  }
});
