import { apiError, isRecord, numeric, toArray } from "../helpers.js";
import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";
import type { DocumentIdentity } from "../identity.js";
import { collectNativeNetlist } from "../handlers/nativeNetlist.js";
import { parseNativeNetlist } from "../../../src/schematic/nativeNetlist.js";

type Segment = { x1: number; y1: number; x2: number; y2: number };
type Pin = { pin: string; x: number; y: number; rotation: number };
type PlannedWire = { pin: string; net: string; coordinates: number[] };

function segments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) throw apiError("invalid_geometry", "Cannot inspect existing wire geometry.");
  const paths = raw.every(Array.isArray) ? (raw.every((p) => p.length === 2) ? [raw.flat()] : raw) : [raw];
  return paths.flatMap((path: unknown) => {
    if (
      !Array.isArray(path) ||
      path.length < 4 ||
      path.length % 2 ||
      !path.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw apiError("invalid_geometry", "Cannot inspect existing wire geometry.");
    }
    const out: Segment[] = [];
    for (let i = 0; i + 3 < path.length; i += 2) {
      const [x1, y1, x2, y2] = path.slice(i, i + 4);
      if (x1 !== x2 && y1 !== y2) throw apiError("invalid_geometry", "Only orthogonal wires are supported.");
      out.push({ x1, y1, x2, y2 });
    }
    return out;
  });
}
function touches(s: Segment, x: number, y: number): boolean {
  return (
    x >= Math.min(s.x1, s.x2) && x <= Math.max(s.x1, s.x2) && y >= Math.min(s.y1, s.y2) && y <= Math.max(s.y1, s.y2)
  );
}
function intersects(a: Segment, b: Segment): boolean {
  return (
    Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) <= Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) &&
    Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2)) <= Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2))
  );
}
async function plan(api: () => EasyEdaApi, component: string, requested: unknown, length: number) {
  const eda = api();
  if (!isRecord(requested) || !Object.keys(requested).length || Object.keys(requested).length > 100) {
    throw apiError("invalid_params", "pinNets must map 1 to 100 pin numbers to nonempty net names.");
  }
  if (!Number.isFinite(length) || length <= 0 || length > 100)
    throw apiError("invalid_params", "wireStubLength must be greater than zero and at most 100.");
  if (
    !eda.sch_PrimitiveComponent?.getAllPinsByPrimitiveId ||
    !eda.sch_PrimitiveWire?.getAll ||
    !eda.sch_PrimitiveWire?.create
  ) {
    throw apiError("capability_unavailable", "Pin inspection and native wire creation are required.");
  }
  const comps = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, false)).filter(isRecord);
  const comp = comps.find(
    (c) => String(c.primitiveId ?? c.id) === component || String(c.designator).toUpperCase() === component.toUpperCase()
  );
  if (!comp) throw apiError("component_not_found", `Component ${component} was not found on the active sheet.`);
  const primitiveId = String(comp.primitiveId ?? comp.id);
  const rawPins = toArray(await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)).filter(isRecord);
  const allPins: Pin[] = rawPins.map((p) => {
    const x = numeric(p.x),
      y = numeric(p.y),
      rotation = numeric(p.rotation) ?? 0;
    if (x === undefined || y === undefined || ![0, 90, 180, 270].includes(rotation))
      throw apiError("invalid_geometry", "Pin position or rotation is not supported.");
    return { pin: String(p.pinNumber), x, y, rotation };
  });
  const existing = toArray(await eda.sch_PrimitiveWire.getAll())
    .filter(isRecord)
    .flatMap((w) => segments(w.line ?? w.coordinates).map((s) => ({ ...s, net: String(w.net ?? "") })));
  const componentPins = [];
  for (const c of comps) {
    const id = String(c.primitiveId ?? c.id);
    const values =
      id === primitiveId
        ? rawPins
        : toArray(await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)).filter(isRecord);
    componentPins.push({ id, values });
  }
  const pins: Array<Pin & { net: string }> = [];
  const wires: PlannedWire[] = [];
  // MutationLifecycle canonicalizes object keys but preserves array order. Build
  // plan arrays in the same deterministic order before and after that roundtrip.
  const requestedPins = Object.entries(requested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [number, rawNet] of requestedPins) {
    if (typeof rawNet !== "string" || !rawNet.trim() || rawNet.length > 128 || /[\r\n]/.test(rawNet))
      throw apiError("invalid_params", `Invalid net for pin ${number}.`);
    const p = allPins.find((p) => p.pin === number);
    if (!p) throw apiError("pin_not_found", `Component ${component} has no pin ${number}.`);
    const net = rawNet.trim();
    pins.push({ ...p, net });
    const connected = existing.filter((s) => touches(s, p.x, p.y));
    if (connected.some((s) => s.net !== net))
      throw apiError(
        "connection_conflict",
        `Pin ${number} is already connected to another or unnamed net; repair it explicitly.`
      );
    if (connected.length) continue;
    const coordinates = [
      p.x,
      p.y,
      p.x + (p.rotation === 0 ? length : p.rotation === 180 ? -length : 0),
      p.y + (p.rotation === 90 ? length : p.rotation === 270 ? -length : 0)
    ];
    const seg = segments(coordinates)[0];
    if (
      existing.some((s) => s.net !== net && intersects(seg, s)) ||
      wires.some((w) => w.net !== net && intersects(seg, segments(w.coordinates)[0]))
    ) {
      throw apiError("wire_collision", `Wire for pin ${number} would intersect another net.`);
    }
    // A stub must not electrically join another physical pin, even before it is wired.
    for (const { id, values: otherPins } of componentPins) {
      if (
        otherPins.some(
          (p: any) => !(id === primitiveId && String(p.pinNumber) === number) && touches(seg, Number(p.x), Number(p.y))
        )
      ) {
        throw apiError("wire_collision", `Wire for pin ${number} would touch another component pin.`);
      }
    }
    wires.push({ pin: number, net, coordinates });
  }
  return { primitiveId, designator: String(comp.designator), pins, wires };
}
export async function preparePinNets(api: () => EasyEdaApi, params: Record<string, any>, target: DocumentIdentity) {
  if (Object.keys(params.properties).some((k) => !["pinNets", "wireStubLength"].includes(k)))
    throw apiError("invalid_params", "Do not mix pinNets with component property changes.");
  const component = String(params.component ?? "").trim();
  if (!component) throw apiError("invalid_params", "component is required for pinNets.");
  const length = params.properties.wireStubLength ?? 10;
  const planned = await plan(api, component, params.properties.pinNets, length);
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: "assignPinNets",
    target,
    operation: {
      action: "assignPinNets",
      component: planned.primitiveId,
      pinNets: params.properties.pinNets,
      wireStubLength: length,
      plan: planned
    },
    before: { component: planned.primitiveId, pins: planned.pins },
    requestedAfter: planned,
    changedKeys: ["pinNets"],
    scope: `component:${planned.designator}`,
    impact: `Connects ${planned.wires.length} pin(s) on ${planned.designator}; existing correct connections are unchanged.`
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
export async function executePinNets(record: MutationRecord, api: () => EasyEdaApi) {
  const op = record.operation as Record<string, any>;
  const current = await plan(api, op.component, op.pinNets, op.wireStubLength);
  if (canonicalJson(current) !== canonicalJson(op.plan))
    throw apiError("stale_mutation", "Component pins or connections changed after preview.");
  const created: string[] = [];
  for (const w of current.wires) {
    try {
      const item = await api().sch_PrimitiveWire.create(w.coordinates, w.net);
      const id = item?.getState_PrimitiveId?.() ?? item?.primitiveId ?? item?.id;
      if (!id) throw new Error("Wire creation returned no ID");
      created.push(String(id));
    } catch (error) {
      throw apiError(
        "write_readback_unknown",
        `Pin-net batch stopped at pin ${w.pin}; inspect created wires ${created.join(",")}. Do not replay. ${String(error)}`
      );
    }
  }
  let verificationSource = "wire_geometry";
  let nativeVerified = false;
  // Exporting the native netlist also flushes deferred net-name publication in v3.
  // The exporter has its own bounded timeout; writes are never retried here.
  if (created.length && api().sch_ManufactureData?.getNetlistFile) {
    const native = await collectNativeNetlist(api(), false);
    if (
      native.status === "available" &&
      native.text !== undefined &&
      !native.ambiguousDesignators?.includes(current.designator)
    ) {
      const nets = parseNativeNetlist(native.text, native.format);
      const nativeMatches = current.pins.map((pin) => {
        const member = `${current.designator}-${pin.pin}`;
        const names = [...nets].filter(([, members]) => members.includes(member)).map(([name]) => name);
        if (names.some((name) => name !== pin.net))
          throw apiError(
            "write_readback_unknown",
            `Native netlist conflicts with requested net for ${member}. Do not replay.`
          );
        return names.length === 1;
      });
      nativeVerified = nativeMatches.every(Boolean);
    }
  }
  if (nativeVerified) {
    verificationSource = "native_netlist";
  } else {
    const deadline = Date.now() + 1500;
    while (true) {
      try {
        const readback = await plan(api, op.component, op.pinNets, op.wireStubLength);
        if (!readback.wires.length) break;
      } catch (error) {
        // A deferred unnamed wire may briefly look like a conflicting connection.
        if ((error as { code?: string }).code !== "connection_conflict") throw error;
      }
      if (Date.now() >= deadline)
        throw apiError("write_readback_unknown", "Batch wire readback did not confirm all connections. Do not replay.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    executed: true,
    readback: {
      component: current.designator,
      connectedPins: current.pins,
      createdWireIds: created,
      verificationSource,
      verified: true
    }
  };
}
