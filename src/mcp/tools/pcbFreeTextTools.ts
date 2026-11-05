import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, registerReadTool } from "./common.js";
import { ok, fail } from "../toolResult.js";
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v === v.trim());
const Scope = { projectId: id, pcbUuid: id, expectedBoardName: id, protectedBoardName: z.literal("Board1") };
export function registerPcbFreeTextTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_get_pcb_free_text_inventory",
    title: "Read scoped parentless PCB String inventory",
    description:
      "Read-only free String inventory on layers3/4/13, pinned editor3.2.209. Requires exact active project/PCB/non-protected board and separate protected Board1. Parentless String.getAll membership, independent String.get type/style and component Attribute exclusion. Reads complete11 primitive groups and physical pads/nets for preservation; returns compact text rows/counts in mil. No ownership adoption or CAD writes.",
    method: "readPcbFreeTexts",
    inputSchema: { ...Scope, timeoutMs: DefaultTimeoutSchema.default(60000) },
    summary: "Observed parentless PCB texts without writes."
  });
  server.registerTool(
    "easyeda_prepare_pcb_free_text_delete",
    {
      title: "Prepare exact reviewed free PCB text deletion",
      description:
        "Stages deletion of1–100 explicit parentless String IDs on layers3/4/13 in editor3.2.209. expectedTexts must exactly match complete native rows from inventory; keepTextIds is mandatory and disjoint. Guards all other native primitives/components/attributes/pads/nets, copper/keepouts/outline and board inventory. Does not adopt ownership or alter existing owned-annotation tools. Apply only through easyeda_confirm_action with exact confirmation. Sequential awaited native deletes retain journal; unknown never replays. Separate saved Epro proof required.",
      inputSchema: {
        ...Scope,
        primitiveIds: z.array(id).min(1).max(100),
        expectedTexts: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
        keepTextIds: z.array(id).max(100),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ timeoutMs, ...params }) => {
      try {
        return ok("Prepared exact free PCB text deletion; inspect full preview and use exact confirmation.", {
          result: await bridge.call("preparePcbFreeTextDelete", params, timeoutMs)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
