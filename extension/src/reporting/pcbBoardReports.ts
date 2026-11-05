import { apiError, numeric, optionalCall, stringOrUndefined, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { getBoardOutlineSummary } from "../mutation/pcbOutlineMutations.js";
import { fetchPcbCopperZones } from "../mutation/pcbCopperKeepoutMutations.js";
import { fetchPcbTracks, fetchPcbVias } from "../mutation/pcbTrackViaMutations.js";
import type { EasyEdaApi } from "../types.js";
import { PCB_MIL_TO_MM } from "../pcbUnits.js";
import { getComponentPads, normalizePcbPad } from "../pcbGeometry.js";

function getProp(obj: any, getterNames: string | string[], propNames: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  const getters = Array.isArray(getterNames) ? getterNames : [getterNames];
  for (const getter of getters) {
    if (typeof obj[getter] === "function") {
      try {
        const val = obj[getter]();
        if (val !== undefined && val !== null) return val;
      } catch {
        // ignore
      }
    }
  }
  for (const prop of propNames) {
    if (obj[prop] !== undefined && obj[prop] !== null) {
      return obj[prop];
    }
  }
  return undefined;
}

export interface AirwireEndpoint {
  componentDesignator?: string;
  padNumber?: string;
  primitiveId?: string;
  x: number;
  y: number;
  layer?: string | number;
}

export interface Airwire {
  id: string;
  net: string;
  from: AirwireEndpoint;
  to: AirwireEndpoint;
  length: number;
  manhattanLength: number;
}

export interface AirwireReport {
  target: Record<string, unknown>;
  method: "native_ratsnest" | "inferred_topology";
  tolerances: {
    padSnapTolerance: number;
    unit: string;
  };
  inferenceLimits: string;
  totalAirwires: number;
  totalAirwireLengthMm: number;
  unroutedNetsCount: number;
  airwiresByNet: Record<string, number>;
  longestAirwire?: {
    net: string;
    length: number;
    from: AirwireEndpoint;
    to: AirwireEndpoint;
  };
  airwires: Airwire[];
}

export interface ComponentBoundingBox {
  primitiveId: string;
  designator: string;
  footprint?: string;
  layer: string | number;
  side: "top" | "bottom" | "unknown";
  x: number;
  y: number;
  rotation: number;
  units: "mm";
  geometrySource: "component_dimensions" | "pad_envelope" | "unavailable";
  width?: number;
  height?: number;
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  isPlaced: boolean;
  padCount: number;
}

export interface PlacementCollision {
  componentA: string;
  componentB: string;
  layer: string | number;
  side: "top" | "bottom" | "unknown";
  clearanceMm: number;
  isOverlap: boolean;
}

export interface PlacementReport {
  target: Record<string, unknown>;
  method: "geometry_bounding_box";
  tolerances: {
    collisionTolerance: number;
    boardMarginTolerance: number;
    unit: string;
  };
  inferenceLimits: string;
  totalComponents: number;
  placedComponentsCount: number;
  unplacedComponentsCount: number;
  layerDistribution: {
    top: number;
    bottom: number;
    unknown: number;
  };
  boardAreaMm2?: number;
  totalComponentAreaMm2?: number;
  units: "mm";
  nativeUnits: "mil";
  geometryVerified: false;
  collisionCheckComplete: boolean;
  unknownGeometryComponents: Array<{ primitiveId: string; designator: string; reason: string }>;
  warnings: string[];
  densityPercent?: number;
  collisionWarningsCount: number;
  collisions: PlacementCollision[];
  unplacedComponents: Array<{ primitiveId: string; designator: string; reason: string }>;
  components: ComponentBoundingBox[];
}

export interface NetSummaryItem {
  net: string;
  category: "power" | "ground" | "signal";
  padCount: number;
  trackSegmentCount: number;
  trackLengthMm: number;
  viaCount: number;
  copperZoneCount: number;
  airwireCount: number;
  routingStatus: "routed" | "partially_routed" | "unrouted";
  completionPercent: number;
}

export interface NetReport {
  target: Record<string, unknown>;
  method: "physical_extraction";
  tolerances: {
    padSnapTolerance: number;
    unit: string;
  };
  inferenceLimits: string;
  totalNets: number;
  routedNetsCount: number;
  partiallyRoutedNetsCount: number;
  unroutedNetsCount: number;
  overallRoutingCompletionPercent: number;
  totalTrackLengthMm: number;
  totalViasCount: number;
  totalCopperZonesCount: number;
  categoryCounts: {
    power: number;
    ground: number;
    signal: number;
  };
  nets: NetSummaryItem[];
}

function categorizeNet(netName: string): "power" | "ground" | "signal" {
  const name = netName.toLowerCase();
  if (/(^|_|\b)(gnd|agnd|dgnd|pgnd|vss|ground)($|_|\b)/i.test(name)) {
    return "ground";
  }
  if (/(^|_|\b)(vcc|vdd|vbat|vin|vbus|pwr|power|\+?\d+v\d*|\+?\d+v)($|_|\b)/i.test(name)) {
    return "power";
  }
  return "signal";
}

function distance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function manhattanDist(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
}

/**
 * Computes a Minimum Spanning Tree (MST) on a set of pad coordinates using Kruskal's algorithm.
 */
function computeMST(
  pads: AirwireEndpoint[]
): Array<{ from: AirwireEndpoint; to: AirwireEndpoint; length: number; manhattan: number }> {
  if (pads.length < 2) return [];

  // Generate all candidate edges between pads
  const edges: Array<{
    u: number;
    v: number;
    dist: number;
    manhattan: number;
  }> = [];

  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const d = distance(pads[i], pads[j]);
      const m = manhattanDist(pads[i], pads[j]);
      edges.push({ u: i, v: j, dist: d, manhattan: m });
    }
  }

  // Sort edges ascending by euclidean distance
  edges.sort((a, b) => a.dist - b.dist);

  // Disjoint-set union (DSU)
  const parent: number[] = pads.map((_, idx) => idx);
  function find(x: number): number {
    if (parent[x] === x) return x;
    parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x: number, y: number): boolean {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return false;
    parent[rx] = ry;
    return true;
  }

  const mstEdges: Array<{ from: AirwireEndpoint; to: AirwireEndpoint; length: number; manhattan: number }> = [];
  for (const edge of edges) {
    if (union(edge.u, edge.v)) {
      mstEdges.push({
        from: pads[edge.u],
        to: pads[edge.v],
        length: Number(edge.dist.toFixed(4)),
        manhattan: Number(edge.manhattan.toFixed(4))
      });
      if (mstEdges.length === pads.length - 1) break;
    }
  }

  return mstEdges;
}

