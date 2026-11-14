import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerLibraryFileExportTools } from "./libraryFileExportTools.js";
it("forwards exact library ID and native budget, returns metadata only, rejects unsupported formats", async () => {
  const bridge: any = {
    call: vi.fn(async () => ({
      nativeFileReceived: true,
      nativeFileSizeBytes: 123,
      saveRequested: true,
      fileName: "header.elibz2",
      format: "elibz2"
    }))
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerLibraryFileExportTools(server, bridge);
  const client = new Client({ name: "t", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const args = {
      kind: "device",
      uuid: "d".repeat(32),
      libraryUuid: "l".repeat(32),
      fileName: "header",
      timeoutMs: 20000
    };
    const result: any = await client.callTool({ name: "easyeda_export_library_file", arguments: args });
    expect(result.isError).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith("exportLibraryFile", { ...args, format: "elibz2" }, 20000);
    expect(result.structuredContent.result).not.toHaveProperty("base64");
    expect(
      (await client.callTool({ name: "easyeda_export_library_file", arguments: { ...args, format: "json" } })).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});

it("is registered in the production tool registry with read-only annotations", async () => {
  const { registerEasyEdaTools } = await import("../registerTools.js");
  const bridge: any = { call: vi.fn(async () => ({ nativeFileReceived: true, saveRequested: true, saved: null })) };
  const server = new McpServer({ name: "registry", version: "1" });
  registerEasyEdaTools(server, bridge);
  const client = new Client({ name: "registry", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const listed = await client.listTools();
    expect(listed.tools.find((t) => t.name === "easyeda_export_library_file")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false
    });
    const result = await client.callTool({
      name: "easyeda_export_library_file",
      arguments: { kind: "footprint", uuid: "fp", libraryUuid: "lib", fileName: "right-angle" }
    });
    expect(result.isError).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith(
      "exportLibraryFile",
      {
        kind: "footprint",
        uuid: "fp",
        libraryUuid: "lib",
        fileName: "right-angle",
        format: "elibz2",
        timeoutMs: 60000
      },
      60000
    );
  } finally {
    await client.close();
    await server.close();
  }
});
