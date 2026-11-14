import {
  apiError,
  ensureApi,
  isRecord,
  numeric,
  optionalCall,
  pickString,
  sanitize,
  stringOrUndefined,
  toArray
} from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";
import { pcbUnits, pcbToNative } from "../pcbUnits.js";

export interface NormalizedPcbTrack {
  primitiveId: string;
  net?: string;
  layer: string | number;
  lineWidth: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  length: number;
  locked?: boolean;
  raw?: Record<string, unknown>;
}

export interface NormalizedPcbVia {
  primitiveId: string;
  net?: string;
  x: number;
  y: number;
  diameter: number;
  holeDiameter: number;
  startLayer?: string | number;
  endLayer?: string | number;
  locked?: boolean;
  raw?: Record<string, unknown>;
}

export type PcbTrackViaOperation =
  | {
      entity: "track";
      action: "create";
      net: string;
      layer: string | number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      lineWidth?: number;
    }
  | {
      entity: "track";
      action: "modify";
      trackId: string;
      properties: {
        net?: string;
        layer?: string | number;
        lineWidth?: number;
        startX?: number;
        startY?: number;
        endX?: number;
        endY?: number;
      };
    }
  | {
      entity: "track";
      action: "delete";
      trackId: string;
    }
  | {
      entity: "via";
      action: "create";
      net: string;
      x: number;
      y: number;
      diameter?: number;
      holeDiameter?: number;
      startLayer?: string | number;
      endLayer?: string | number;
    }
  | {
      entity: "via";
      action: "modify";
      viaId: string;
      properties: {
        net?: string;
        x?: number;
        y?: number;
        diameter?: number;
        holeDiameter?: number;
        startLayer?: string | number;
        endLayer?: string | number;
      };
    }
  | {
      entity: "via";
      action: "delete";
      viaId: string;
    };

function getProp(obj: any, getterName: string, propNames: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj[getterName] === "function") {
    try {
      const val = obj[getterName]();
      if (val !== undefined && val !== null) return val;
    } catch {
      // ignore
    }
  }
  for (const prop of propNames) {
    if (obj[prop] !== undefined && obj[prop] !== null) {
      return obj[prop];
    }
  }
  return undefined;
}