export async function generatePcbAirwiresReport(
  api: () => EasyEdaApi,
  params: Record<string, any> = {}
): Promise<AirwireReport> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  const expectedTarget = params.expectedTarget ?? params.target;
  if (expectedTarget) {
    assertDocumentTargetMatch(expectedTarget, currentTarget);
  }
  if (currentTarget.documentType && currentTarget.documentType !== "pcb" && currentTarget.documentType !== "unknown") {
    throw apiError("wrong_document", "Generating PCB airwires report requires an active PCB document.");
  }

  const netFilter = params.net ? String(params.net).trim().toLowerCase() : undefined;
  const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 200)));
  const padSnapTolerance = numeric(params.padSnapTolerance) ?? 0.1;

  let airwires: Airwire[] = [];
  let method: "native_ratsnest" | "inferred_topology" = "inferred_topology";

  // Check if native ratsnest primitive exists
  const ratsnestApi = (eda as any).pcb_PrimitiveRatsnest ?? (eda as any).pcb_PrimitiveAirwire;
  if (ratsnestApi && typeof ratsnestApi.getAll === "function") {
    try {
      const rawRatsnest = toArray(await ratsnestApi.getAll());
      if (rawRatsnest.length > 0) {
        method = "native_ratsnest";
        for (let i = 0; i < rawRatsnest.length; i++) {
          const item = rawRatsnest[i];
          const net = String(getProp(item, ["getState_Net", "getState_NetName"], ["net", "netName"]) ?? "");
          if (netFilter && net.toLowerCase() !== netFilter) continue;

          const startX = numeric(getProp(item, ["getState_StartX", "getState_X1"], ["startX", "x1", "x"])) ?? 0;
          const startY = numeric(getProp(item, ["getState_StartY", "getState_Y1"], ["startY", "y1", "y"])) ?? 0;
          const endX = numeric(getProp(item, ["getState_EndX", "getState_X2"], ["endX", "x2"])) ?? 0;
          const endY = numeric(getProp(item, ["getState_EndY", "getState_Y2"], ["endY", "y2"])) ?? 0;
          const id = String(getProp(item, "getState_PrimitiveId", ["primitiveId", "id"]) ?? `airwire-${i + 1}`);

          const d = distance({ x: startX, y: startY }, { x: endX, y: endY });
          const m = manhattanDist({ x: startX, y: startY }, { x: endX, y: endY });

          airwires.push({
            id,
            net,
            from: { x: startX, y: startY },
            to: { x: endX, y: endY },
            length: Number(d.toFixed(4)),
            manhattanLength: Number(m.toFixed(4))
          });
        }
      }
    } catch {
      // Fallback to inferred topology
    }
  }

  // Fallback: Inferred topology via unrouted pads
  if (airwires.length === 0) {
    method = "inferred_topology";

    // Gather pads from all components and standalone pads
    const padsByNet = new Map<string, AirwireEndpoint[]>();

    if (eda.pcb_PrimitiveComponent?.getAll) {
      const rawComponents = toArray(await eda.pcb_PrimitiveComponent.getAll());
      for (const comp of rawComponents) {
        const designator = String(getProp(comp, "getState_Designator", ["designator", "name"]) ?? "");
        const pins = toArray(
          typeof (comp as any).getState_Pins === "function"
            ? (comp as any).getState_Pins()
            : ((comp as any).pins ?? (comp as any).pads ?? [])
        );

        for (const pin of pins) {
          const net = String(getProp(pin, ["getState_Net", "getState_NetName"], ["net", "netName"]) ?? "");
          if (!net || (netFilter && net.toLowerCase() !== netFilter)) continue;

          const px = numeric(getProp(pin, "getState_X", ["x", "centerX"]));
          const py = numeric(getProp(pin, "getState_Y", ["y", "centerY"]));
          const padNum = String(getProp(pin, "getState_PadNumber", ["padNumber", "number", "name"]) ?? "");
          const pId = String(getProp(pin, "getState_PrimitiveId", ["primitiveId", "id"]) ?? "");

          if (px !== undefined && py !== undefined) {
            const list = padsByNet.get(net) ?? [];
            list.push({
              componentDesignator: designator,
              padNumber: padNum,
              primitiveId: pId,
              x: px,
              y: py
            });
            padsByNet.set(net, list);
          }
        }
      }
    }

    // Also collect standalone pads
    if (eda.pcb_PrimitivePad?.getAll) {
      const rawStandalone = toArray(await eda.pcb_PrimitivePad.getAll());
      for (const pad of rawStandalone) {
        const net = String(getProp(pad, ["getState_Net", "getState_NetName"], ["net", "netName"]) ?? "");
        if (!net || (netFilter && net.toLowerCase() !== netFilter)) continue;

        const px = numeric(getProp(pad, "getState_X", ["x", "centerX"]));
        const py = numeric(getProp(pad, "getState_Y", ["y", "centerY"]));
        const padNum = String(getProp(pad, "getState_PadNumber", ["padNumber", "number"]) ?? "");
        const pId = String(getProp(pad, "getState_PrimitiveId", ["primitiveId", "id"]) ?? "");

        if (px !== undefined && py !== undefined) {
          const list = padsByNet.get(net) ?? [];
          list.push({
            padNumber: padNum,
            primitiveId: pId,
            x: px,
            y: py
          });
          padsByNet.set(net, list);
        }
      }
    }

    // For each net with >= 2 pads, compute unrouted airwires
    // Check tracks to see if pads are already connected
    const { tracks } = await fetchPcbTracks(eda, { limit: 500 });
    const tracksByNet = new Map<string, number>();
    for (const trk of tracks) {
      if (trk.net) {
        tracksByNet.set(trk.net, (tracksByNet.get(trk.net) ?? 0) + 1);
      }
    }

    let airwireIdx = 1;
    for (const [netName, pads] of padsByNet.entries()) {
      if (pads.length < 2) continue;

      // If tracks exist on this net and routing status reports it routed, skip
      const trackCount = tracksByNet.get(netName) ?? 0;
      if (trackCount >= pads.length - 1) {
        // Net has enough track segments to potentially connect all pads; skip pure airwire generation
        continue;
      }

      const mstEdges = computeMST(pads);
      for (const edge of mstEdges) {
        airwires.push({
          id: `airwire-mst-${airwireIdx++}`,
          net: netName,
          from: edge.from,
          to: edge.to,
          length: edge.length,
          manhattanLength: edge.manhattan
        });
      }
    }
  }

  // Sort airwires by length descending (longest / hardest routes first)
  airwires.sort((a, b) => b.length - a.length);

  const totalAirwireLengthMm = Number(airwires.reduce((sum, item) => sum + item.length, 0).toFixed(3));

  const airwiresByNet: Record<string, number> = {};
  for (const item of airwires) {
    airwiresByNet[item.net] = (airwiresByNet[item.net] ?? 0) + 1;
  }

  const unroutedNetsCount = Object.keys(airwiresByNet).length;
  const longestAirwire = airwires.length > 0 ? airwires[0] : undefined;

  const limitedAirwires = airwires.slice(0, limit);

  return {
    target: currentTarget,
    method,
    tolerances: {
      padSnapTolerance,
      unit: "mm"
    },
    inferenceLimits:
      method === "inferred_topology"
        ? "Inferred airwires use Minimum Spanning Tree (MST) based on pad center Euclidean distances. Dynamic interactive flight lines in EasyEDA Pro may reorder pins dynamically."
        : "Extracted directly from native EasyEDA Pro ratsnest line primitives.",
    totalAirwires: airwires.length,
    totalAirwireLengthMm,
    unroutedNetsCount,
    airwiresByNet,
    ...(longestAirwire
      ? {
          longestAirwire: {
            net: longestAirwire.net,
            length: longestAirwire.length,
            from: longestAirwire.from,
            to: longestAirwire.to
          }
        }
      : {}),
    airwires: limitedAirwires
  };
}

