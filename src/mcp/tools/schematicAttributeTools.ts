import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, DocumentTargetSchema, registerReadTool } from "./common.js";
export function registerSchematicAttributeTools(server: McpServer, bridge: EditorClient): void {
  registerReadTool(server, bridge, {
    name: "easyeda_get_schematic_attributes",
    title: "Read schematic labels and component attributes",
    description:
      "Reads public attribute getters with explicit parent coverage, provenance and discrepancy warnings. Optional parentIds accepts 1–300 current-page primitive IDs; otherwise enumerates current-page components and wires. Reports actual attribute/parent IDs, key/value, positions, font/style and visibility. Empty/incomplete parent reads may use getAllPrimitiveId/get fallback. Deduplicates attributes; global empty results are never assumed to prove no labels. This is a read-only non-atomic snapshot, not a mutation or layout verification.",
    method: "getSchematicAttributes",
    inputSchema: {
      parentIds: z.array(z.string().min(1)).min(1).max(300).optional(),
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Read schematic attribute inventory with parent/global coverage evidence."
  });
}
