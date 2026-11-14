import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, registerReadTool } from "./common.js";
export function registerSchematicCreateReconcileTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_reconcile_schematic_create",
    title: "Reconcile settled schematic create without CAD writes",
    description:
      "Read-only recovery of one settled unknown create. Requires original receipt after reload, SDK-returned primitive ID and independently reviewed complete footprint/pin geometry/net/NC expectations. Promotes status only after exact public identity/pose and scoped native pin-map proof. Never creates, modifies, deletes, retries or rolls back. Cached component UUID is not catalog-origin proof; PCB/model completeness and unrelated contents remain unverified.",
    method: "reconcileSchematicCreate",
    inputSchema: {
      mutationId: z.string().min(1).max(128),
      originalRecord: z.record(z.string(), z.unknown()).optional(),
      primitiveId: z.string().min(1).max(512),
      expectedFootprint: z
        .object({ uuid: z.string().min(1), libraryUuid: z.string().min(1), name: z.string().min(1) })
        .strict(),
      expectedPins: z
        .array(z.object({ pinNumber: z.string().min(1), x: z.number(), y: z.number(), net: z.string() }).strict())
        .min(1)
        .max(500),
      timeoutMs: DefaultTimeoutSchema.default(60000)
    },
    summary: "Read-only reconciliation inspected the original settled create; no CAD write or replay occurred."
  });
}
