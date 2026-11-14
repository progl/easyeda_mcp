import { apiError, isRecord, toArray } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";

const fields = [
  "x",
  "y",
  "rotation",
  "color",
  "fontName",
  "fontSize",
  "bold",
  "italic",
  "underLine",
  "alignMode",
  "fillColor",
  "key",
  "value",
  "keyVisible",
  "valueVisible"
];
// SDK instances expose private storage in JSON; public accessors may convert units.
export async function readSchematicAttributes(api: () => EasyEdaApi, parentId?: string): Promise<any[]> {
  return toArray(await api().sch_PrimitiveAttribute.getAll(parentId))
    .filter(isRecord)
    .map((a) => {
      const out: Record<string, unknown> = {};
      for (const key of ["primitiveId", "parentPrimitiveId", ...fields]) {
        const getter = a[`getState_${key[0].toUpperCase() + key.slice(1)}`];
        const value = typeof getter === "function" ? getter.call(a) : a[key];
        if (value !== undefined) out[key] = value;
      }
      return out;
    });
}
export function annotationProperties(a: any, dx = 0, dy = 0, identity?: { designator: string; uniqueId: string }) {
  const p: any = Object.fromEntries(fields.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  if (typeof p.x === "number" && typeof p.y === "number") {
    p.x += dx;
    p.y += dy;
  }
  if (identity && p.key === "Designator") p.value = identity.designator;
  if (identity && p.key === "Unique ID") p.value = identity.uniqueId;
  return p;
}
function equal(a: any, b: any) {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-8 : a === b;
}
// EasyEDA 3.2.209 backend projector returns public y=-model.y, but Attribute.modify
// and instance setState_Y().done() forward property.y directly into model.y.
// This adapter compensates that installed getter/setter asymmetry exactly once.
export function schematicAttributeBackendPatch(publicPatch: Record<string, unknown>): Record<string, unknown> {
  return { ...publicPatch, ...(typeof publicPatch.y === "number" ? { y: -publicPatch.y } : {}) };
}
export async function restoreSchematicAttributes(
  api: () => EasyEdaApi,
  id: string,
  source: any[],
  dx: number,
  dy: number,
  identity?: { designator: string; uniqueId: string }
) {
  const attrs = await readSchematicAttributes(api, id);
  for (const old of source) {
    const matches = attrs.filter((a) => a.key === old.key);
    if (matches.length !== 1) throw apiError("annotation_mismatch", `Annotation key mismatch: ${old.key}`);
    const wanted = annotationProperties(old, dx, dy, identity);
    const patch = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => !equal(matches[0][key], value)));
    if (Object.keys(patch).length)
      await api().sch_PrimitiveAttribute.modify(matches[0].primitiveId, schematicAttributeBackendPatch(patch));
  }
  const updated = await readSchematicAttributes(api, id);
  for (const old of source) {
    const matches = updated.filter((a) => a.key === old.key);
    const wanted = annotationProperties(old, dx, dy, identity);
    const differences = Object.entries(wanted)
      .filter(([key, value]) => matches.length !== 1 || !equal(matches[0][key], value))
      .map(([key, expected]) => ({ key, expected, actual: matches[0]?.[key] }));
    if (differences.length)
      throw apiError("annotation_mismatch", `Annotation readback failed: ${old.key}; ${JSON.stringify(differences)}`);
  }
}
