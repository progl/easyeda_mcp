import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError } from "../helpers.js";
type Row = Record<string, any>;
export type PcbPreservationInventory = { groups: Record<string, Row[]>; componentPads: Row[] };
export const PCB_PRESERVATION_ENCODING = "pcb_preservation_dictionary_v1";
type Node = [0] | [1, null | string | boolean | number] | [2, number[]] | [3, number, number[]];
type Encoded = { encoding: typeof PCB_PRESERVATION_ENCODING; keySets: string[][]; values: Node[]; root: number };
const invalid = () =>
  apiError("unverified_inventory", "Invalid lossless native PCB preservation dictionary; no write.");
function inventory(value: any): asserts value is PcbPreservationInventory {
  if (
    !value ||
    !value.groups ||
    typeof value.groups !== "object" ||
    Array.isArray(value.groups) ||
    !Array.isArray(value.componentPads) ||
    Object.values(value.groups).some((rows) => !Array.isArray(rows)) ||
    Object.keys(value).some((k) => !["groups", "componentPads"].includes(k))
  )
    throw invalid();
}
/** Dedicated native PCB proof encoding. Every key/value and array order remains present,
 * including explicit undefined, null, finite geometry and the reviewed NaN tags. */
export function encodePcbPreservationInventory(source: PcbPreservationInventory): Encoded {
  inventory(source);
  const keySets: string[][] = [],
    values: Node[] = [],
    keysByText = new Map<string, number>(),
    byText = new Map<string, number>();
  const active = new Set<object>();
  function encode(v: any, depth = 0): number {
    if (depth > 35) throw invalid();
    let node: Node;
    if (v === undefined) node = [0];
    else if (v === null || ["string", "boolean", "number"].includes(typeof v)) {
      if (typeof v === "number" && !Number.isFinite(v)) throw invalid();
      node = [1, v];
    } else {
      if (
        typeof v !== "object" ||
        active.has(v) ||
        (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      )
        throw invalid();
      active.add(v);
      try {
        if (Array.isArray(v)) node = [2, Array.from(v, (x) => encode(x, depth + 1))];
        else {
          const keys = Object.keys(v).sort();
          if (keys.some((k) => ["__proto__", "constructor", "prototype"].includes(k))) throw invalid();
          const text = JSON.stringify(keys);
          let keyId = keysByText.get(text);
          if (keyId === undefined) {
            keyId = keySets.length;
            keysByText.set(text, keyId);
            keySets.push(keys);
          }
          node = [3, keyId, keys.map((k) => encode(v[k], depth + 1))];
        }
      } finally {
        active.delete(v);
      }
    }
    const text = JSON.stringify(node),
      existing = byText.get(text);
    if (existing !== undefined) return existing;
    const id = values.length;
    values.push(node);
    byText.set(text, id);
    return id;
  }
  const root = encode(source);
  return { encoding: PCB_PRESERVATION_ENCODING, keySets, values, root };
}
export function decodePcbPreservationInventory(source: any): PcbPreservationInventory {
  if (source?.encoding === undefined) {
    inventory(source);
    return source;
  } // Historical full receipts remain supported.
  if (
    source.encoding !== PCB_PRESERVATION_ENCODING ||
    !Array.isArray(source.keySets) ||
    !Array.isArray(source.values) ||
    Object.keys(source).some((k) => !["encoding", "keySets", "values", "root"].includes(k))
  )
    throw invalid();
  const decoded: any[] = [];
  for (let index = 0; index < source.values.length; index++) {
    const n = source.values[index];
    if (!Array.isArray(n)) throw invalid();
    const refs = (ids: any) => {
      if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id < 0 || id >= index)) throw invalid();
      return ids.map((id) => decoded[id]);
    };
    let value: any;
    if (n[0] === 0 && n.length === 1) value = undefined;
    else if (n[0] === 1 && n.length === 2 && (n[1] === null || ["string", "boolean", "number"].includes(typeof n[1]))) {
      if (typeof n[1] === "number" && !Number.isFinite(n[1])) throw invalid();
      value = n[1];
    } else if (n[0] === 2 && n.length === 2) value = refs(n[1]);
    else if (n[0] === 3 && n.length === 3) {
      const keys = source.keySets[n[1]],
        entries = refs(n[2]);
      if (
        !Number.isInteger(n[1]) ||
        !Array.isArray(keys) ||
        keys.length !== entries.length ||
        new Set(keys).size !== keys.length ||
        keys.some((k: any) => typeof k !== "string" || ["__proto__", "constructor", "prototype"].includes(k))
      )
        throw invalid();
      value = Object.fromEntries(keys.map((k: string, i: number) => [k, entries[i]]));
    } else throw invalid();
    decoded.push(value);
  }
  if (!Number.isInteger(source.root) || source.root < 0 || source.root >= decoded.length) throw invalid();
  const result = decoded[source.root];
  inventory(result);
  const detach = (v: any, depth = 0): any => {
    if (depth > 35) throw invalid();
    if (!v || typeof v !== "object") return v;
    return Array.isArray(v)
      ? v.map((x) => detach(x, depth + 1))
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, detach(x, depth + 1)]));
  };
  return detach(result);
}
export function samePcbPreservationInventory(a: PcbPreservationInventory, b: PcbPreservationInventory) {
  return canonicalJson(encodePcbPreservationInventory(a)) === canonicalJson(encodePcbPreservationInventory(b));
}
