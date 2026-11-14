import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { DefaultTimeoutSchema, registerReadTool } from "./common.js";
import { ok, fail } from "../toolResult.js";
const id = z.string().min(1).max(200);
const Scope = { projectId: id, pcbUuid: id, expectedBoardName: id, protectedBoardName: id };
export function registerMechanicalPadTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_get_standalone_npth",
    title: "Read scoped standalone round NPTH mounting pads",
    description:
      "Read-only native standalone NORMAL/MULTI12/empty-net unnumbered round zero-ring NPTH inventory in mm. Excludes every physical component pad. Requires exact active PCB/project/board and a separate protected original board. Drill manufacturing remains unverified.",
    method: "readMechanicalPads",
    inputSchema: { ...Scope, timeoutMs: DefaultTimeoutSchema.default(60000) },
    summary: "Observed standalone round NPTH pads without CAD writes."
  });
  server.registerTool(
    "easyeda_prepare_standalone_npth",
    {
      title: "Prepare one standalone NPTH create, move or delete",
      description:
        "Stages exactly one native standalone round NPTH. All x/y and diameter_mm inputs are mm. Explicit diameter required; no inferred M3 size. Move/delete require exact primitiveId and exclude component/plated/netted pads. Guards physical parts/pad nets, unrelated pads and copper/keepout/outline. Exact confirmed_action required. Original native promises retain lifecycle lock; unknown never replays. Independent real NPTH Excellon verification required after create/move.",
      inputSchema: {
        ...Scope,
        action: z.enum(["create", "move", "delete"]),
        primitiveId: z.string().min(1).max(512).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        diameter_mm: z.number().positive().optional(),
        timeoutMs: DefaultTimeoutSchema.default(60000)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ timeoutMs, ...params }) => {
      try {
        return ok("Prepared exactly one NPTH mutation; review preview and use exact confirmation.", {
          result: await bridge.call("prepareMechanicalPad", params, timeoutMs)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
