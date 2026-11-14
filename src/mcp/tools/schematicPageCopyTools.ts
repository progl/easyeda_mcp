import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, DocumentTargetSchema, registerReadTool } from "./common.js";

const Id = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) => s === s.trim() && !Array.from(s).some((char) => char.charCodeAt(0) < 32),
    "Explicit identifier without whitespace/control characters required."
  );
export function registerSchematicPageCopyTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_schematic_page_copy",
    title: "Prepare copying one schematic page to another schematic",
    description:
      "Read-only preparation for exact-confirmed copy through public legacy copySchematicPage(sourcePageId,destinationSchematicUuid). Requires explicit project/source/destination, distinct schematics in one verified project, exact inventory/current-target guards. Copy runs once only on confirmation; proves exactly one new destination page and unchanged original metadata. Contents and backup status remain unverified; no cleanup or replay. Native execution/readback has a 40-second total budget.",
    method: "prepareSchematicPageCopy",
    inputSchema: {
      projectId: Id,
      sourcePageId: Id,
      destinationSchematicUuid: Id,
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary:
      "Prepared a page copy without writing; use the exact mutation confirmation and inspect verification limits."
  });
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_schematic_page_delete",
    title: "Prepare destructive deletion of one explicit non-last schematic page",
    description:
      "Read-only preparation of a DESTRUCTIVE exact-confirmed deleteSchematicPage(pageUuid). Requires explicit projectId/pageUuid/owningSchematicUuid/protectedBoardName and verified native metadata; refuses every page of the protected board, the last page and stale inventory. Actual confirmation removes all page contents. Success requires native true, page absence and every other page metadata unchanged; never cleans up an unknown copy or replays a write. Backup/working-copy status is not independently verified.",
    method: "prepareSchematicPageDelete",
    inputSchema: {
      projectId: Id,
      pageUuid: Id,
      owningSchematicUuid: Id,
      protectedBoardName: Id,
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary:
      "Prepared destructive page deletion without writing; actual deletion requires the exact separate confirmation."
  });
  registerReadTool(server, bridge, {
    name: "easyeda_get_schematic_page_inventory",
    title: "Read complete native schematic page metadata",
    description:
      "Read-only exact project board/page inventory and public getSchematicPageInfo metadata. No document opening or CAD writes.",
    method: "getSchematicPageInventory",
    inputSchema: {
      projectId: Id,
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Read native schematic page metadata without writing."
  });
  registerReadTool(server, bridge, {
    name: "easyeda_reconcile_schematic_page_delete",
    title: "Read-only reconciliation of a settled unknown page deletion",
    description:
      "Reconcile only a settled unknown original delete receipt through the mutation lifecycle. Fresh native metadata must prove exactly the deleted page absent and all other pages preserved, allowing derived owning-schematic title-block values only. Never repeats deletion. Original SDK boolean acknowledgment may be unavailable; content verification remains false.",
    method: "reconcileSchematicPageDelete",
    inputSchema: {
      mutationId: Id,
      originalRecord: z.record(z.string(), z.unknown()).optional(),
      target: DocumentTargetSchema.optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Reconciled observed deletion state read-only, without repeating the SDK write."
  });
}
