import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerPcb3dTransformTools } from "./pcb3dTransformTools.js";
it("exposes a read-only actual-tuple probe and an exact one-property staged contract", async () => {
  const server = new McpServer({ name: "test", version: "1" }),
    bridge: any = { call: vi.fn(async () => ({ mutationId: "m" })) };
  registerPcb3dTransformTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["easyeda_get_pcb_3d_transform", "easyeda_prepare_pcb_3d_transform"]);
    const scope = {
      projectId: "p",
      pcbUuid: "pcb",
      expectedBoardName: "LOWER",
      protectedBoardName: "Board1",
      primitiveId: "header"
    };
    await client.callTool({ name: tools[0].name, arguments: scope });
    expect(bridge.call).toHaveBeenLastCalledWith("readPcb3dTransform", scope, 60000);
    const args = {
      ...scope,
      expectedOldTuple: "1,2,3,4,5,6,7,8,9",
      newTuple: [1, 2, 3, 4, 5, 6, 7, 8, 10],
      expectedModelRef: { uuid: "model", libraryUuid: "lib" },
      expectedFootprintRef: { uuid: "fp", libraryUuid: "lib" }
    };
    await client.callTool({ name: tools[1].name, arguments: args });
    expect(bridge.call).toHaveBeenLastCalledWith("preparePcb3dTransform", args, 60000);
    expect((await client.callTool({ name: tools[1].name, arguments: { ...args, newTuple: [1, 2] } })).isError).toBe(
      true
    );
    expect(
      (await client.callTool({ name: tools[1].name, arguments: { ...args, expectedModelRef: undefined } })).isError
    ).toBe(true);
    expect(
      (await client.callTool({ name: tools[1].name, arguments: { ...args, protectedBoardName: "other" } })).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
