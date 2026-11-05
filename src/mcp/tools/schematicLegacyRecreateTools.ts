import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, registerReadTool } from "./common.js";
export function registerSchematicLegacyRecreateTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_prepare_schematic_legacy_recreate",
    title: "Prepare staged legacy schematic device replacement",
    description:
      "Two separately confirmed phases: stage creates a temporary catalog part; commit uses its applied stageMutationId to replace one original only after native pin geometry/net/NC/footprint proof. Protected original board is never writable. No Source API, implicit wire changes, automatic cleanup/rollback, PCB sync or replay of unknown writes. Explicit recreateNamedStubs requires isolated reviewed old stubs and previews exact new geometry. Keep the page unchanged between phases.",
    method: "prepareLegacyDeviceRecreate",
    inputSchema: {
      phase: z.enum(["stage", "commit"]),
      wireStrategy: z
        .enum(["preserve", "recreateNamedStubs"])
        .default("preserve")
        .describe("Named-stub replacement must be explicit; preserve never changes wires"),
      stubWires: z
        .array(z.object({ pinNumber: z.string().min(1).max(128), wireId: z.string().min(1).max(512) }).strict())
        .min(1)
        .max(100)
        .optional()
        .describe("Commit named-stub strategy: exact reviewed one independent existing named wire per original pin"),
      reviewedPinContract: z
        .object({
          mapping: z
            .array(
              z.object({ oldPinNumber: z.string().min(1).max(128), newPinNumber: z.string().min(1).max(128) }).strict()
            )
            .length(2),
          extraNCpins: z
            .array(
              z
                .object({
                  pinNumber: z.string().min(1).max(128),
                  reviewedRole: z.literal("mechanical"),
                  evidence: z.string().min(1).max(2000)
                })
                .strict()
            )
            .length(1)
        })
        .strict()
        .optional()
        .describe(
          "Commit-only recreateNamedStubs: explicitly reviewed complete2to3 mapping and one mechanical extra pin left native NC; evidence is a caller-reviewed decision, not proof of physical metal isolation."
        ),
      projectId: z.string().min(1).max(512),
      documentId: z.string().min(1).max(512),
      expectedBoardName: z.string().min(1).max(512),
      protectedBoardName: z.string().min(1).max(512),
      primitiveId: z.string().min(1).max(512),
      device: z
        .object({
          uuid: z.string().regex(/^[a-z0-9]{32}$/i),
          libraryUuid: z.string().regex(/^[a-z0-9]{32}$/i),
          name: z.string().min(1)
        })
        .passthrough()
        .optional(),
      stagingX: z.number().optional(),
      stagingY: z.number().optional(),
      temporaryDesignator: z.string().min(1).max(512).optional(),
      temporaryUniqueId: z.string().min(1).max(512).optional(),
      expectedFootprint: z
        .object({ uuid: z.string().min(1), libraryUuid: z.string().min(1), name: z.string().min(1) })
        .strict()
        .optional()
        .describe("Commit only: explicitly reviewed actual cached native footprint from applied stage result"),
      stageMutationId: z.string().min(1).optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary:
      "Review staged replacement preview and confirm exactly. Commit requires applied stage receipt and unchanged native page."
  });
  registerReadTool(server, bridge, {
    name: "easyeda_reconcile_schematic_legacy_stage",
    title: "Read-only reconcile or restore settled legacy stage",
    description:
      "Reconciles settled unknown legacyDeviceStage, or restores a missing applied stage after bridge restart, using its complete original receipt and settled SDK ID journal. Applied restore independently verifies the full recorded after snapshot and exact cached native references before registry insertion. Independently proves original/kept public contents and full native pin/net/NC unchanged, and exact new temporary identity/reference/NC. Does not create/delete/modify/cleanup. geometryCompatible:false is honest and preserve commit stays prohibited. Keep original receipt and staged part for explicit later decisions.",
    method: "reconcileLegacyDeviceStage",
    inputSchema: {
      mutationId: z.string().min(1).max(128),
      originalRecord: z.record(z.string(), z.unknown()).optional(),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Read-only stage observation completed; check geometryCompatible separately. No CAD write or replay."
  });
}