export async function generatePcbPlacementReport(
  api: () => EasyEdaApi,
  params: Record<string, any> = {}
): Promise<PlacementReport> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  const expectedTarget = params.expectedTarget ?? params.target;
  if (expectedTarget) {
    assertDocumentTargetMatch(expectedTarget, currentTarget);
  }
  if (currentTarget.documentType && currentTarget.documentType !== "pcb" && currentTarget.documentType !== "unknown") {
    throw apiError("wrong_document", "Generating PCB placement report requires an active PCB document.");
  }

  const collisionTolerance = numeric(params.collisionTolerance) ?? 0.2;
  const boardMarginTolerance = numeric(params.boardMarginTolerance) ?? 1.0;
  const outlineSummary = await getBoardOutlineSummary(api);
  const boardAreaMm2 =
    outlineSummary.exists && outlineSummary.isClosed ? outlineSummary.estimatedArea * PCB_MIL_TO_MM ** 2 : undefined;
  const boardBounds = outlineSummary.exists
    ? {
        minX: outlineSummary.bounds.minX * PCB_MIL_TO_MM,
        maxX: outlineSummary.bounds.maxX * PCB_MIL_TO_MM,
        minY: outlineSummary.bounds.minY * PCB_MIL_TO_MM,
        maxY: outlineSummary.bounds.maxY * PCB_MIL_TO_MM
      }
    : undefined;
  const rawComponents = eda.pcb_PrimitiveComponent?.getAll ? toArray(await eda.pcb_PrimitiveComponent.getAll()) : [];
  const components: ComponentBoundingBox[] = [];
  const unplacedComponents: Array<{ primitiveId: string; designator: string; reason: string }> = [];
  const unknownGeometryComponents: Array<{ primitiveId: string; designator: string; reason: string }> = [];
  for (const item of rawComponents) {
    const comp = item as Record<string, any>;
    const primitiveId = String(getProp(comp, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "");
    const designator = String(getProp(comp, "getState_Designator", ["designator", "name"]) ?? "");
    const footprint = stringOrUndefined(getProp(comp, "getState_Footprint", ["footprint", "package"]));
    const layerId = getProp(comp, "getState_Layer", ["layer", "layerId"]) ?? 1;
    const layerStr = String(layerId).toLowerCase();
    const side =
      layerStr.includes("top") || layerId === 1
        ? "top"
        : layerStr.includes("bot") || layerId === 2
          ? "bottom"
          : "unknown";
    const rawX = numeric(getProp(comp, "getState_X", ["x", "centerX"]));
    const rawY = numeric(getProp(comp, "getState_Y", ["y", "centerY"]));
    if (rawX === undefined || rawY === undefined) {
      unplacedComponents.push({ primitiveId, designator, reason: "Missing native placement coordinates." });
      continue;
    }
    const x = rawX * PCB_MIL_TO_MM,
      y = rawY * PCB_MIL_TO_MM;
    if (
      boardBounds &&
      (x < boardBounds.minX - boardMarginTolerance ||
        x > boardBounds.maxX + boardMarginTolerance ||
        y < boardBounds.minY - boardMarginTolerance ||
        y > boardBounds.maxY + boardMarginTolerance)
    ) {
      unplacedComponents.push({
        primitiveId,
        designator,
        reason: `Position (${x}, ${y}) mm is outside board outline boundary.`
      });
      continue;
    }
    const rotation = numeric(getProp(comp, "getState_Rotation", ["rotation", "angle"])) ?? 0;
    const pins = await getComponentPads(comp, api);
    const padBounds = pins.map((pin) => {
      const pad = normalizePcbPad(pin);
      const px = numeric(pad.x),
        py = numeric(pad.y),
        w = numeric(pad.width),
        h = numeric(pad.height);
      if (px === undefined || py === undefined || !w || !h || w <= 0 || h <= 0) return undefined;
      const angle = (Number(pad.rotation) * Math.PI) / 180;
      const hx = (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) / 2;
      const hy = (Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * h) / 2;
      return {
        minX: (px - hx) * PCB_MIL_TO_MM,
        maxX: (px + hx) * PCB_MIL_TO_MM,
        minY: (py - hy) * PCB_MIL_TO_MM,
        maxY: (py + hy) * PCB_MIL_TO_MM
      };
    });
    let bounds: ComponentBoundingBox["bounds"];
    let geometrySource: ComponentBoundingBox["geometrySource"] = "unavailable";
    if (padBounds.length && padBounds.every((pad) => pad !== undefined)) {
      const values = padBounds as NonNullable<(typeof padBounds)[number]>[];
      bounds = {
        minX: Math.min(...values.map((v) => v.minX)),
        maxX: Math.max(...values.map((v) => v.maxX)),
        minY: Math.min(...values.map((v) => v.minY)),
        maxY: Math.max(...values.map((v) => v.maxY))
      };
      geometrySource = "pad_envelope";
    } else {
      const w = numeric(getProp(comp, "getState_Width", ["width"]));
      const h = numeric(getProp(comp, "getState_Height", ["height"]));
      if (w && h && w > 0 && h > 0) {
        const angle = (rotation * Math.PI) / 180;
        const hx = ((Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) * PCB_MIL_TO_MM) / 2;
        const hy = ((Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * h) * PCB_MIL_TO_MM) / 2;
        bounds = { minX: x - hx, maxX: x + hx, minY: y - hy, maxY: y + hy };
        geometrySource = "component_dimensions";
      }
    }
    if (!bounds)
      unknownGeometryComponents.push({
        primitiveId,
        designator,
        reason:
          "No complete component dimensions or native pad shapes; geometry is unavailable, no default size substituted."
      });
    components.push({
      primitiveId,
      designator,
      footprint,
      layer: layerId,
      side,
      x,
      y,
      rotation,
      units: "mm",
      geometrySource,
      ...(bounds
        ? {
            width: Number((bounds.maxX - bounds.minX).toFixed(4)),
            height: Number((bounds.maxY - bounds.minY).toFixed(4)),
            bounds
          }
        : {}),
      isPlaced: true,
      padCount: pins.length
    });
  }

  // Detect pairwise collisions / tight clearances on same side
  const collisions: PlacementCollision[] = [];
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const c1 = components[i];
      const c2 = components[j];

      // Missing geometry cannot certify clearances. Compare only known boxes on known sides.
      if (!c1.bounds || !c2.bounds || c1.side === "unknown" || c1.side !== c2.side) continue;

      // Expand c1 bounds by collisionTolerance
      const overlapX = Math.max(0, Math.min(c1.bounds.maxX, c2.bounds.maxX) - Math.max(c1.bounds.minX, c2.bounds.minX));
      const overlapY = Math.max(0, Math.min(c1.bounds.maxY, c2.bounds.maxY) - Math.max(c1.bounds.minY, c2.bounds.minY));

      const isOverlap = overlapX > 0 && overlapY > 0;
      if (isOverlap) {
        const overlapDistance = Math.min(overlapX, overlapY);
        collisions.push({
          componentA: c1.designator,
          componentB: c2.designator,
          layer: c1.layer,
          side: c1.side,
          clearanceMm: -Number(overlapDistance.toFixed(4)),
          isOverlap: true
        });
      } else {
        // Clearance distance between bounding boxes
        const dx = Math.max(0, Math.max(c1.bounds.minX, c2.bounds.minX) - Math.min(c1.bounds.maxX, c2.bounds.maxX));
        const dy = Math.max(0, Math.max(c1.bounds.minY, c2.bounds.minY) - Math.min(c1.bounds.maxY, c2.bounds.maxY));
        const clearance = Math.sqrt(dx * dx + dy * dy);

        if (clearance < collisionTolerance) {
          collisions.push({
            componentA: c1.designator,
            componentB: c2.designator,
            layer: c1.layer,
            side: c1.side,
            clearanceMm: Number(clearance.toFixed(4)),
            isOverlap: false
          });
        }
      }
    }
  }

  // Calculate layer distribution
  const layerDistribution = {
    top: components.filter((c) => c.side === "top").length,
    bottom: components.filter((c) => c.side === "bottom").length,
    unknown: components.filter((c) => c.side === "unknown").length
  };

  const totalComponentAreaMm2 = unknownGeometryComponents.length
    ? undefined
    : Number(components.reduce((sum, c) => sum + (c.width ?? 0) * (c.height ?? 0), 0).toFixed(2));

  const densityPercent =
    boardAreaMm2 && boardAreaMm2 > 0 && totalComponentAreaMm2 !== undefined
      ? Number(((totalComponentAreaMm2 / boardAreaMm2) * 100).toFixed(1))
      : undefined;

  return {
    target: currentTarget,
    method: "geometry_bounding_box",
    units: "mm",
    nativeUnits: "mil",
    geometryVerified: false,
    collisionCheckComplete:
      unknownGeometryComponents.length === 0 &&
      unplacedComponents.length === 0 &&
      components.every((c) => c.side !== "unknown"),
    unknownGeometryComponents,
    warnings: [
      ...(!boardBounds
        ? ["No board outline: component positions are present but board containment is unverified."]
        : []),
      ...(unknownGeometryComponents.length
        ? ["Missing geometry: zero reported collisions does not mean the placement is clear."]
        : [])
    ],
    tolerances: {
      collisionTolerance,
      boardMarginTolerance,
      unit: "mm"
    },
    inferenceLimits:
      "All reported lengths are mm converted from native mil. Rectangular component dimensions or pad envelopes are estimates, not verified body/courtyard clearances. Missing dimensions remain unavailable; no 2x2 fallback is used. A pad envelope may exclude connector overhangs and the ESP32 antenna keepout. Density uses outline bounding area.",
    totalComponents: rawComponents.length,
    placedComponentsCount: components.length,
    unplacedComponentsCount: unplacedComponents.length,
    layerDistribution,
    ...(boardAreaMm2 !== undefined ? { boardAreaMm2 } : {}),
    totalComponentAreaMm2,
    ...(densityPercent !== undefined ? { densityPercent } : {}),
    collisionWarningsCount: collisions.length,
    collisions,
    unplacedComponents,
    components
  };
}

