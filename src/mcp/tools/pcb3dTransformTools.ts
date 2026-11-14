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
const Scope = {
  projectId: id,
  pcbUuid: id,
  expectedBoardName: id,
  protectedBoardName: z.literal("Board1"),
  primitiveId: id
};
const ref = z.object({ uuid: id, libraryUuid: z.string().max(512), name: z.string().max(1024).optional() }).strict();
export function registerPcb3dTransformTools(server: McpServer, bridge: EditorClient) {
  registerReadTool(server, bridge, {
    name: "easyeda_get_pcb_3d_transform",
    title: "Read one actual native PCB component 3D transform",
    description:
      "Read-only3.2.209 component override probe with exact R2 PCB/project/component scope and protected Board1. Returns actual public component OtherProperty legacy9 tuple, model/footprint refs, pose and physical pads; no library substitution, raw Source API, model mesh load or CAD writes. Tuple linear units are mil and angles degrees; no global/local sign conversion is performed.",
    method: "readPcb3dTransform",
    inputSchema: { ...Scope, timeoutMs: DefaultTimeoutSchema.default(60000) },
    summary: "Observed actual native component transform without authoring from a library default."
  });
  server.registerTool(
    "easyeda_prepare_pcb_3d_transform",
    {
      title: "Prepare exactly one native component 3D transform attribute",
      description:
        "Stage only existing OtherProperty['3D Model Transform'] for one reviewed PCB component. Requires exact actual old tuple string, complete public model/footprint refs and9 finite caller-reviewed new native numbers (dx,dy,dz,rz,rx,ry,tx,ty,tz; linear mil, angles degrees). No unit/sign/placement inference or model/footprint/BOM/library edits. Full lossless native proof preserves all other component properties, pads/nets, attributes and geometry. Apply via exact confirmation; uses public toAsync/setState_OtherProperty(one key)/await done, retains original promise lock, never replays unknown. Fresh native3D20-pin/height/export and saved archive proof remain separate.",
      inputSchema: {
        ...Scope,
        expectedOldTuple: z.string().min(1).max(2000),
        newTuple: z.array(z.number()).length(9),
        expectedModelRef: ref,
        expectedFootprintRef: ref,
        timeoutMs: DefaultTimeoutSchema.default(60000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ timeoutMs, ...params }) => {
      try {
        return ok("Prepared one3D transform attribute; inspect exact delta and use exact mutation confirmation.", {
          result: await bridge.call("preparePcb3dTransform", params, timeoutMs)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
