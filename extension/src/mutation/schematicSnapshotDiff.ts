import { canonicalJson } from "../../../src/mutation/contracts.js";
export type SheetMetadataDiff = {
  documentId: string;
  primitiveId: string;
  componentType: "sheet";
  property: string;
  before: string;
  after: string;
};
const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
/** Only existing current-page sheet derived update fields may change. No part/protected-board normalization. */
export function compareSchematicSnapshots(expected: any, observed: any, documentId: string) {
  const a = JSON.parse(canonicalJson(expected)),
    b = JSON.parse(canonicalJson(observed));
  const derivedMetadataDiffs: SheetMetadataDiff[] = [];
  const current =
    Array.isArray(a?.context?.active?.pages) &&
    Array.isArray(b?.context?.active?.pages) &&
    a.context.active.pages.some((p: any) => p.uuid === documentId) &&
    b.context.active.pages.some((p: any) => p.uuid === documentId);
  if (current && Array.isArray(a.components) && Array.isArray(b.components))
    for (const old of a.components) {
      if (old.ComponentType !== "sheet" || !old.PrimitiveId) continue;
      const fresh = b.components.find((c: any) => c.PrimitiveId === old.PrimitiveId && c.ComponentType === "sheet");
      if (!fresh || !old.OtherProperty || !fresh.OtherProperty) continue;
      for (const key of ["@Update Date", "@Update Time"]) {
        const x = old.OtherProperty[key],
          y = fresh.OtherProperty[key];
        const pattern = key === "@Update Date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{2}:\d{2}:\d{2}$/;
        if (typeof x === "string" && typeof y === "string" && pattern.test(x) && pattern.test(y) && x !== y) {
          derivedMetadataDiffs.push({
            documentId,
            primitiveId: old.PrimitiveId,
            componentType: "sheet",
            property: `OtherProperty.${key}`,
            before: x,
            after: y
          });
          fresh.OtherProperty[key] = x;
        }
      }
    }
  const differences: Array<{ path: string; before: unknown; after: unknown }> = [];
  const small = (v: any): unknown =>
    v === undefined
      ? "<missing>"
      : typeof v === "string" && v.length > 120
        ? `${v.slice(0, 120)}… [truncated]`
        : v && typeof v === "object"
          ? Array.isArray(v)
            ? { type: "array", length: v.length }
            : { type: "object", keys: Object.keys(v).slice(0, 8) }
          : v;
  const keyed = (v: any[]) => {
    if (v.length && v.every((x) => x && typeof x === "object" && typeof (x.PrimitiveId ?? x.uniqueId) === "string"))
      return Object.fromEntries(v.map((x) => [x.PrimitiveId ?? x.uniqueId, x]));
    return v;
  };
  const walk = (x: any, y: any, path: string) => {
    if (differences.length >= 8 || equal(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      x = keyed(x);
      y = keyed(y);
    }
    if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        if (differences.length >= 8) break;
        walk(x[k], y[k], path ? `${path}.${k}` : k);
      }
    } else differences.push({ path, before: small(x), after: small(y) });
  };
  walk(a, b, "");
  return { equal: equal(a, b), derivedMetadataDiffs, differences };
}
