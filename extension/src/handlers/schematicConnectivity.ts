import { activeSchematic, focusPage, readPage } from "../mutation/schematicPages.js";
import { collectNativeNetlist } from "./nativeNetlist.js";
import { applyNativeNetlist } from "../../../src/schematic/nativeNetlist.js";
import { toArray, isRecord, numeric, stringOrUndefined } from "../helpers.js";
import type { SchematicPin } from "../../../src/schematic/types.js";
import type { EasyEdaApi } from "../types.js";

export async function collectSchematicMembership(api: () => EasyEdaApi, params: Record<string, any>) {
  const ctx = await activeSchematic(api, params.target);
  const pins: Array<SchematicPin & { pageId: string }> = [];
  const counts = new Map<string, number>();
  const pages = [];
  const components: any[] = [];
  const pinsByComponent: Record<string, any[]> = {};
  try {
    for (const page of ctx.pages) {
      await focusPage(api, String(page.uuid), ctx.target.projectId!);
      const data = await readPage(api);
      const parts = data.components.filter((c) => c.componentType === "part");
      for (const c of parts) {
        const cid = `${page.uuid}:${c.primitiveId}`;
        components.push({ ...c, primitiveId: cid, pageId: page.uuid });
        pinsByComponent[cid] = [];
        counts.set(c.designator, (counts.get(c.designator) ?? 0) + 1);
        for (const p of toArray(await api().sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)).filter(
          isRecord
        )) {
          pinsByComponent[cid].push({
            ...p,
            primitiveId: `${page.uuid}:${p.primitiveId ?? c.primitiveId + "-" + p.pinNumber}`
          });
          pins.push({
            pageId: String(page.uuid),
            primitiveId: `${page.uuid}:${p.primitiveId ?? c.primitiveId + "-" + p.pinNumber}`,
            componentPrimitiveId: `${page.uuid}:${c.primitiveId}`,
            componentDesignator: c.designator,
            pinNumber: String(p.pinNumber),
            pinName: stringOrUndefined(p.pinName),
            position: { x: numeric(p.x), y: numeric(p.y) },
            netSource: "unknown"
          });
        }
      }
      pages.push({ pageId: page.uuid, name: page.name, components: parts.length });
    }
  } finally {
    await focusPage(api, ctx.target.documentId!, ctx.target.projectId!);
  }
  const native = await collectNativeNetlist(api(), true);
  native.ambiguousDesignators = [
    ...new Set([...(native.ambiguousDesignators ?? []), ...[...counts].filter(([, n]) => n > 1).map(([ref]) => ref)])
  ];
  return { ctx, pins, pages, components, pinsByComponent, native };
}
export async function auditSchematicConnectivity(api: () => EasyEdaApi, params: Record<string, any>) {
  const { ctx, pins, pages, native } = await collectSchematicMembership(api, params);
  const mapped = applyNativeNetlist(pins, native);
  const nets = new Map<string, Set<string>>();
  for (const p of mapped.pins as typeof pins) {
    if (p.netSource !== "native_netlist" || !p.net) continue;
    const set = nets.get(p.net) ?? new Set();
    set.add(p.pageId);
    nets.set(p.net, set);
  }
  const interpageNets = [...nets]
    .filter(([, pages]) => pages.size > 1)
    .map(([net, pages]) => ({ net, pages: [...pages] }));
  return {
    target: ctx.target,
    schematicId: ctx.schematicId,
    pages,
    pins: mapped.pins,
    nativeNetlist: mapped.report,
    nativeVerifiedPins: mapped.report.matchedPins,
    unknownPins: pins.length - mapped.report.matchedPins,
    interpageNets,
    warnings: mapped.warnings,
    focusRestored: true,
    note: "Only exact unique native membership is verified. Unmatched pins remain unknown; matching net names alone are not proof."
  };
}
