import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerSchematicLegacyRecreateTools } from "./schematicLegacyRecreateTools.js";
it("forwards explicit staged replacement guards and rejects missing protection", async () => {
  const bridge: any = {
    call: vi.fn(async () => ({ mutationId: "m", confirmation: "CONFIRM schematic:legacyDeviceStage m" }))
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerSchematicLegacyRecreateTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const args = {
      phase: "stage",
      wireStrategy: "recreateNamedStubs",
      stubWires: [{ pinNumber: "1", wireId: "wire1" }],
      projectId: "p",
      documentId: "d",
      expectedBoardName: "R2",
      protectedBoardName: "Board1",
      primitiveId: "old",
      device: { uuid: "d".repeat(32), libraryUuid: "l".repeat(32), name: "S2B" },
      stagingX: 1000,
      stagingY: 2000,
      temporaryDesignator: "TMP1",
      temporaryUniqueId: "tmp1"
    };
    expect(
      (await client.callTool({ name: "easyeda_prepare_schematic_legacy_recreate", arguments: args })).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith(
      "prepareLegacyDeviceRecreate",
      expect.objectContaining(args),
      60000
    );
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_schematic_legacy_recreate",
          arguments: { ...args, protectedBoardName: undefined }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
    const reviewedPinContract = {
      mapping: [
        { oldPinNumber: "1", newPinNumber: "1" },
        { oldPinNumber: "2", newPinNumber: "2" }
      ],
      extraNCpins: [
        {
          pinNumber: "0",
          reviewedRole: "mechanical",
          evidence: "Reviewed source and PJ datasheet MS tabs; explicitly leave NC."
        }
      ]
    };
    const commit = {
      ...args,
      phase: "commit",
      reviewedPinContract,
      stageMutationId: "stage",
      expectedFootprint: { uuid: "fp", libraryUuid: "lib", name: "PJ" }
    };
    expect(
      (await client.callTool({ name: "easyeda_prepare_schematic_legacy_recreate", arguments: commit })).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith(
      "prepareLegacyDeviceRecreate",
      expect.objectContaining({ reviewedPinContract }),
      60000
    );
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_schematic_legacy_recreate",
          arguments: { ...commit, reviewedPinContract: { ...reviewedPinContract, mapping: [] } }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