export function normalizePcbTrack(raw: unknown, includeRaw = false): NormalizedPcbTrack | null {
  if (!raw || typeof raw !== "object") return null;

  const primitiveId = String(getProp(raw, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "");
  if (!primitiveId) return null;

  const net = stringOrUndefined(getProp(raw, "getState_Net", ["net", "netName"]));
  const layer = getProp(raw, "getState_Layer", ["layer", "layerId"]) ?? 1;
  const lineWidth = numeric(getProp(raw, "getState_LineWidth", ["lineWidth", "width"])) ?? 0.254;
  const startX = numeric(getProp(raw, "getState_StartX", ["startX", "x1"])) ?? 0;
  const startY = numeric(getProp(raw, "getState_StartY", ["startY", "y1"])) ?? 0;
  const endX = numeric(getProp(raw, "getState_EndX", ["endX", "x2"])) ?? 0;
  const endY = numeric(getProp(raw, "getState_EndY", ["endY", "y2"])) ?? 0;
  const locked = Boolean(getProp(raw, "getState_PrimitiveLock", ["locked", "primitiveLock"]));

  const dx = endX - startX;
  const dy = endY - startY;
  const length = Number(Math.sqrt(dx * dx + dy * dy).toFixed(4));

  return {
    primitiveId,
    net,
    layer,
    lineWidth,
    startX,
    startY,
    endX,
    endY,
    length,
    locked,
    ...(includeRaw ? { raw: sanitize(raw) as Record<string, unknown> } : {})
  };
}

export function normalizePcbVia(raw: unknown, includeRaw = false): NormalizedPcbVia | null {
  if (!raw || typeof raw !== "object") return null;

  const primitiveId = String(getProp(raw, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "");
  if (!primitiveId) return null;

  const net = stringOrUndefined(getProp(raw, "getState_Net", ["net", "netName"]));
  const x = numeric(getProp(raw, "getState_X", ["x", "centerX"])) ?? 0;
  const y = numeric(getProp(raw, "getState_Y", ["y", "centerY"])) ?? 0;
  const diameter = numeric(getProp(raw, "getState_Diameter", ["diameter", "size", "outerDiameter"])) ?? 0.6;
  const holeDiameter = numeric(getProp(raw, "getState_HoleDiameter", ["holeDiameter", "hole", "drill"])) ?? 0.3;
  const startLayer = getProp(raw, "getState_StartLayer", ["startLayer", "fromLayer"]);
  const endLayer = getProp(raw, "getState_EndLayer", ["endLayer", "toLayer"]);
  const locked = Boolean(getProp(raw, "getState_PrimitiveLock", ["locked", "primitiveLock"]));

  return {
    primitiveId,
    net,
    x,
    y,
    diameter,
    holeDiameter,
    startLayer,
    endLayer,
    locked,
    ...(includeRaw ? { raw: sanitize(raw) as Record<string, unknown> } : {})
  };
}

export async function fetchPcbTracks(
  eda: EasyEdaApi,
  filters: { net?: string; layer?: string | number; primitiveId?: string; limit?: number; includeRaw?: boolean } = {}
): Promise<{ total: number; count: number; tracks: NormalizedPcbTrack[]; units: "mil" }> {
  let rawList: unknown[] = [];
  let fromGenericLines = false;
  if (eda.pcb_PrimitiveTrack?.getAll) {
    rawList = toArray(await eda.pcb_PrimitiveTrack.getAll());
  } else if (eda.pcb_PrimitiveLine?.getAll) {
    rawList = toArray(await eda.pcb_PrimitiveLine.getAll());
    fromGenericLines = true;
  }

  let tracks = rawList
    .map((item) => normalizePcbTrack(item, filters.includeRaw))
    .filter((t): t is NormalizedPcbTrack => t !== null);
  if (fromGenericLines)
    tracks = tracks.filter((track) => {
      const layer = Number(track.layer);
      return (
        layer === 1 ||
        layer === 2 ||
        (layer >= 15 && layer <= 46) ||
        /^(top(layer)?|bottom(layer)?|inner[_ ]?\d+)$/i.test(String(track.layer))
      );
    });

  const total = tracks.length;

  if (filters.primitiveId) {
    const id = filters.primitiveId.toLowerCase();
    tracks = tracks.filter((t) => t.primitiveId.toLowerCase() === id);
  }
  if (filters.net) {
    const net = filters.net.toLowerCase();
    tracks = tracks.filter((t) => t.net?.toLowerCase() === net);
  }
  if (filters.layer !== undefined) {
    const layerStr = String(filters.layer).toLowerCase();
    tracks = tracks.filter((t) => String(t.layer).toLowerCase() === layerStr);
  }

  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 5000) : 100;
  const count = tracks.length;
  const limitedTracks = tracks.slice(0, limit);

  return { total, count, tracks: limitedTracks, units: "mil" };
}

export async function fetchPcbVias(
  eda: EasyEdaApi,
  filters: { net?: string; primitiveId?: string; limit?: number; includeRaw?: boolean } = {}
): Promise<{ total: number; count: number; vias: NormalizedPcbVia[]; units: "mil" }> {
  let rawList: unknown[] = [];
  if (eda.pcb_PrimitiveVia?.getAll) {
    rawList = toArray(await eda.pcb_PrimitiveVia.getAll());
  }

  let vias = rawList
    .map((item) => normalizePcbVia(item, filters.includeRaw))
    .filter((v): v is NormalizedPcbVia => v !== null);

  const total = vias.length;

  if (filters.primitiveId) {
    const id = filters.primitiveId.toLowerCase();
    vias = vias.filter((v) => v.primitiveId.toLowerCase() === id);
  }
  if (filters.net) {
    const net = filters.net.toLowerCase();
    vias = vias.filter((v) => v.net?.toLowerCase() === net);
  }

  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 5000) : 100;
  const count = vias.length;
  const limitedVias = vias.slice(0, limit);

  return { total, count, vias: limitedVias, units: "mil" };
}

