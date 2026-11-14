import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerPcbFreeTextTools } from "./pcbFreeTextTools.js";
it("registers separate inventory/exact-delete contracts without ownership adoption", async () => {
  const server = new McpServer({ name: "t", version: "1" }),
    bridge: any = { call: vi.fn(async () => ({ mutationId: "m" })) };
  registerPcbFreeTextTools(server, bridge);
  const client = new Client({ name: "t", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "easyeda_get_pcb_free_text_inventory",
      "easyeda_prepare_pcb_free_text_delete"
    ]);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    const scope = { projectId: "p", pcbUuid: "pcb", expectedBoardName: "UPPER", protectedBoardName: "Board1" };
    await client.callTool({ name: tools[0].name, arguments: scope });
    expect(bridge.call).toHaveBeenLastCalledWith("readPcbFreeTexts", scope, 60000);
    const args = { ...scope, primitiveIds: ["old"], expectedTexts: [{ PrimitiveId: "old" }], keepTextIds: ["keep"] };
    await client.callTool({ name: tools[1].name, arguments: args });
    expect(bridge.call).toHaveBeenLastCalledWith("preparePcbFreeTextDelete", args, 60000);
    const { keepTextIds: _, ...missingKeep } = args;
    expect((await client.callTool({ name: tools[1].name, arguments: missingKeep })).isError).toBe(true);
    expect(
      (await client.callTool({ name: tools[1].name, arguments: { ...args, protectedBoardName: "Other" } })).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
