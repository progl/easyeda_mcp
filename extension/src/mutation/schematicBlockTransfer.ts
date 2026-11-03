import { apiError, toArray, isRecord } from "../helpers.js";
import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { extensionMutations } from "./mutationManager.js";
import { activeSchematic, focusPage, plain, readPage } from "./schematicPages.js";
import type { EasyEdaApi } from "../types.js";

type Segment = { x1: number; y1: number; x2: number; y2: number };
function segments(line: any): Segment[] {
  const paths = Array.isArray(line) && Array.isArray(line[0]) ? line : [line];
  return paths.flatMap((path: any) => {
    if (!Array.isArray(path) || path.length < 4 || path.length % 2 || !path.every(Number.isFinite))
      throw apiError("unsupported_geometry", "Only finite orthogonal wire paths can be transferred.");
    const out = [];
    for (let i = 0; i < path.length - 2; i += 2) {
      const [x1, y1, x2, y2] = path.slice(i, i + 4);
      if (x1 !== x2 && y1 !== y2) throw apiError("unsupported_geometry", "Nonorthogonal wire.");
      out.push({ x1, y1, x2, y2 });
    }
    return out;
  });
}
function touch(s: Segment, p: any) {
  return (
    p.x >= Math.min(s.x1, s.x2) &&
    p.x <= Math.max(s.x1, s.x2) &&
    p.y >= Math.min(s.y1, s.y2) &&
    p.y <= Math.max(s.y1, s.y2)
  );
}
function intersect(a: Segment, b: Segment) {
  return (
    Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) <= Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) &&
    Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2)) <= Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2))
  );
}
function props(c: any) {
  const keys = [
    "designator",
    "name",
    "uniqueId",
    "manufacturer",
    "manufacturerId",
    "supplier",
    "supplierId",
    "subPartName",
    "otherProperty"
  ];
  return Object.fromEntries(keys.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
}
function identity(c: any) {
  return {
    ...props(c),
    component: c.component,
    footprint: c.footprint,
    symbol: c.symbol,
    x: c.x,
    y: c.y,
    rotation: c.rotation ?? 0,
    mirror: c.mirror ?? false,
    addIntoBom: c.addIntoBom ?? true,
    addIntoPcb: c.addIntoPcb ?? true
  };
}
function attributeProps(a: any, dx = 0, dy = 0) {
  const keys = [
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
  const p: any = Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  if (typeof p.x === "number" && typeof p.y === "number") {
    p.x += dx;
    p.y += dy;
  }
  return p;
}
async function resolveDevice(api: () => EasyEdaApi, c: any) {
  if (!/^[a-f0-9]{16}$/i.test(c.component.uuid)) return c.component;
  if (!c.supplierId || !c.manufacturerId || !api().lib_Device?.search)
    throw apiError(
      "capability_unavailable",
      "Project-local device IDs cannot be placed directly; exact global library resolution is required."
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const results = await Promise.race([
    Promise.resolve(api().lib_Device.search(c.supplierId)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(apiError("library_timeout", "Exact device lookup timed out before any write.")),
        3000
      );
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  const found = toArray(results)
    .filter(isRecord)
    .filter(
      (d) =>
        d.supplierId === c.supplierId &&
        d.manufacturerId === c.manufacturerId &&
        /^[a-f0-9]{32}$/i.test(String(d.uuid)) &&
        (!c.footprint?.name || d.footprintName === c.footprint.name)
    );
  if (found.length !== 1)
    throw apiError(
      "ambiguous_device",
      "Cannot resolve exactly one global device with matching supplier, manufacturer part and footprint before transfer."
    );
  return { libraryUuid: found[0].libraryUuid, uuid: found[0].uuid };
}
async function plan(api: () => EasyEdaApi, params: any) {
  const ctx = await activeSchematic(api, params.target);
  if (
    !Array.isArray(params.components) ||
    !params.components.length ||
    params.components.length > 100 ||
    new Set(params.components).size !== params.components.length
  )
    throw apiError("invalid_params", "Select 1 to 100 distinct component IDs/designators.");
  if (!ctx.pages.some((p) => p.uuid === params.destinationPageId) || params.destinationPageId === ctx.target.documentId)
    throw apiError("invalid_destination", "Destination page must be another page of this schematic.");
  const dx = params.dx ?? 0,
    dy = params.dy ?? 0;
  if (!Number.isFinite(dx) || !Number.isFinite(dy))
    throw apiError("invalid_params", "Offsets must be finite native schematic coordinates.");
  const source = await readPage(api);
  const comps = params.components.map((id: string) => {
    const found = source.components.filter((c) => c.primitiveId === id || c.designator === id);
    if (found.length !== 1) throw apiError("component_not_found", `Unique component ${id} required.`);
    return found[0];
  });
  for (const c of comps)
    if (c.componentType !== "part" || !c.uniqueId || !c.component?.uuid)
      throw apiError(
        "unsupported_component",
        "Only parts with stable uniqueId and device identity can be transferred."
      );
  const devices: Record<string, any> = {};
  for (const c of comps) devices[c.primitiveId] = await resolveDevice(api, c);
  const selected = new Set(comps.map((c: any) => c.primitiveId));
  const attributes: Record<string, any[]> = {};
  if (!api().sch_PrimitiveAttribute?.getAll)
    throw apiError("capability_unavailable", "Attribute inspection is required to preserve annotations.");
  for (const c of comps)
    attributes[c.primitiveId] = toArray(await api().sch_PrimitiveAttribute.getAll(c.primitiveId))
      .filter(isRecord)
      .map(plain);

  const pins: any[] = [];
  for (const c of source.components) {
    if (c.componentType === "sheet") continue;
    for (const p of toArray(await api().sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)).filter(isRecord))
      pins.push({ ...p, componentId: c.primitiveId });
  }
  const all = source.wires.map((w) => ({ w, segments: segments(w.line) }));
  const chosen = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < all.length; i++) {
      if (chosen.has(i)) continue;
      const s = all[i].segments;
      if (
        pins.some((p) => selected.has(p.componentId) && s.some((seg) => touch(seg, p))) ||
        [...chosen].some((j) => s.some((a) => all[j].segments.some((b) => intersect(a, b))))
      ) {
        chosen.add(i);
        changed = true;
      }
    }
  }
  const wires = [...chosen].map((i) => all[i].w);
  for (const i of chosen) {
    if (!String(all[i].w.net ?? "").trim())
      throw apiError("unnamed_boundary", "Unnamed nets cannot be preserved between pages; name them first.");
    if (pins.some((p) => !selected.has(p.componentId) && all[i].segments.some((seg) => touch(seg, p))))
      throw apiError(
        "block_boundary",
        "Selected wire is shared with a component outside the block; split/name boundary first."
      );
  }
  // Free texts, ports and buses are not silently dropped. Require separate handling.
  const minX = Math.min(...comps.map((c: any) => c.x)) - 100,
    maxX = Math.max(...comps.map((c: any) => c.x)) + 100,
    minY = Math.min(...comps.map((c: any) => c.y)) - 100,
    maxY = Math.max(...comps.map((c: any) => c.y)) + 100;
  const texts = api().sch_PrimitiveText?.getAll ? toArray(await api().sch_PrimitiveText.getAll()) : [];
  if (texts.some((t: any) => t.x >= minX && t.x <= maxX && t.y >= minY && t.y <= maxY))
    throw apiError(
      "unsupported_primitive",
      "Block contains free text; transfer free annotations separately before moving parts."
    );
  const freeAttrs = toArray(await api().sch_PrimitiveAttribute.getAll())
    .filter(isRecord)
    .filter((a) => !a.parentPrimitiveId || a.parentPrimitiveId === "");
  if (
    freeAttrs.some(
      (a) =>
        typeof a.x === "number" && typeof a.y === "number" && a.x >= minX && a.x <= maxX && a.y >= minY && a.y <= maxY
    )
  )
    throw apiError("unsupported_primitive", "Independent labels in the block must be handled explicitly.");
  const buses = api().sch_PrimitiveBus?.getAll ? toArray(await api().sch_PrimitiveBus.getAll()).filter(isRecord) : [];
  if (buses.length)
    throw apiError(
      "unsupported_primitive",
      "Bus-bearing pages require an explicit bus-aware transfer; no write performed."
    );
  let destination;
  let destinationPins: any[] = [];
  try {
    await focusPage(api, params.destinationPageId, ctx.target.projectId!);
    destination = await readPage(api);
    for (const c of destination.components) {
      if (c.componentType !== "sheet")
        destinationPins.push(
          ...toArray(await api().sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)).filter(isRecord)
        );
    }
  } finally {
    await focusPage(api, ctx.target.documentId!, ctx.target.projectId!);
  }
  for (const c of comps)
    if (destination.components.some((d) => d.designator === c.designator || d.uniqueId === c.uniqueId))
      throw apiError(
        "duplicate_identity",
        "Duplicate identity: destination already contains a designator or uniqueId from this block."
      );
  // Reject a physically overlapping destination before any write, irrespective of net name.
  const movedPoints = pins.filter((p) => selected.has(p.componentId)).map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const shiftedWires = wires.flatMap((w) =>
    segments(w.line).map((s) => ({ x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy }))
  );
  if (
    destinationPins.some(
      (p) => movedPoints.some((q) => p.x === q.x && p.y === q.y) || shiftedWires.some((s) => touch(s, p))
    )
  )
    throw apiError("destination_collision", "Block would intersect destination pins.");
  for (const w of destination.wires)
    if (segments(w.line).some((s) => movedPoints.some((p) => touch(s, p)) || shiftedWires.some((t) => intersect(s, t))))
      throw apiError("destination_collision", "Transferred block would intersect destination wires.");
  return {
    schematicId: ctx.schematicId,
    sourcePageId: ctx.target.documentId,
    destinationPageId: params.destinationPageId,
    dx,
    dy,
    components: comps,
    wires,
    attributes,
    devices,
    destination,
    source
  };
}
export async function prepareBlockTransfer(api: () => EasyEdaApi, params: Record<string, any>) {
  const ctx = await activeSchematic(api, params.target);
  const planned = await plan(api, params);
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: "transferBlock",
    target: ctx.target,
    operation: {
      action: "transferBlock",
      params: {
        components: params.components,
        destinationPageId: params.destinationPageId,
        dx: planned.dx,
        dy: planned.dy
      },
      plan: planned
    },
    before: {
      sourcePageId: planned.sourcePageId,
      destinationPageId: planned.destinationPageId,
      components: planned.components.map((c: any) => ({ designator: c.designator, uniqueId: c.uniqueId })),
      wireCount: planned.wires.length
    },
    requestedAfter: {
      pageId: planned.destinationPageId,
      components: planned.components.map((c: any) => ({ designator: c.designator, uniqueId: c.uniqueId })),
      wireCount: planned.wires.length
    },
    scope: `schematic:${planned.schematicId}`,
    impact:
      "Copy and verify all parts/wires before deleting source. Non-atomic; inspect the journal on failure. Free annotations/ports/buses are not supported.",
    ttlMs: 15 * 60_000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: record.action,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executeBlockTransfer(record: MutationRecord, api: () => EasyEdaApi) {
  const op = record.operation as any;
  const current = await plan(api, { ...op.params, target: record.target });
  if (canonicalJson(current) !== canonicalJson(op.plan))
    throw apiError("stale_mutation", "Source or destination changed after preview.");
  const ctx = await activeSchematic(api, record.target);
  const journal: any = {
    createdComponents: [],
    createdWires: [],
    deletedComponents: [],
    deletedWires: [],
    phase: "copy"
  };
  op.progress = journal;
  try {
    await focusPage(api, current.destinationPageId, ctx.target.projectId!);
    for (const c of current.components) {
      const created = await api().sch_PrimitiveComponent.create(
        current.devices[c.primitiveId],
        c.x + current.dx,
        c.y + current.dy,
        c.subPartName,
        c.rotation,
        c.mirror,
        c.addIntoBom,
        c.addIntoPcb
      );
      const id = created?.getState_PrimitiveId?.() ?? created?.primitiveId;
      if (!id) throw new Error(`No copy ID for ${c.designator}`);
      journal.createdComponents.push({ sourceId: c.primitiveId, destinationId: id, designator: c.designator });
      await api().sch_PrimitiveComponent.modify(id, props(c));
      const attrs = toArray(await api().sch_PrimitiveAttribute.getAll(id)).filter(isRecord);
      for (const old of current.attributes[c.primitiveId]) {
        const match = attrs.filter((a) => a.key === old.key);
        if (match.length !== 1) throw new Error(`Annotation key mismatch: ${old.key}`);
        await api().sch_PrimitiveAttribute.modify(match[0].primitiveId, attributeProps(old, current.dx, current.dy));
      }
      const updated = toArray(await api().sch_PrimitiveAttribute.getAll(id)).filter(isRecord);
      for (const old of current.attributes[c.primitiveId]) {
        const match = updated.filter((a) => a.key === old.key);
        if (
          match.length !== 1 ||
          canonicalJson(attributeProps(match[0])) !== canonicalJson(attributeProps(old, current.dx, current.dy))
        )
          throw new Error(`Annotation readback failed: ${old.key}`);
      }
    }
    for (const w of current.wires) {
      const line = Array.isArray(w.line[0])
        ? w.line.map((p: number[]) => p.map((n, i) => n + (i % 2 ? current.dy : current.dx)))
        : w.line.map((n: number, i: number) => n + (i % 2 ? current.dy : current.dx));
      const item = await api().sch_PrimitiveWire.create(line, w.net, w.color, w.lineWidth, w.lineType);
      const id = item?.getState_PrimitiveId?.() ?? item?.primitiveId;
      if (!id) throw new Error("Wire copy returned no ID");
      journal.createdWires.push(id);
    }
    const actual = await readPage(api);
    for (const c of current.components) {
      const copy = actual.components.find((d) => d.uniqueId === c.uniqueId);
      if (
        !copy ||
        canonicalJson(identity(copy)) !== canonicalJson({ ...identity(c), x: c.x + current.dx, y: c.y + current.dy })
      )
        throw new Error(`Identity/footprint/property readback failed: ${c.designator}`);
    }
    for (const w of current.wires) {
      const expected = segments(w.line).map((s) => ({
        x1: s.x1 + current.dx,
        y1: s.y1 + current.dy,
        x2: s.x2 + current.dx,
        y2: s.y2 + current.dy
      }));
      const found = actual.wires.filter((a) => a.net === w.net).flatMap((a) => segments(a.line));
      if (expected.some((s) => !found.some((a) => touch(a, { x: s.x1, y: s.y1 }) && touch(a, { x: s.x2, y: s.y2 }))))
        throw new Error("Wire copy readback failed");
    }
    journal.phase = "copy_verified";
    await focusPage(api, current.sourcePageId!, ctx.target.projectId!);
    const source = await readPage(api);
    if (canonicalJson(source) !== canonicalJson(current.source))
      throw new Error("Source changed during copy; preserved for inspection");
    journal.phase = "delete_source";
    for (const w of current.wires) {
      if ((await api().sch_PrimitiveWire.delete([w.primitiveId])) === false)
        throw new Error("Source wire deletion failed");
      journal.deletedWires.push(w.primitiveId);
    }
    for (const c of current.components) {
      if ((await api().sch_PrimitiveComponent.delete([c.primitiveId])) === false)
        throw new Error("Source component deletion failed");
      journal.deletedComponents.push(c.primitiveId);
    }
    const remaining = await readPage(api);
    if (
      remaining.components.some((c) => current.components.some((old: any) => old.primitiveId === c.primitiveId)) ||
      remaining.wires.some((w) => current.wires.some((old: any) => old.primitiveId === w.primitiveId))
    )
      throw new Error("Source removal readback failed");
    journal.phase = "verified";
    return {
      executed: true,
      readback: {
        verified: true,
        identityPreserved: true,
        connectivityEvidence: "named_wire_geometry",
        nativeConnectivityVerified: false,
        journal,
        saved: false
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Partial transfer; inspect both pages. Do not replay. Journal=${JSON.stringify(journal)}. ${String(error)}`
    );
  } finally {
    await focusPage(api, current.sourcePageId!, ctx.target.projectId!);
  }
}
