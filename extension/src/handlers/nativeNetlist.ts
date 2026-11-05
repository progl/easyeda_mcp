import {
  parseNativeNetlist,
  nativeExportDuplicateDesignators,
  type NativeNetlistData
} from "../../../src/schematic/nativeNetlist.js";
import type { EasyEdaApi } from "../types.js";

export function validateNativeNetlistTimeoutMs(value: unknown = 3000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20000)
    throw new Error("nativeNetlistTimeoutMs must be an integer between 1 and 20000 ms.");
  return value;
}

export async function collectNativeNetlist(
  eda: EasyEdaApi,
  allPages: boolean,
  nativeNetlistTimeoutMs = 3000,
  preferredFormat?: "EasyEDA"
): Promise<NativeNetlistData> {
  const timeoutMs = validateNativeNetlistTimeoutMs(nativeNetlistTimeoutMs);
  const startedAt = Date.now();
  let attemptedFormat: "Protel2" | "EasyEDA" = "Protel2";
  const attemptedFormats: Array<"Protel2" | "EasyEDA"> = [];
  const resultWithRead = (data: NativeNetlistData, timedOut = false): NativeNetlistData => ({
    ...data,
    read: { timeoutMs, durationMs: Date.now() - startedAt, timedOut, attemptedFormats: [...attemptedFormats] }
  });
  if (!eda.sch_ManufactureData?.getNetlistFile)
    return resultWithRead({
      format: attemptedFormat,
      status: "unavailable",
      reason: "sch_ManufactureData.getNetlistFile is unavailable"
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const ensureRead = () => {
    if (expired) throw new Error("Native netlist observation already timed out; no later native calls.");
  };
  const readScope = async () => {
    ensureRead();
    if (typeof eda.dmt_Schematic?.getCurrentSchematicInfo !== "function") return undefined;
    const schematic = await eda.dmt_Schematic.getCurrentSchematicInfo();
    ensureRead();
    if (typeof schematic?.uuid !== "string" || !schematic.uuid)
      throw new Error("Cannot establish active schematic native-export scope.");
    let board: any;
    if (typeof eda.dmt_Board?.getCurrentBoardInfo === "function") {
      board = await eda.dmt_Board.getCurrentBoardInfo();
      ensureRead();
      if (board && board.schematic?.uuid !== schematic.uuid)
        throw new Error("Active board and schematic native-export scope disagree.");
    }
    return {
      schematicUuid: schematic.uuid,
      ...(schematic.parentProjectUuid ? { projectId: schematic.parentProjectUuid } : {}),
      ...(board?.name ? { boardName: board.name } : {})
    };
  };
  try {
    const read = (async (): Promise<NativeNetlistData> => {
      let text: string | undefined;
      let format: "Protel2" | "EasyEDA" = "Protel2";
      let lastError: unknown;
      const beforeScope = await readScope();
      for (const candidate of (preferredFormat ? [preferredFormat] : ["Protel2", "EasyEDA"]) as Array<
        "Protel2" | "EasyEDA"
      >) {
        ensureRead();
        attemptedFormat = candidate;
        attemptedFormats.push(candidate);
        try {
          const file = await eda.sch_ManufactureData.getNetlistFile("mcp-native-connectivity", candidate);
          ensureRead();
          if (!file || typeof file.text !== "function") throw new Error("Native API did not return a readable File");
          if (typeof file.size === "number" && file.size > 2_000_000) throw new Error("Native netlist exceeds 2 MB");
          const content: unknown = await file.text();
          ensureRead();
          if (typeof content !== "string") throw new Error("Netlist content is not text");
          parseNativeNetlist(content, candidate);
          text = content;
          format = candidate;
          break;
        } catch (error) {
          if (expired) throw error;
          lastError = error;
        }
      }
      if (text === undefined) throw lastError ?? new Error("No supported native netlist export");
      const afterScope = await readScope();
      if (JSON.stringify(beforeScope) !== JSON.stringify(afterScope))
        throw new Error("Active schematic/board scope changed during native netlist export; no mapping applied.");
      return {
        format,
        status: "available",
        text,
        ambiguousDesignators: nativeExportDuplicateDesignators(text, format),
        scope: {
          kind: "active_schematic",
          verified: !!beforeScope,
          ...beforeScope,
          requestedPins: allPages ? "all_current_schematic" : "current_page",
          evidence: beforeScope
            ? "Public native export is scoped to the active schematic; independent before/after legacy identity matched."
            : "Public native getNetlistFile implicitly exports the active schematic; runtime identity getters unavailable."
        }
      };
    })();
    const timeout = new Promise<NativeNetlistData>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve(
          resultWithRead(
            {
              format: attemptedFormat,
              status: "error",
              reason: `Native netlist read timed out after ${timeoutMs} ms; native connectivity is unavailable`
            },
            true
          )
        );
      }, timeoutMs);
    });
    const result = await Promise.race([read, timeout]);
    return result.read ? result : resultWithRead(result);
  } catch (error) {
    return resultWithRead({
      format: attemptedFormat,
      status: "error",
      reason: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