export async function generatePcbNetReport(
  api: () => EasyEdaApi,
  params: Record<string, any> = {}
): Promise<NetReport> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  const expectedTarget = params.expectedTarget ?? params.target;
  if (expectedTarget) {
    assertDocumentTargetMatch(expectedTarget, currentTarget);
  }
  if (currentTarget.documentType && currentTarget.documentType !== "pcb" && currentTarget.documentType !== "unknown") {
    throw apiError("wrong_document", "Generating PCB net report requires an active PCB document.");
  }

  const netFilter = params.net ? String(params.net).trim().toLowerCase() : undefined;
  const categoryFilter = params.category ? String(params.category).trim().toLowerCase() : undefined;
  const statusFilter = params.status ? String(params.status).trim().toLowerCase() : undefined;
  const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 200)));

  // 1. Gather all net names
  let netNames: string[] = [];
  if (eda.pcb_Net?.getAllNetsName) {
    netNames = toArray(await eda.pcb_Net.getAllNetsName()).map(String);
  } else if (eda.pcb_Net?.getAllNetName) {
    netNames = toArray(await eda.pcb_Net.getAllNetName()).map(String);
  }

  // 2. Fetch tracks, vias, and copper zones
  const { tracks } = await fetchPcbTracks(eda, { limit: 500 });
  const { vias } = await fetchPcbVias(eda, { limit: 500 });
  const { zones } = await fetchPcbCopperZones(eda, { limit: 100 });

  // Map tracks by net
  const tracksByNet = new Map<string, { count: number; length: number }>();
  for (const trk of tracks) {
    if (!trk.net) continue;
    const cur = tracksByNet.get(trk.net) ?? { count: 0, length: 0 };
    tracksByNet.set(trk.net, {
      count: cur.count + 1,
      length: cur.length + (trk.length ?? 0)
    });
  }

  // Map vias by net
  const viasByNet = new Map<string, number>();
  for (const via of vias) {
    if (!via.net) continue;
    viasByNet.set(via.net, (viasByNet.get(via.net) ?? 0) + 1);
  }

  // Map copper zones by net
  const zonesByNet = new Map<string, number>();
  for (const zone of zones) {
    if (!zone.net) continue;
    zonesByNet.set(zone.net, (zonesByNet.get(zone.net) ?? 0) + 1);
  }

  // Map pads by net
  const padsByNet = new Map<string, number>();
  if (eda.pcb_PrimitiveComponent?.getAll) {
    const rawComps = toArray(await eda.pcb_PrimitiveComponent.getAll());
    for (const comp of rawComps) {
      const pins = toArray(
        typeof (comp as any).getState_Pins === "function"
          ? (comp as any).getState_Pins()
          : ((comp as any).pins ?? (comp as any).pads ?? [])
      );
      for (const pin of pins) {
        const net = String(getProp(pin, ["getState_Net", "getState_NetName"], ["net", "netName"]) ?? "");
        if (net) {
          padsByNet.set(net, (padsByNet.get(net) ?? 0) + 1);
          if (!netNames.includes(net)) {
            netNames.push(net);
          }
        }
      }
    }
  }

  if (eda.pcb_PrimitivePad?.getAll) {
    const rawStandalone = toArray(await eda.pcb_PrimitivePad.getAll());
    for (const pad of rawStandalone) {
      const net = String(getProp(pad, ["getState_Net", "getState_NetName"], ["net", "netName"]) ?? "");
      if (net) {
        padsByNet.set(net, (padsByNet.get(net) ?? 0) + 1);
        if (!netNames.includes(net)) {
          netNames.push(net);
        }
      }
    }
  }

  // Filter out empty net names
  netNames = [...new Set(netNames.filter(Boolean))];

  const items: NetSummaryItem[] = [];
  let totalTrackLengthMm = 0;
  let totalViasCount = 0;
  let totalCopperZonesCount = zones.length;

  for (const net of netNames) {
    const padCount = padsByNet.get(net) ?? 0;
    const trkData = tracksByNet.get(net) ?? { count: 0, length: 0 };
    const viaCount = viasByNet.get(net) ?? 0;
    const zoneCount = zonesByNet.get(net) ?? 0;

    totalTrackLengthMm += trkData.length;
    totalViasCount += viaCount;

    // Routing status calculation
    let routingStatus: "routed" | "partially_routed" | "unrouted";
    let completionPercent: number;

    if (padCount <= 1) {
      routingStatus = "routed";
      completionPercent = 100;
    } else {
      const requiredSegments = padCount - 1;
      // Copper zones provide connection for power/ground
      const isPowerGnd = categorizeNet(net) !== "signal";
      if (zoneCount > 0 && isPowerGnd) {
        routingStatus = "routed";
        completionPercent = 100;
      } else if (trkData.count >= requiredSegments) {
        routingStatus = "routed";
        completionPercent = 100;
      } else if (trkData.count > 0) {
        routingStatus = "partially_routed";
        completionPercent = Math.min(95, Math.round((trkData.count / requiredSegments) * 100));
      } else {
        routingStatus = "unrouted";
        completionPercent = 0;
      }
    }

    const airwireCount = routingStatus === "routed" ? 0 : Math.max(0, padCount - 1 - trkData.count);

    items.push({
      net,
      category: categorizeNet(net),
      padCount,
      trackSegmentCount: trkData.count,
      trackLengthMm: Number(trkData.length.toFixed(3)),
      viaCount,
      copperZoneCount: zoneCount,
      airwireCount,
      routingStatus,
      completionPercent
    });
  }

  // Summary counts
  let routedNetsCount = 0;
  let partiallyRoutedNetsCount = 0;
  let unroutedNetsCount = 0;
  const categoryCounts = { power: 0, ground: 0, signal: 0 };

  for (const item of items) {
    categoryCounts[item.category]++;
    if (item.routingStatus === "routed") routedNetsCount++;
    else if (item.routingStatus === "partially_routed") partiallyRoutedNetsCount++;
    else unroutedNetsCount++;
  }

  const overallRoutingCompletionPercent =
    items.length > 0
      ? Number((items.reduce((sum, item) => sum + item.completionPercent, 0) / items.length).toFixed(1))
      : 100;

  // Apply filters
  let filtered = items;
  if (netFilter) {
    filtered = filtered.filter((i) => i.net.toLowerCase() === netFilter);
  }
  if (categoryFilter && categoryFilter !== "all") {
    filtered = filtered.filter((i) => i.category === categoryFilter);
  }
  if (statusFilter && statusFilter !== "all") {
    filtered = filtered.filter((i) => i.routingStatus === statusFilter);
  }

  const limitedNets = filtered.slice(0, limit);

  return {
    target: currentTarget,
    method: "physical_extraction",
    tolerances: {
      padSnapTolerance: 0.1,
      unit: "mm"
    },
    inferenceLimits:
      "Track lengths aggregate physical copper track lines. For power and ground planes, low-impedance flood connection is quantified through copper zone count.",
    totalNets: items.length,
    routedNetsCount,
    partiallyRoutedNetsCount,
    unroutedNetsCount,
    overallRoutingCompletionPercent,
    totalTrackLengthMm: Number(totalTrackLengthMm.toFixed(3)),
    totalViasCount,
    totalCopperZonesCount,
    categoryCounts,
    nets: limitedNets
  };
}
