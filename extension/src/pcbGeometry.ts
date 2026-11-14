import { numeric, sanitize, toArray } from "./helpers.js";
import type { EasyEdaApi } from "./types.js";

function getProp(obj: any, getterName: string, propNames: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj[getterName] === "function") {
    try {
      const val = obj[getterName]();
      if (val !== undefined && val !== null) return val;
    } catch {
      // ignore getter error
    }
  }
  for (const prop of propNames) {
    if (obj[prop] !== undefined && obj[prop] !== null) {
      return obj[prop];
    }
  }
  return undefined;
}

export function normalizePcbPad(pad: any, parentComp?: any, includeRaw = false): Record<string, unknown> {
  const primitiveId = String(getProp(pad, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "");
  const padNumber = getProp(pad, "getState_PadNumber", ["padNumber", "number", "name", "pinNumber"]);
  const net = getProp(pad, "getState_Net", ["net", "netName"]);
  const x = numeric(getProp(pad, "getState_X", ["x", "centerX"]));
  const y = numeric(getProp(pad, "getState_Y", ["y", "centerY"]));
  const layer = getProp(pad, "getState_Layer", ["layer", "layerId"]);
  const nativePad = getProp(pad, "getState_Pad", ["pad", "padShape"]);
  const basicShape = Array.isArray(nativePad) && ["RECT", "ELLIPSE", "OVAL"].includes(String(nativePad[0]));
  const width = numeric(getProp(pad, "getState_Width", ["width"])) ?? (basicShape ? numeric(nativePad[1]) : undefined);
  const height =
    numeric(getProp(pad, "getState_Height", ["height"])) ?? (basicShape ? numeric(nativePad[2]) : undefined);
  const hole = getProp(pad, "getState_Hole", ["hole"]);
  const holeDiameter =
    numeric(getProp(pad, "getState_HoleDiameter", ["holeDiameter", "diameter"])) ??
    (Array.isArray(hole) && hole[0] === "ROUND" ? numeric(hole[1]) : undefined);
  const shape = Array.isArray(nativePad) ? nativePad[0] : getProp(pad, "getState_Shape", ["shape", "padShape"]);
  const rotation = numeric(getProp(pad, "getState_Rotation", ["rotation", "angle"])) ?? 0;
  const locked = Boolean(getProp(pad, "getState_PrimitiveLock", ["locked", "primitiveLock"]));

  const layerStr = String(layer ?? "").toLowerCase();
  const isThroughHole =
    (holeDiameter !== undefined && holeDiameter > 0) ||
    layerStr.includes("multi") ||
    Number(layer) === 12 ||
    layer === "MultiLayer";

  let side: "top" | "bottom" | "multi" | "unknown" = "unknown";
  if (isThroughHole) {
    side = "multi";
  } else if (layerStr.includes("top") || layer === 1 || layer === "TopLayer") {
    side = "top";
  } else if (layerStr.includes("bot") || layer === 2 || layer === "BottomLayer") {
    side = "bottom";
  }

  const compDesignator = parentComp
    ? getProp(parentComp, "getState_Designator", ["designator", "name", "displayName"])
    : undefined;
  const compId = parentComp
    ? getProp(parentComp, "getState_PrimitiveId", ["primitiveId", "id", "uuid"])
    : getProp(pad, "getState_ParentComponentPrimitiveId", ["parentComponentPrimitiveId", "componentId"]);

  return {
    units: "mil",
    primitiveId: primitiveId || undefined,
    padNumber: padNumber ? String(padNumber) : undefined,
    net: net ? String(net) : undefined,
    x,
    y,
    layer,
    side,
    shape: shape ? String(shape) : undefined,
    width,
    height,
    holeDiameter,
    rotation,
    isThroughHole,
    componentDesignator: compDesignator ? String(compDesignator) : undefined,
    componentPrimitiveId: compId ? String(compId) : undefined,
    locked,
    ...(includeRaw ? { raw: sanitize(pad) } : {})
  };
}

export async function getComponentPads(comp: any, api: () => EasyEdaApi): Promise<unknown[]> {
  if (typeof comp.getAllPins === "function") {
    try {
      const pins = await comp.getAllPins();
      if (Array.isArray(pins)) return pins;
    } catch {
      // fallback
    }
  }
  const eda = api();
  const compId = getProp(comp, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]);
  if (compId && eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    try {
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(compId);
      if (Array.isArray(pins)) return pins;
    } catch {
      // fallback
    }
  }
  return toArray(comp.pins ?? comp.pads ?? []);
}
