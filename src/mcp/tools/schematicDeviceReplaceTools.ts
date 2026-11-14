import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, DocumentTargetSchema, registerReadTool } from "./common.js";
export function registerSchematicDeviceReplaceTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_schematic_device_replace",
    title: "Prepare guarded schematic device replacement",
    description:
      "Stages public sch_SourcePrimitiveComponent.replace for one explicitly identified schematic device. Resolves one exact library/name, snapshots source pins/nets and live uniqueId/footprint, and requires exact mutation confirmation. No force, create/delete fallback or automatic PCB sync. REPLACE_REJECTED is not success; unknown is never replayed. Model/PCB geometry remains unverified; validate on a copy first.",
    method: "prepareSchematicDeviceReplace",
    inputSchema: {
      sourceIdentity: z
        .object({
          projectId: z.string().min(1).max(512),
          schematicName: z.string().min(1).max(512),
          pageName: z.string().min(1).max(512)
        })
        .strict(),
      primitiveId: z.string().min(1).max(512),
      libraryUuid: z.string().regex(/^[a-z0-9]{32}$/i),
      name: z.string().min(1).max(512),
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Prepared schematic device replacement; inspect preservation evidence and use exact confirmation."
  });
}
