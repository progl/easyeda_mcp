import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { ok, fail } from "../toolResult.js";
import { DefaultTimeoutSchema, DocumentTargetSchema } from "./common.js";
export function registerPcbAnnotationTools(server: McpServer, bridge: EditorClient): void {
  const common = {
    layer: z.union([z.literal(3), z.literal(4), z.literal(13)]),
    x: z.number(),
    y: z.number(),
    lineWidth: z.number().positive()
  };
  const item = z.discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("text"),
        text: z.string().min(1).max(1000),
        fontSize: z.number().positive()
      })
      .strict(),
    z
      .object({ ...common, kind: z.literal("rectangle"), width: z.number().positive(), height: z.number().positive() })
      .strict()
  ]);
  server.registerTool(
    "easyeda_prepare_pcb_annotation",
    {
      title: "Prepare PCB text and unfilled annotation frames",
      description:
        "Prepares create/modify/delete of tool-owned text and rectangle frames only on TopSilkscreen (3), BottomSilkscreen (4), Document (13). Rectangles use one native empty-net Polyline, no fill. Existing IDs require the original applied createAnnotations receipt after a runtime reload; receipt target/ID/native state are verified before adoption. This is caller-supplied historical evidence, not a cryptographic provenance claim. Coordinates, fontSize and lineWidth default to native mil; set units:mm for metric. Text uses default font, bottom-left alignment, rotation 0, no mirror/reverse. Preview/readback use mil. Apply only through easyeda_confirm_action with the exact returned confirmation. Creation is not idempotent: never replay an unknown outcome automatically.",
      inputSchema: {
        action: z.enum(["create", "modify", "delete"]).default("create"),
        items: z.array(item).min(1).max(100).optional(),
        kind: z.enum(["text", "rectangle"]).optional(),
        primitiveId: z.string().min(1).max(512).optional(),
        properties: z
          .object({
            x: z.number().optional(),
            y: z.number().optional(),
            text: z.string().min(1).max(1000).optional(),
            fontSize: z.number().positive().optional(),
            lineWidth: z.number().positive().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            layer: z.union([z.literal(3), z.literal(4), z.literal(13)]).optional(),
            rotation: z.number().optional()
          })
          .strict()
          .optional(),
        originalCreationReceipt: z
          .object({
            mutationId: z.string().min(1),
            action: z.literal("createAnnotations"),
            status: z.literal("applied"),
            target: DocumentTargetSchema,
            after: z.object({ primitives: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).passthrough()
          })
          .passthrough()
          .optional(),
        units: z.enum(["mil", "mm"]).default("mil"),
        target: DocumentTargetSchema.optional(),
        timeoutMs: DefaultTimeoutSchema.default(30000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params) => {
      try {
        const result = (await bridge.call("preparePcbAnnotation", params, params.timeoutMs)) as Record<string, unknown>;
        return ok("Prepared PCB annotations; inspect preview and apply using the exact confirmation.", result);
      } catch (error) {
        return fail(error);
      }
    }
  );
}
