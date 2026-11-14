import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, DocumentTargetSchema } from "./common.js";
import { fail, ok } from "../toolResult.js";
export function registerSchematicPageTools(server: McpServer, bridge: EditorClient) {
  const specs: Array<{ name: string; method: string; description: string; schema: Record<string, z.ZodType> }> = [
    {
      name: "easyeda_list_schematic_pages",
      method: "listSchematicPages",
      description:
        "Lists pages of the active schematic. Optional counts temporarily activate pages and restore focus. Reports part counts, anchor bounds and drawing format; 150 is a recommendation, not a hard limit.",
      schema: {
        includeCounts: z.boolean().default(false),
        target: DocumentTargetSchema.optional(),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      }
    },
    {
      name: "easyeda_prepare_schematic_page",
      method: "prepareSchematicPage",
      description:
        "Prepares create, rename or drawing format changes for a page in the active schematic. Requires exact confirmation via easyeda_confirmed_action. Does not delete pages; save remains separate.",
      schema: {
        action: z.enum(["create", "rename", "format"]),
        pageId: z.string().min(1).optional(),
        name: z.string().min(1).max(128).optional(),
        format: z.enum(["A0", "A1", "A2", "A3", "A4"]).optional(),
        target: DocumentTargetSchema.optional(),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      }
    },
    {
      name: "easyeda_prepare_schematic_block_transfer",
      method: "prepareSchematicBlockTransfer",
      description:
        "Prepares a non-atomic transfer of 1–100 parts and their complete named wires to another page of this schematic. Preserves designators, unique IDs and properties; verifies copy before deleting source. Rejects physical boundary wires, destination conflicts and unsupported free annotations. Inspect journal after failure; never replay blindly. Offsets use native schematic units (10 mil).",
      schema: {
        components: z.array(z.string().min(1)).min(1).max(100),
        destinationPageId: z.string().min(1),
        dx: z.number().finite().default(0),
        dy: z.number().finite().default(0),
        target: DocumentTargetSchema.optional(),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      }
    },
    {
      name: "easyeda_audit_schematic_connectivity",
      method: "auditSchematicConnectivity",
      description:
        "Reads each page of the active schematic and audits exact native pin-net membership, duplicate references, unknown pins and interpage nets. Namespaces page-local IDs, restores focus; does not treat geometric guesses as native verification.",
      schema: {
        target: DocumentTargetSchema.optional(),
        nativeNetlistTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(20000)
          .default(3000)
          .describe("Native netlist export/read budget; separate from transport timeoutMs, at most 20000 ms."),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      }
    }
  ];
  for (const spec of specs)
    server.registerTool(
      spec.name,
      {
        title: spec.name,
        description: spec.description,
        inputSchema: spec.schema,
        annotations: {
          readOnlyHint: spec.name.startsWith("easyeda_prepare"),
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (args: any) => {
        try {
          const { timeoutMs, ...params } = args;
          return ok(spec.description, (await bridge.call(spec.method, params, timeoutMs)) as Record<string, unknown>);
        } catch (error) {
          return fail(error);
        }
      }
    );
}
