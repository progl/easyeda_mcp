import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, registerReadTool } from "./common.js";
const Id = z.string().min(1).max(512);
export function registerSchematicPruneTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_schematic_prune",
    title: "Prepare explicit-ID prune of a copied schematic page",
    description:
      "Stages deletion of reviewed explicit current-page part IDs (max100) and wire IDs (max500). Requires explicit project/document/expected board and protected original board; the active page must belong only to the expected copied board. Snapshots every native public component/pin/wire property and full active-schematic EasyEDA pin-net assignments including explicit NC, plus free text when readable. No source API, geometry-as-native, arbitrary ref selection, text edits, fallback, rollback or automatic replay. Each selected type gets one native SDK batch delete, awaited without local cancellation; lifecycle lock stays held for a late promise. Exact confirmation only; partial/incomplete readback remains unknown with execution journal.",
    method: "prepareSchematicPrune",
    inputSchema: {
      projectId: Id,
      documentId: Id,
      expectedBoardName: Id,
      protectedBoardName: Id,
      componentIds: z.array(Id).max(100).default([]),
      wireIds: z.array(Id).max(500).default([]),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary:
      "Prepared explicit schematic prune; review all selected IDs and preserved native pin-net evidence before exact confirmation."
  });
}
