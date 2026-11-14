import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerSchematicCreateReconcileTools } from "./schematicCreateReconcileTools.js";
it("requires complete explicit reviewed pin and footprint evidence and forwards read-only recovery", async () => {
  const bridge: any = { call: vi.fn(async () => ({ status: "applied" })) };
  const server = new McpServer({ name: "t", version: "1" });
  registerSchematicCreateReconcileTools(server, bridge);
  const client = new Client({ name: "t", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const args = {
    mutationId: "m",
    primitiveId: "new",
    originalRecord: { status: "unknown" },
    expectedFootprint: { uuid: "fp", libraryUuid: "lib", name: "PH" },
    expectedPins: [{ pinNumber: "1", x: 10, y: 20, net: "" }]
  };
  try {
    expect(
      (await client.callTool({ name: "easyeda_reconcile_schematic_create", arguments: args })).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith(
      "reconcileSchematicCreate",
      expect.objectContaining(args),
      60000
    );
    expect(
      (await client.callTool({ name: "easyeda_reconcile_schematic_create", arguments: { ...args, expectedPins: [] } }))
        .isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