export async function preparePcbTrackViaMutation(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  const inputUnits = pcbUnits(params.units);
  if (inputUnits === "mm") {
    params = { ...params };
    if (params.action === "create") {
      if (params.entity === "track") params.lineWidth ??= 0.254;
      if (params.entity === "via") {
        params.diameter ??= 0.6;
        params.holeDiameter ??= 0.3;
      }
    }
    const lengthKeys = ["startX", "startY", "endX", "endY", "lineWidth", "x", "y", "diameter", "holeDiameter"];
    for (const key of lengthKeys)
      if (typeof params[key] === "number") params[key] = pcbToNative(params[key], inputUnits);
    if (isRecord(params.properties)) {
      params.properties = { ...params.properties };
      for (const key of lengthKeys)
        if (typeof params.properties[key] === "number")
          params.properties[key] = pcbToNative(params.properties[key], inputUnits);
    }
  }
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  const expectedTarget = params.expectedTarget ?? params.target;
  if (expectedTarget) {
    assertDocumentTargetMatch(expectedTarget, currentTarget);
  }

  if (currentTarget.documentType && currentTarget.documentType !== "pcb" && currentTarget.documentType !== "unknown") {
    throw apiError("wrong_document", "PCB track and via mutations require an active PCB document.");
  }

  const entity = String(params.entity ?? "").toLowerCase();
  const action = String(params.action ?? "").toLowerCase();

  if (!["track", "via"].includes(entity)) {
    throw apiError("invalid_parameters", "Parameter 'entity' must be 'track' or 'via'.");
  }
  if (!["create", "modify", "delete"].includes(action)) {
    throw apiError("invalid_parameters", "Parameter 'action' must be 'create', 'modify', or 'delete'.");
  }

  if (entity === "track") {
    if (action === "create") {
      const net = stringOrUndefined(params.net);
      if (!net) {
        throw apiError("missing_parameters", "Track creation requires 'net'.");
      }
      const layer = params.layer ?? 1;
      const startX = numeric(params.startX);
      const startY = numeric(params.startY);
      const endX = numeric(params.endX);
      const endY = numeric(params.endY);
      if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
        throw apiError("missing_parameters", "Track creation requires 'startX', 'startY', 'endX', and 'endY'.");
      }
      const lineWidth = numeric(params.lineWidth) ?? 0.254;

      const impact = `Creates PCB track on layer ${layer} (Net: ${net}, width: ${lineWidth}mil) from (${startX}, ${startY}) to (${endX}, ${endY}).`;
      const operation: PcbTrackViaOperation = {
        entity: "track",
        action: "create",
        net,
        layer,
        startX,
        startY,
        endX,
        endY,
        lineWidth
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "createTrack",
        target: currentTarget,
        operation,
        before: { exists: false },
        requestedAfter: { net, layer, startX, startY, endX, endY, lineWidth },
        changedKeys: ["net", "layer", "startX", "startY", "endX", "endY", "lineWidth"],
        scope: `track:create:layer=${layer}:net=${net}`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "createTrack",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }

    if (action === "modify") {
      const trackId = pickString(params, ["trackId", "primitiveId", "id"]);
      if (!trackId) {
        throw apiError("missing_parameters", "Track modification requires 'trackId'.");
      }
      const properties = isRecord(params.properties) ? (params.properties as Record<string, any>) : {};
      const changedKeys = Object.keys(properties);
      if (changedKeys.length === 0) {
        throw apiError("missing_parameters", "Track modification requires non-empty 'properties' object.");
      }

      const { tracks } = await fetchPcbTracks(eda, { primitiveId: trackId, limit: 1 });
      const currentTrack = tracks[0];
      if (!currentTrack) {
        throw apiError("not_found", `Track with primitiveId '${trackId}' not found on active PCB.`);
      }

      const impact = `Modifies PCB track ${trackId} (Net: ${currentTrack.net ?? "none"}, Layer: ${currentTrack.layer}) changing fields: ${changedKeys.join(", ")}.`;
      const operation: PcbTrackViaOperation = {
        entity: "track",
        action: "modify",
        trackId,
        properties
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "modifyTrack",
        target: currentTarget,
        operation,
        before: currentTrack,
        requestedAfter: { ...currentTrack, ...properties },
        changedKeys,
        scope: `track:modify:${trackId}`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "modifyTrack",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }

    if (action === "delete") {
      const trackId = pickString(params, ["trackId", "primitiveId", "id"]);
      if (!trackId) {
        throw apiError("missing_parameters", "Track deletion requires 'trackId'.");
      }

      const { tracks } = await fetchPcbTracks(eda, { primitiveId: trackId, limit: 1 });
      const currentTrack = tracks[0];
      if (!currentTrack) {
        throw apiError("not_found", `Track with primitiveId '${trackId}' not found on active PCB.`);
      }

      const impact = `Destructively deletes PCB track ${trackId} (Net: ${currentTrack.net ?? "none"}, Layer: ${currentTrack.layer}, length: ${currentTrack.length}mil). Native inventory absence alone cannot verify serialized/Gerber copper removal; execution remains unknown pending independent proof. Do not replay automatically.`;
      const operation: PcbTrackViaOperation = {
        entity: "track",
        action: "delete",
        trackId
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "deleteTrack",
        target: currentTarget,
        operation,
        before: currentTrack,
        requestedAfter: { exists: false },
        changedKeys: ["deleted"],
        scope: `track:delete:${trackId}`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "deleteTrack",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }
  }

  if (entity === "via") {
    if (action === "create") {
      const net = stringOrUndefined(params.net);
      if (!net) {
        throw apiError("missing_parameters", "Via creation requires 'net'.");
      }
      const x = numeric(params.x);
      const y = numeric(params.y);
      if (x === undefined || y === undefined) {
        throw apiError("missing_parameters", "Via creation requires 'x' and 'y'.");
      }
      const diameter = numeric(params.diameter) ?? 0.6;
      const holeDiameter = numeric(params.holeDiameter) ?? 0.3;
      const startLayer = params.startLayer;
      const endLayer = params.endLayer;

      const impact = `Creates PCB via at (${x}, ${y}) (Net: ${net}, outer: ${diameter}mil, drill: ${holeDiameter}mil).`;
      const operation: PcbTrackViaOperation = {
        entity: "via",
        action: "create",
        net,
        x,
        y,
        diameter,
        holeDiameter,
        startLayer,
        endLayer
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "createVia",
        target: currentTarget,
        operation,
        before: { exists: false },
        requestedAfter: { net, x, y, diameter, holeDiameter, startLayer, endLayer },
        changedKeys: ["net", "x", "y", "diameter", "holeDiameter"],
        scope: `via:create:net=${net}:at=(${x},${y})`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "createVia",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }

    if (action === "modify") {
      const viaId = pickString(params, ["viaId", "primitiveId", "id"]);
      if (!viaId) {
        throw apiError("missing_parameters", "Via modification requires 'viaId'.");
      }
      const properties = isRecord(params.properties) ? (params.properties as Record<string, any>) : {};
      const changedKeys = Object.keys(properties);
      if (changedKeys.length === 0) {
        throw apiError("missing_parameters", "Via modification requires non-empty 'properties' object.");
      }

      const { vias } = await fetchPcbVias(eda, { primitiveId: viaId, limit: 1 });
      const currentVia = vias[0];
      if (!currentVia) {
        throw apiError("not_found", `Via with primitiveId '${viaId}' not found on active PCB.`);
      }

      const impact = `Modifies PCB via ${viaId} (Net: ${currentVia.net ?? "none"}, at (${currentVia.x}, ${currentVia.y})) changing fields: ${changedKeys.join(", ")}.`;
      const operation: PcbTrackViaOperation = {
        entity: "via",
        action: "modify",
        viaId,
        properties
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "modifyVia",
        target: currentTarget,
        operation,
        before: currentVia,
        requestedAfter: { ...currentVia, ...properties },
        changedKeys,
        scope: `via:modify:${viaId}`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "modifyVia",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }

    if (action === "delete") {
      const viaId = pickString(params, ["viaId", "primitiveId", "id"]);
      if (!viaId) {
        throw apiError("missing_parameters", "Via deletion requires 'viaId'.");
      }

      const { vias } = await fetchPcbVias(eda, { primitiveId: viaId, limit: 1 });
      const currentVia = vias[0];
      if (!currentVia) {
        throw apiError("not_found", `Via with primitiveId '${viaId}' not found on active PCB.`);
      }

      const impact = `Destructively deletes PCB via ${viaId} at (${currentVia.x}, ${currentVia.y}) (Net: ${currentVia.net ?? "none"}).`;
      const operation: PcbTrackViaOperation = {
        entity: "via",
        action: "delete",
        viaId
      };

      const record = extensionMutations.prepare({
        domain: "pcb",
        action: "deleteVia",
        target: currentTarget,
        operation,
        before: currentVia,
        requestedAfter: { exists: false },
        changedKeys: ["deleted"],
        scope: `via:delete:${viaId}`,
        impact,
        ttlMs: 5 * 60_000
      });

      return {
        units: "mil",
        inputUnits,
        mutationId: record.mutationId,
        confirmation: record.confirmation,
        action: "deleteVia",
        target: record.target,
        preview: record.preview,
        expiresAt: record.expiresAt
      };
    }
  }

  throw apiError("invalid_parameters", `Unsupported track/via mutation operation '${entity}:${action}'.`);
}

export function assertTrackCoverage(
  tracks: NormalizedPcbTrack[],
  expected: {
    net: string;
    layer: string | number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    lineWidth: number;
  }
): string[] {
  const dx = expected.endX - expected.startX,
    dy = expected.endY - expected.startY,
    length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-4 || !Number.isFinite(expected.lineWidth) || expected.lineWidth <= 0)
    throw apiError("invalid_params", "Track requires finite nonzero geometry and positive width.");
  const ux = dx / length,
    uy = dy / length;
  // Native editor coordinates round to 0.1mil. This is a bounded numerical
  // uncertainty, not a PCB clearance or permission to accept adjacent copper.
  const quantizationMil = 0.05;
  const intervals: { a: number; b: number; id: string }[] = [];
  for (const t of tracks) {
    if (
      t.net !== expected.net ||
      String(t.layer) !== String(expected.layer) ||
      !Number.isFinite(t.lineWidth) ||
      t.lineWidth < expected.lineWidth - 1e-4
    )
      continue;
    const radius = Math.max(0, (t.lineWidth - expected.lineWidth) / 2) + quantizationMil;
    const ax = t.startX - expected.startX,
      ay = t.startY - expected.startY,
      bx = t.endX - expected.startX,
      by = t.endY - expected.startY;
    const vx = bx - ax,
      vy = by - ay,
      len = Math.hypot(vx, vy);
    if (![ax, ay, bx, by, len].every(Number.isFinite) || len <= 1e-8) continue;
    const add = (a: number, b: number) => {
      a = Math.max(0, a);
      b = Math.min(length, b);
      if (a <= b) intervals.push({ a, b, id: t.primitiveId });
    };
    // Erode each native round-ended copper capsule by requested half-width.
    // Covering the whole requested centerline by this union is a conservative
    // sufficient test for covering its full copper width (within quantization).
    for (const [x, y] of [
      [ax, ay],
      [bx, by]
    ]) {
      const along = x * ux + y * uy,
        perp = x * uy - y * ux,
        square = radius * radius - perp * perp;
      if (square >= 0) {
        const half = Math.sqrt(square);
        add(along - half, along + half);
      }
    }
    let lo = 0,
      hi = length;
    const clip = (constant: number, slope: number, min: number, max: number) => {
      if (Math.abs(slope) < 1e-12) {
        if (constant < min || constant > max) {
          lo = 1;
          hi = 0;
        }
        return;
      }
      const a = (min - constant) / slope,
        b = (max - constant) / slope;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    };
    clip((-ax * vx - ay * vy) / len, (ux * vx + uy * vy) / len, 0, len);
    clip((-ax * vy + ay * vx) / len, (ux * vy - uy * vx) / len, -radius, radius);
    if (lo <= hi) add(lo, hi);
  }
  intervals.sort((a, b) => a.a - b.a);
  let covered = 0;
  const matched = new Set<string>();
  for (const interval of intervals) {
    if (interval.a > covered + 1e-4) break;
    if (interval.b >= 0) {
      covered = Math.max(covered, interval.b);
      matched.add(interval.id);
    }
  }
  if (covered < length - 1e-4)
    throw apiError(
      "write_readback_unknown",
      "Native track net/layer/minimum-width/copper coverage mismatch; inspect before retrying."
    );
  return [...matched];
}

export async function executePcbTrackViaMutation(
  api: () => EasyEdaApi,
  op: PcbTrackViaOperation,
  before?: unknown
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const eda = api();

  if (op.entity === "track") {
    if (op.action === "create") {
      if (typeof op.lineWidth !== "number" || !Number.isFinite(op.lineWidth) || op.lineWidth <= 0)
        throw apiError(
          "invalid_params",
          "Track execution requires an explicit finite positive line width before writing."
        );
      let createdId: string | undefined;
      let nativeType: string | undefined,
        pollCount = 0;
      let dispatched = false;
      const guard = async () => {
        if ((op as any).target)
          assertDocumentTargetMatch(
            (op as any).target,
            extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
          );
      };
      if (!eda.pcb_PrimitiveTrack?.create && !eda.pcb_PrimitiveLine?.create)
        ensureApi("pcb_PrimitiveLine", "create", eda);
      await guard();
      try {
        if (eda.pcb_PrimitiveTrack?.create) {
          dispatched = true;
          const res = await eda.pcb_PrimitiveTrack.create({
            net: op.net,
            layer: op.layer,
            startX: op.startX,
            startY: op.startY,
            endX: op.endX,
            endY: op.endY,
            lineWidth: op.lineWidth
          });
          nativeType = res === null ? "null" : typeof res;
          createdId = stringOrUndefined(
            getProp(res, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ??
              (typeof res === "string" ? res : undefined)
          );
        } else if (eda.pcb_PrimitiveLine?.create) {
          dispatched = true;
          const res = await eda.pcb_PrimitiveLine.create(
            op.net,
            op.layer,
            op.startX,
            op.startY,
            op.endX,
            op.endY,
            op.lineWidth
          );
          nativeType = res === null ? "null" : typeof res;
          createdId = stringOrUndefined(
            getProp(res, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ??
              (typeof res === "string" ? res : undefined)
          );
        } else {
          ensureApi("pcb_PrimitiveTrack", "create", eda);
        }

        const deadline = Date.now() + 3000;
        let lastError: unknown;
        while (true) {
          await guard();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const all = await Promise.race([
              fetchPcbTracks(eda, { limit: 5000 }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Track readback poll deadline exceeded")),
                  Math.max(1, deadline - Date.now())
                );
              })
            ]);
            pollCount++;
            const matchedIDs = assertTrackCoverage(all.tracks, { ...op, lineWidth: op.lineWidth });
            const matchedTrack = createdId ? all.tracks.find((t) => t.primitiveId === createdId) : undefined;
            if (matchedTrack && !matchedIDs.includes(matchedTrack.primitiveId))
              throw new Error("Returned track ID has incompatible net/layer/width/geometry");
            await guard();
            return {
              executed: true,
              readback: {
                units: "mil",
                action: "createTrack",
                returnedId: createdId,
                returnedIdFound: !!matchedTrack,
                nativeType,
                pollCount,
                geometryVerified: true,
                coverageMethod: "native_copper_capsule_containment",
                nativeQuantizationToleranceMil: 0.05,
                minimumRequestedWidth: op.lineWidth,
                matchedIDs,
                ...(matchedTrack ? { primitiveId: matchedTrack.primitiveId, track: matchedTrack } : {})
              }
            };
          } catch (error) {
            lastError = error;
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (Date.now() >= deadline) throw lastError;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
      } catch (error) {
        if (!dispatched) throw error;
        const evidence = {
          returnedId: createdId,
          nativeType,
          pollCount,
          mutationId: (op as any).mutationId,
          cause: String(error)
        };
        throw apiError(
          "write_readback_unknown",
          `Native track create outcome requires inspection; never repeat create. ${JSON.stringify(evidence)}`,
          evidence
        );
      }
    }

    if (op.action === "modify") {
      const allowed = ["net", "layer", "lineWidth", "startX", "startY", "endX", "endY"];
      if (!Object.keys(op.properties).length || Object.keys(op.properties).some((k) => !allowed.includes(k)))
        throw apiError("invalid_parameters", "Track modify requires supported explicit properties.");
      const guard = async () => {
        if ((op as any).target)
          assertDocumentTargetMatch(
            (op as any).target,
            extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
          );
      };
      await guard();
      const current = (await fetchPcbTracks(eda, { primitiveId: op.trackId, limit: 1 })).tracks[0];
      if (!current) throw apiError("not_found", "Selected track is absent before modify; no write performed.");
      if (
        isRecord(before) &&
        allowed.some(
          (k) =>
            before[k] !== undefined &&
            (typeof before[k] === "number"
              ? Math.abs((current as any)[k] - Number(before[k])) > 1e-4
              : String((current as any)[k]) !== String(before[k]))
        )
      )
        throw apiError("stale_snapshot", "Track changed since preview; no modify performed.");
      const expected = { ...current, ...op.properties };
      if (
        typeof expected.net !== "string" ||
        ![expected.startX, expected.startY, expected.endX, expected.endY, expected.lineWidth].every(Number.isFinite) ||
        expected.lineWidth <= 0 ||
        Math.hypot(expected.endX - expected.startX, expected.endY - expected.startY) <= 1e-4
      )
        throw apiError("invalid_parameters", "Expected complete track geometry/net/width is unavailable.");
      const native = eda.pcb_PrimitiveTrack?.modify ? eda.pcb_PrimitiveTrack : eda.pcb_PrimitiveLine;
      if (!native?.modify) ensureApi("pcb_PrimitiveLine", "modify", eda);
      await guard();
      let pollCount = 0;
      try {
        await native.modify(op.trackId, op.properties);
        const deadline = Date.now() + 3000;
        let lastError: unknown;
        while (true) {
          await guard();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const all = await Promise.race([
              fetchPcbTracks(eda, { limit: 5000 }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Modify readback deadline expired")),
                  Math.max(1, deadline - Date.now())
                );
              })
            ]);
            pollCount++;
            const modifiedTrack = all.tracks.find((t) => t.primitiveId === op.trackId);
            // A width edit must actually acquire that width, not merely remain
            // covered by the original, wider copper. Net/layer stay exact.
            const candidates = all.tracks.filter((t) => Math.abs(t.lineWidth - expected.lineWidth) <= 1e-4);
            const matchedIDs = assertTrackCoverage(candidates, expected as any);
            if (
              modifiedTrack &&
              (!matchedIDs.includes(op.trackId) ||
                ["startX", "startY", "endX", "endY"].some(
                  (k) => Math.abs((modifiedTrack as any)[k] - (expected as any)[k]) > 0.05
                ))
            )
              throw new Error("Existing modified ID does not match complete expected old+patch geometry");
            await guard();
            return {
              executed: true,
              readback: {
                units: "mil",
                action: "modifyTrack",
                originalId: op.trackId,
                originalIdFound: !!modifiedTrack,
                geometryVerified: true,
                exactExpectedWidthVerified: true,
                expected,
                matchedIDs,
                pollCount,
                nativeQuantizationToleranceMil: 0.05,
                ...(modifiedTrack ? { primitiveId: modifiedTrack.primitiveId, track: modifiedTrack } : {}),
                before: current
              }
            };
          } catch (error) {
            lastError = error;
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (Date.now() >= deadline) throw lastError;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
      } catch (error) {
        const evidence = {
          originalId: op.trackId,
          pollCount,
          expected,
          mutationId: (op as any).mutationId,
          cause: String(error)
        };
        throw apiError(
          "write_readback_unknown",
          `Native track modify readback unknown; do not repeat modification. ${JSON.stringify(evidence)}`,
          evidence
        );
      }
    }

    if (op.action === "delete") {
      const native = eda.pcb_PrimitiveTrack?.delete ? eda.pcb_PrimitiveTrack : eda.pcb_PrimitiveLine;
      if (!native?.delete) ensureApi("pcb_PrimitiveLine", "delete", eda);
      if (!eda.pcb_PrimitiveTrack?.getAll && !eda.pcb_PrimitiveLine?.getAll)
        ensureApi("pcb_PrimitiveLine", "getAll", eda);
      const evidence: Record<string, unknown> = {
        units: "mil",
        action: "deleteTrack",
        primitiveId: op.trackId,
        nativeRequestSucceeded: null,
        inventoryIdAbsent: null,
        physicalCopperRemovalVerified: false,
        sdkPending: true,
        automaticReplay: false,
        readbackLimitations: [
          "SDK acknowledgement and runtime Line/Track inventory do not verify serialized source-child removal.",
          "A merged runtime parent may disappear while its source-child copper remains in saved exports or Gerber.",
          "Independent scoped serialized/manufacturing proof is not available in this executor."
        ]
      };
      const mutationId = (op as PcbTrackViaOperation & { mutationId?: string }).mutationId;
      const publish = () => {
        if (mutationId) extensionMutations.recordExecutionEvidence(mutationId, evidence);
      };
      publish();
      try {
        const response = await native.delete([op.trackId]);
        // Legacy SDK Line.delete resolves true even when it discards the native
        // deleted-ID payload. This field acknowledges only that SDK request.
        evidence.nativeRequestSucceeded = response !== false;
      } catch (error) {
        evidence.nativeRequestSucceeded = false;
        evidence.nativeRequestError = String(error);
      }
      evidence.sdkPending = false;
      publish();
      try {
        const { tracks } = await fetchPcbTracks(eda, { primitiveId: op.trackId, limit: 1 });
        evidence.inventoryIdAbsent = tracks.length === 0;
      } catch (error) {
        evidence.inventoryReadbackError = String(error);
      }
      publish();
      throw apiError(
        "write_readback_unknown",
        `Track delete request settled; physical copper removal is unverified. Inspect scoped saved-source/Gerber proof before any further write; do not replay. ${JSON.stringify(evidence)}`,
        evidence
      );
    }
  }

  if (op.entity === "via") {
    if (op.action === "create") {
      ensureApi("pcb_PrimitiveVia", "create", eda);
      const res = await eda.pcb_PrimitiveVia.create(op.net, op.x, op.y, op.holeDiameter, op.diameter);

      const createdId = stringOrUndefined(
        getProp(res, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ??
          (typeof res === "string" ? res : undefined)
      );

      // Readback verification
      const { vias } = await fetchPcbVias(eda, {
        net: op.net,
        primitiveId: createdId,
        limit: 5000
      });

      const matchedVia = createdId ? vias.find((v) => v.primitiveId === createdId) : vias[0];
      if (!createdId || !matchedVia) {
        throw apiError("readback_failed", "Created PCB via could not be verified on readback.");
      }
      if (
        matchedVia.net !== op.net ||
        !["x", "y", "diameter", "holeDiameter"].every(
          (key) => Math.abs((matchedVia as any)[key] - (op as any)[key]) <= 1e-4
        )
      )
        throw apiError("write_readback_unknown", "Native via coordinate/net/drill/diameter mismatch; do not repeat.");

      return {
        executed: true,
        readback: {
          units: "mil",
          action: "createVia",
          primitiveId: matchedVia.primitiveId,
          via: matchedVia
        }
      };
    }

    if (op.action === "modify") {
      ensureApi("pcb_PrimitiveVia", "modify", eda);
      await eda.pcb_PrimitiveVia.modify(op.viaId, op.properties);

      // Readback verification
      const { vias } = await fetchPcbVias(eda, { primitiveId: op.viaId, limit: 1 });
      const modifiedVia = vias[0];
      if (!modifiedVia) {
        throw apiError("readback_failed", `Modified PCB via '${op.viaId}' could not be read back.`);
      }

      return {
        executed: true,
        readback: {
          units: "mil",
          action: "modifyVia",
          primitiveId: op.viaId,
          before,
          via: modifiedVia
        }
      };
    }

    if (op.action === "delete") {
      ensureApi("pcb_PrimitiveVia", "delete", eda);
      await eda.pcb_PrimitiveVia.delete([op.viaId]);

      // Readback verification
      const { vias } = await fetchPcbVias(eda, { primitiveId: op.viaId, limit: 1 });
      if (vias.length > 0) {
        throw apiError("readback_failed", `PCB via '${op.viaId}' still exists after delete operation.`);
      }

      return {
        executed: true,
        readback: {
          units: "mil",
          action: "deleteVia",
          primitiveId: op.viaId,
          deleted: true
        }
      };
    }
  }

  throw apiError("invalid_parameters", "Unsupported operation for track/via execution.");
}
