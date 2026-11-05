import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerSchematicDeviceReplaceTools } from "./schematicDeviceReplaceTools.js";
it("exposes only prepare with explicit source identity/library/name and rejects implicit references", async () => {
  const bridge: any = {
    call: vi.fn(async () => ({ mutationId: "m", confirmation: "CONFIRM schematic:replaceDevice m" }))
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerSchematicDeviceReplaceTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const args = {
      sourceIdentity: { projectId: "project", schematicName: "Main", pageName: "CONTROL" },
      primitiveId: "old",
      libraryUuid: "1".repeat(32),
      name: "S3B-PH-K-S"
    };
    expect(
      (await client.callTool({ name: "easyeda_prepare_schematic_device_replace", arguments: args })).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith(
      "prepareSchematicDeviceReplace",
      expect.objectContaining(args),
      60000
    );
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_schematic_device_replace",
          arguments: { ...args, sourceIdentity: undefined }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
