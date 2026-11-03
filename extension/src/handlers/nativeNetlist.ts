import { parseNativeNetlist, type NativeNetlistData } from "../../../src/schematic/nativeNetlist.js";
import type { EasyEdaApi } from "../types.js";

export async function collectNativeNetlist(eda: EasyEdaApi, allPages: boolean): Promise<NativeNetlistData> {
  const base = { format: "Protel2" as const };
  if (!eda.sch_ManufactureData?.getNetlistFile)
    return { ...base, status: "unavailable", reason: "sch_ManufactureData.getNetlistFile is unavailable" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async (): Promise<NativeNetlistData> => {
      let text: string | undefined;
      let format: "Protel2" | "EasyEDA" = "Protel2";
      let lastError: unknown;
      for (const candidate of ["Protel2", "EasyEDA"] as const) {
        try {
          const file = await eda.sch_ManufactureData.getNetlistFile("mcp-native-connectivity", candidate);
          if (!file || typeof file.text !== "function") throw new Error("Native API did not return a readable File");
          if (typeof file.size === "number" && file.size > 2_000_000) throw new Error("Native netlist exceeds 2 MB");
          const content: unknown = await file.text();
          if (typeof content !== "string") throw new Error("Netlist content is not text");
          parseNativeNetlist(content, candidate);
          text = content;
          format = candidate;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (text === undefined) throw lastError ?? new Error("No supported native netlist export");
      // Establish uniqueness across the project before matching references from an export.
      const components = await eda.sch_PrimitiveComponent.getAll(undefined, true);
      if (!Array.isArray(components)) throw new Error("Cannot establish project designator uniqueness");
      const counts = new Map<string, number>();
      for (const c of components)
        if (c.componentType === "part" && typeof c.designator === "string")
          counts.set(c.designator, (counts.get(c.designator) ?? 0) + 1);
      return {
        format,
        status: "available",
        text,
        ambiguousDesignators: [...counts].filter(([, count]) => count > 1).map(([name]) => name)
      };
    })();
    const timeout = new Promise<NativeNetlistData>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ...base,
            status: "error",
            reason: "Native netlist read timed out after 3000 ms; geometric fallback used"
          }),
        3000
      );
    });
    return await Promise.race([read, timeout]);
  } catch (error) {
    return { ...base, status: "error", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
