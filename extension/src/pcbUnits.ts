import { apiError } from "./helpers.js";

// EasyEDA Pro PCB/footprint APIs use native mil, independent of the UI display unit.
export const PCB_MIL_TO_MM = 0.0254;
export type PcbUnits = "mil" | "mm";
export function pcbUnits(value: unknown = "mil"): PcbUnits {
  if (value !== "mil" && value !== "mm") throw apiError("invalid_params", "PCB units must be 'mil' or 'mm'.");
  return value;
}
export function pcbToNative(value: number, units: PcbUnits): number {
  return units === "mm" ? value / PCB_MIL_TO_MM : value;
}
