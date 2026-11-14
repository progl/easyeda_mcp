import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, DocumentTargetSchema, registerReadTool } from "./common.js";
import { ok, fail } from "../toolResult.js";
const BoardName = z.string().min(1).max(200);
export const BoardReferenceSchema = z.object({
  uuid: z.string().optional(),
  name: BoardName,
  projectId: z.string(),
  schematic: z.object({
    uuid: z.string(),
    name: z.string(),
    pageCount: z.number().int().positive(),
    pages: z.array(z.object({ uuid: z.string(), name: z.string(), parentSchematicUuid: z.string() }))
  }),
  pcb: z.object({ uuid: z.string(), name: z.string() })
});
export const BoardInventorySchema = z.object({
  projectId: z.string(),
  currentBoardName: z.string().nullable(),
  target: z.record(z.string(), z.unknown()),
  boards: z.array(BoardReferenceSchema),
  activeCounts: z
    .object({
      scope: z.enum(["active_page", "active_pcb"]),
      documentId: z.string(),
      componentCount: z.number().int().nonnegative()
    })
    .nullable(),
  capturedAt: z.string(),
  readOnly: z.literal(true)
});
export function registerBoardOperationTools(server: McpServer, bridge: EditorClient) {
  server.registerTool(
    "easyeda_get_board_inventory",
    {
      title: "Read project board and document links",
      description:
        "Reads public legacy current project, all/current board and exact SCH/PCB/page UUID links without opening any document or source API. Optional counts cover only the currently rendered page/PCB, never an unopened copy. Full nested links are retained without generic depth sanitization.",
      inputSchema: {
        projectId: z.string().min(1).optional(),
        target: DocumentTargetSchema.optional(),
        includeActiveCounts: z.boolean().default(false),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      },
      outputSchema: z.object({ result: BoardInventorySchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params) => {
      try {
        return ok("Read exact native board/SCH/PCB/page inventory.", {
          result: await bridge.call("getBoardInventory", params, params.timeoutMs)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
  registerReadTool(server, bridge, {
    name: "easyeda_reconcile_board_copy",
    title: "Reconcile a settled unknown board copy without writing CAD",
    description:
      "Reads fresh public legacy board inventory and reconciles only a settled unknown copyBoard journal. Requires exactly one additional complete board, distinct SCH/PCB/page UUIDs, matching page names/counts and every original board unchanged. Does not repeat copy, rename, delete or open any document. Optional originalRecord is the DIRECT saved unknown MutationRecord when the old runtime journal was lost; it is caller-provided historical evidence, not a cryptographic receipt. Project must match, but the active page may be the copied board. Component/net/3D contents remain unverified.",
    method: "reconcileBoardCopy",
    inputSchema: {
      mutationId: z.string().min(1).max(128),
      originalRecord: z.record(z.string(), z.unknown()).optional(),
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary:
      "Reconciled original board-copy evidence through read-only native inventory; inspect the journal and explicit verification limits."
  });
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_board_operation",
    title: "Prepare whole-board copy or explicit board rename",
    description:
      "Stages copy or rename in the explicitly current project using public legacy DMT_Board APIs. Copy accepts only sourceBoardName and generates its own name; it never overwrites, silently renames or deletes an inconclusive copy. Rename is a separate exact-confirmed operation requiring a nonexisting newName. Guards current board/project/document and full link inventory. Copy proves new distinct SCH/PCB/page links and source preservation; component/pad/net/3D contents require separate inspection. Unknown never replays.",
    method: "prepareBoardOperation",
    inputSchema: {
      action: z.enum(["copy", "rename"]),
      projectId: z.string().min(1),
      sourceBoardName: BoardName,
      newName: BoardName.optional(),
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Prepared exact-confirmed native board operation; preserve real project backup before copying."
  });
}
