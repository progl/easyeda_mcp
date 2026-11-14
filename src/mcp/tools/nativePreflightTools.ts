import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EditorClient } from "../../editor/EditorClient.js";
import { ok, fail } from "../toolResult.js";
import { DefaultTimeoutSchema, DocumentTargetSchema } from "./common.js";
export function registerNativePreflightTools(server: McpServer, bridge: EditorClient): void {
  server.registerTool(
    "easyeda_get_native_preflight",
    {
      title: "Inspect native write completion, units and optional source ERC",
      description:
        "Read-only report of active target, bridge-managed pending/unknown mutations, native method availability and verified reference-SDK completion risks. An unlocked bridge does not prove the native queue is drained. PCB hole tuple conversion remains runtime-unverified; the inspected reference client used 10mil tuples versus mil XY. Optional sch_SourceDrc.check returns public source-rule warning/error elements for an explicit source identity; it does not replace editor ERC. No writes, flushes or implicit source identity guesses.",
      inputSchema: {
        target: DocumentTargetSchema.optional(),
        includeSourceErc: z.boolean().default(false),
        sourceIdentity: z
          .object({ projectId: z.string().min(1), schematicName: z.string().min(1), pageName: z.string().min(1) })
          .strict()
          .optional(),
        timeoutMs: DefaultTimeoutSchema.default(30000)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params) => {
      try {
        if (params.includeSourceErc && !params.sourceIdentity)
          throw new Error("includeSourceErc requires explicit sourceIdentity.");
        const result = (await bridge.call("getNativePreflight", params, params.timeoutMs)) as Record<string, unknown>;
        return ok("Inspected native preflight evidence; runtime native queue completion is not observable.", result);
      } catch (error) {
        return fail(error);
      }
    }
  );
}
