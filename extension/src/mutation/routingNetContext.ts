import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import type { EasyEdaApi } from "../types.js";

export type RoutingNetContext = {
  schema: "native_routing_net_context_v1";
  scope: "net_membership_only";
  allNetNames: string[];
  counts: { components: number; pads: number; tracks: number; vias: number };
  fingerprint: string;
};
const unavailable = (message: string) => apiError("routing_context_unavailable", `${message} No routing dispatched.`);
const value = (item: any, key: string) => {
  const getter = item?.[`getState_${key}`];
  return typeof getter === "function" ? getter.call(item) : item?.[key[0].toLowerCase() + key.slice(1)];
};
const text = (raw: unknown, label: string, allowEmpty = false): string => {
  if (
    typeof raw !== "string" ||
    (!allowEmpty && !raw) ||
    raw !== raw.trim() ||
    raw.length > 512 ||
    Array.from(raw).some((char) => char.charCodeAt(0) < 32)
  )
    throw unavailable(`Native ${label} is missing or malformed.`);
  return raw;
};
function net(item: any): string {
  const observed = value(item, "Net");
  // The native getter uses undefined for an explicitly unassigned net.
  return text(observed === undefined && typeof item?.getState_Net === "function" ? "" : observed, "net", true);
}
function array(raw: unknown, label: string): any[] {
  if (!Array.isArray(raw)) throw unavailable(`Native ${label} did not return an array.`);
  return raw;
}
function unique<T extends [string, ...any[]]>(rows: T[], label: string): T[] {
  if (new Set(rows.map((r) => r[0])).size !== rows.length) throw unavailable(`Duplicate native ${label} IDs.`);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Exact canonical membership fingerprint, not a geometric snapshot or routing-completion proof. */
export async function collectRoutingNetContext(
  api: () => EasyEdaApi,
  expectedTarget?: Partial<DocumentIdentity>
): Promise<RoutingNetContext> {
  const eda = api(),
    deadline = Date.now() + 10000;
  const ensure = () => {
    if (Date.now() >= deadline) throw unavailable("Native net-context read exceeded its 10-second budget.");
  };
  const bounded = async <T>(call: () => T | Promise<T>): Promise<T> => {
    ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          ensure();
          return call();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable("Native net-context read timed out.")), deadline - Date.now());
        })
      ]);
      ensure();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  for (const [owner, methods] of [
    [eda.dmt_SelectControl, ["getCurrentDocumentInfo"]],
    [eda.pcb_Net, ["getAllNetsName"]],
    [eda.pcb_PrimitiveComponent, ["getAll", "getAllPinsByPrimitiveId"]],
    [eda.pcb_PrimitiveLine, ["getAll"]],
    [eda.pcb_PrimitiveVia, ["getAll"]]
  ] as const)
    if (!methods.every((method) => typeof owner?.[method] === "function"))
      throw unavailable("Complete public native net/component-pad/track/via APIs required.");
  const target = extractDocumentIdentity(await bounded(() => eda.dmt_SelectControl.getCurrentDocumentInfo()));
  if (target.documentType !== "pcb" || !target.projectId || !target.documentId)
    throw unavailable("Identifiable active PCB and project required.");
  if (expectedTarget) assertDocumentTargetMatch(expectedTarget, target);
  const [rawNames, rawComponents, rawTracks, rawVias] = await Promise.all([
    bounded(() => eda.pcb_Net.getAllNetsName()),
    bounded(() => eda.pcb_PrimitiveComponent.getAll()),
    bounded(() => eda.pcb_PrimitiveLine.getAll()),
    bounded(() => eda.pcb_PrimitiveVia.getAll())
  ]);
  const nativeNames = [
    ...new Set(
      array(rawNames, "net names")
        .map((n) => text(n, "net name", true))
        .filter(Boolean)
    )
  ].sort();
  const allNames = new Set(nativeNames),
    padIds = new Set<string>();
  const membership = (item: any): [string, string] => {
    const name = net(item);
    if (name) allNames.add(name);
    return [text(value(item, "PrimitiveId"), "primitive ID"), name];
  };
  const components: [string, [string, string][]][] = [];
  const parts = array(rawComponents, "components");
  for (let offset = 0; offset < parts.length; offset += 8) {
    ensure();
    const chunk = await Promise.all(
      parts.slice(offset, offset + 8).map(async (component) => {
        const id = text(value(component, "PrimitiveId"), "component ID");
        const pads = unique(
          array(await bounded(() => eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id)), "pads").map(membership),
          "pad"
        );
        for (const [padId] of pads) {
          if (padIds.has(padId)) throw unavailable("A native pad ID belongs to multiple components.");
          padIds.add(padId);
        }
        return [id, pads] as [string, [string, string][]];
      })
    );
    components.push(...chunk);
  }
  unique(components, "component");
  const tracks = unique(array(rawTracks, "tracks").map(membership), "track"),
    vias = unique(array(rawVias, "vias").map(membership), "via");
  assertDocumentTargetMatch(
    target,
    extractDocumentIdentity(await bounded(() => eda.dmt_SelectControl.getCurrentDocumentInfo()))
  );
  ensure();
  const allNetNames = [...allNames].sort();
  if (!allNetNames.length) throw unavailable("Cannot materialize a nonempty native routing context.");
  return {
    schema: "native_routing_net_context_v1",
    scope: "net_membership_only",
    allNetNames,
    counts: { components: components.length, pads: padIds.size, tracks: tracks.length, vias: vias.length },
    fingerprint: canonicalJson({
      target: { projectId: target.projectId, documentId: target.documentId, documentType: "pcb" },
      nativeNames,
      allNetNames,
      components,
      tracks,
      vias
    })
  };
}
