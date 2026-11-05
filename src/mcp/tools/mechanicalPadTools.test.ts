import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerMechanicalPadTools } from "./mechanicalPadTools.js";
it("registers bounded standalone NPTH contracts and forwards exact mm inputs", async () => {
  const server = new McpServer({ name: "t", version: "1" }),
    bridge: any = { call: vi.fn(async () => ({ mutationId: "m" })) };
  registerMechanicalPadTools(server, bridge);
  const client = new Client({ name: "t", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual(["easyeda_get_standalone_npth", "easyeda_prepare_standalone_npth"]);
    expect(listed[0].annotations?.readOnlyHint).toBe(true);
    expect(listed[1].annotations?.destructiveHint).toBe(true);
    const scope = { projectId: "p", pcbUuid: "pcb", expectedBoardName: "UPPER", protectedBoardName: "Board1" };
    const args = { ...scope, action: "create", x: 32, y: 12, diameter_mm: 3.2 };
    expect((await client.callTool({ name: listed[1].name, arguments: args })).isError).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith("prepareMechanicalPad", args, 60000);
    await client.callTool({ name: listed[0].name, arguments: scope });
    expect(bridge.call).toHaveBeenLastCalledWith("readMechanicalPads", scope, 60000);
    const { protectedBoardName: _, ...incomplete } = scope;
    expect(
      (
        await client.callTool({
          name: listed[1].name,
          arguments: { ...incomplete, action: "delete", primitiveId: "x" }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
