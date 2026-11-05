import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema } from "./common.js";
import { ok, fail } from "../toolResult.js";
export function registerLibraryFileExportTools(server: McpServer, bridge: EditorClient) {
  server.registerTool(
    "easyeda_export_library_file",
    {
      title: "Export real native library file without CAD changes",
      description:
        "Reads one explicit device/footprint/symbol through public sys_FileManager library-file API and requests a local download of the original native File as elibz2 under a friendly filename. Opens no CAD document and changes no schematic/PCB. Returns metadata only, never base64/mock JSON. ZIP framing is checked; member CRC, pin-pad mapping and geometry remain unverified. Inspect downloads if outcome is unknown; no automatic retry.",
      inputSchema: {
        kind: z.enum(["device", "footprint", "symbol"]),
        uuid: z.string().min(1).max(128),
        libraryUuid: z.string().min(1).max(128),
        fileName: z.string().min(1).max(240).optional(),
        format: z.literal("elibz2").default("elibz2"),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ timeoutMs, ...params }) => {
      try {
        return ok(
          "Native library File received and local save requested. Verify the downloaded archive before using its geometry.",
          { result: await bridge.call("exportLibraryFile", { ...params, timeoutMs }, timeoutMs) }
        );
      } catch (error) {
        return fail(error);
      }
    }
  );
}
