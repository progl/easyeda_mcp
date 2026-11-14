import { apiError, numeric, optionalCall, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import type { EasyEdaApi } from "../types.js";

export interface Pcb3dInspectionParams {
  maxHeightMm?: number;
  enclosureHeightMm?: number;
  checkInterference?: boolean;
  target?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface Pcb3dViewParams {
  viewAngle?: "top" | "bottom" | "isometric_ne" | "isometric_sw" | "front" | "side";
  target?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface Component3dInfo {
  primitiveId: string;
  designator: string;
  footprint: string;
  layer: number | string;
  layerName: "Top" | "Bottom" | "Other";
  x: number;
  y: number;
  rotation: number;
  has3DModel: boolean | null;
  modelType: "STEP" | "OBJ" | "WRL" | "NONE" | "UNKNOWN";
  modelTitle?: string;
  modelUuid?: string;
  heightMm: number | null;
  elevationMm: number | null;
  heightSource: "native_3d" | "attribute" | "package_heuristic" | "unknown";
  boundingBox3d: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } | null;
}

export interface Board3dEnvelope {
  boardThicknessMm: number | null;
  maxHeightTopMm: number | null;
  maxHeightBottomMm: number | null;
  totalEnvelopeHeightMm: number | null;
  tallestComponentTop?: {
    designator: string;
    heightMm: number | null;
    footprint: string;
    x: number;
    y: number;
  };
  tallestComponentBottom?: {
    designator: string;
    heightMm: number | null;
    footprint: string;
    x: number;
    y: number;
  };
  enclosureClearanceMm?: number | null;
  enclosureStatus?: "FIT" | "TIGHT" | "EXCEEDED" | "UNKNOWN";
}

export interface Missing3dModel {
  designator: string;
  footprint: string;
  criticality: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
}

export interface InterferencePair3d {
  componentA: string;
  componentB: string;
  overlapVolumeMm3?: number;
  details: string;
}

export interface HeightViolation3d {
  designator: string;
  heightMm: number | null;
  maxPermittedMm: number;
  exceededByMm: number;
  layer: string;
}

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

/**
 * Heuristic height estimation based on footprint and package naming
 */
export function estimateComponentHeight(footprint: string, designator: string): number {
  const fp = (footprint || "").toUpperCase();
  const des = (designator || "").toUpperCase();

  // Connectors / Headers / USB
  if (des.startsWith("J") || fp.includes("CONN") || fp.includes("USB") || fp.includes("HEADER") || fp.includes("PIN")) {
    if (fp.includes("USB-C") || fp.includes("TYPE-C")) return 3.2;
    if (fp.includes("USB")) return 7.0;
    if (fp.includes("RJ45")) return 13.5;
    if (fp.includes("HEADER") || fp.includes("HDR")) return 8.5;
    return 6.0;
  }

  // Large electrolytic capacitors
  if (
    des.startsWith("C") &&
    (fp.includes("ALUM") || fp.includes("ELEC") || fp.includes("CAN") || fp.includes("CAP-D"))
  ) {
    return 11.0;
  }

  // Tantalum / Inductors / Transformers
  if (des.startsWith("T") || fp.includes("TRANS")) return 12.0;
  if (
    des.startsWith("L") &&
    (fp.includes("INDUCTOR") || fp.includes("COIL") || fp.includes("NR") || fp.includes("CD"))
  ) {
    return 4.5;
  }

  // Power packages
  if (fp.includes("TO-220") || fp.includes("TO-247")) return 15.0;
  if (fp.includes("TO-263") || fp.includes("D2PAK")) return 4.5;
  if (fp.includes("TO-252") || fp.includes("DPAK")) return 2.3;
  if (fp.includes("SOT-223")) return 1.8;
  if (fp.includes("SOT-23") || fp.includes("SOT23")) return 1.1;

  // IC packages
  if (fp.includes("DIP") || fp.includes("PDIP")) return 5.1;
  if (fp.includes("SOIC") || fp.includes("SOP")) return 1.75;
  if (fp.includes("TSSOP") || fp.includes("MSOP")) return 1.1;
  if (fp.includes("QFP") || fp.includes("LQFP")) return 1.6;
  if (fp.includes("QFN") || fp.includes("DFN")) return 0.9;
  if (fp.includes("BGA")) return 1.5;

  // Discrete SMD passives
  if (fp.includes("0402")) return 0.35;
  if (fp.includes("0603")) return 0.45;
  if (fp.includes("0805")) return 0.6;
  if (fp.includes("1206")) return 0.7;
  if (fp.includes("1210") || fp.includes("2512")) return 0.8;

  // Push buttons / switches
  if (des.startsWith("SW") || fp.includes("SWITCH") || fp.includes("KEY")) return 4.0;

  // Default passive / discrete height
  return 1.0;
}

export function classifyMissingModelCriticality(designator: string, footprint: string): "HIGH" | "MEDIUM" | "LOW" {
  const des = (designator || "").toUpperCase();
  const fp = (footprint || "").toUpperCase();

  if (
    des.startsWith("J") ||
    des.startsWith("T") ||
    des.startsWith("SW") ||
    des.startsWith("HS") ||
    fp.includes("CONN") ||
    fp.includes("USB") ||
    fp.includes("HEADER") ||
    fp.includes("TRANS") ||
    fp.includes("ELEC") ||
    fp.includes("ALUM") ||
    fp.includes("CAN") ||
    fp.includes("TO-220")
  ) {
    return "HIGH";
  }

  if (des.startsWith("U") || fp.includes("QFP") || fp.includes("BGA") || fp.includes("SOIC") || fp.includes("MODULE")) {
    return "MEDIUM";
  }

  return "LOW";
}

/**
 * Inspects 3D models and vertical spatial clearance on the active PCB
 */
export async function inspectPcb3d(
  api: () => EasyEdaApi,
  params: Pcb3dInspectionParams = {}
): Promise<Record<string, unknown>> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  if (params.target) {
    assertDocumentTargetMatch(params.target, currentTarget);
  }

  if (currentTarget.documentType && currentTarget.documentType !== "pcb" && currentTarget.documentType !== "unknown") {
    throw apiError("wrong_document", "3D PCB inspection requires an active PCB document.");
  }

  const rawComponents = toArray(await optionalCall(() => eda.pcb_PrimitiveComponent?.getAll?.()));
  const components = rawComponents.map((comp: any) => {
    const primitiveId = String(getProp(comp, "getState_PrimitiveId", ["primitiveId", "id"]) ?? "");
    const designator = String(getProp(comp, "getState_Designator", ["designator", "name"]) ?? "");
    const rawFootprint = getProp(comp, "getState_Footprint", ["footprint", "package", "packageName"]);
    const label = typeof rawFootprint === "string" ? rawFootprint : (rawFootprint?.name ?? rawFootprint?.title);
    const footprint = typeof label === "string" ? label : "";
    const model = getProp(comp, "getState_3DModel", ["3dModel", "model3D", "model3d", "model"]);
    const modelUuid = typeof model?.uuid === "string" ? model.uuid : undefined;
    const modelTitle = typeof model?.title === "string" ? model.title : undefined;
    const metadataHeight = numeric(model?.height);
    return {
      primitiveId,
      designator,
      footprint,
      footprintUuid: typeof rawFootprint?.uuid === "string" ? rawFootprint.uuid : undefined,
      x: numeric(getProp(comp, "getState_X", ["x", "centerX"])),
      y: numeric(getProp(comp, "getState_Y", ["y", "centerY"])),
      coordinateUnits: "mil",
      rotation: numeric(getProp(comp, "getState_Rotation", ["rotation", "angle"])),
      layer: getProp(comp, "getState_Layer", ["layer", "layerId"]),
      modelReferencePresent: Boolean(modelUuid || modelTitle),
      modelUuid,
      modelTitle,
      // A binding/UUID, metadata height or render capability does not establish
      // a loaded solid, its transform, units, shape or actual bounding box.
      has3DModel: null,
      modelType: "UNKNOWN",
      heightMm: null,
      heightSource: "unknown",
      elevationMm: null,
      boundingBox3d: null,
      nativeGeometryVerified: false,
      reportedModelHeightMm: metadataHeight !== undefined && metadataHeight > 0 ? metadataHeight : undefined,
      heuristic: {
        heightEstimateMm: estimateComponentHeight(footprint, designator),
        source: "package_heuristic",
        verified: false,
        usableForEnclosureFit: false
      }
    };
  });
  assertDocumentTargetMatch(
    currentTarget,
    extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
  );
  const native3dAvailable = Boolean(
    eda.pcb_Document?.get3DView || eda.pcb_Document?.export3D || eda.dmt_EditorControl?.get3DCanvas
  );
  return {
    target: currentTarget,
    native3dAvailable,
    nativeGeometryVerified: false,
    envelope: {
      boardThicknessMm: null,
      maxHeightTopMm: null,
      maxHeightBottomMm: null,
      totalEnvelopeHeightMm: null,
      enclosureClearanceMm: null,
      enclosureStatus: "UNKNOWN"
    },
    totalComponents: components.length,
    componentsWith3dModel: null,
    componentsMissing3dModel: null,
    modelReferenceCount: components.filter((c) => c.modelReferencePresent).length,
    missing3dModels: components
      .filter((c) => !c.modelReferencePresent)
      .map((c) => ({
        designator: c.designator,
        footprint: c.footprint,
        criticality: classifyMissingModelCriticality(c.designator, c.footprint),
        reason: "No model reference reported; native solid availability has not been checked."
      })),
    interferenceStatus: params.checkInterference === false ? "NOT_REQUESTED" : "UNKNOWN",
    interferenceCollisions: [],
    heightViolations: [],
    heightCheckStatus: "UNKNOWN",
    limitations: [
      "Native solids and transforms were not obtained. Empty collision/violation lists do not mean checked or clear.",
      "Package estimates and model metadata are separate hints; enclosure fit and real component height remain unknown."
    ],
    components
  };
}

/**
 * Retrieves 3D view angles, rendering settings and export options
 */
export async function fetchPcb3dView(
  api: () => EasyEdaApi,
  params: Pcb3dViewParams = {}
): Promise<Record<string, unknown>> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

  if (params.target) {
    assertDocumentTargetMatch(params.target, currentTarget);
  }

  const angle = params.viewAngle ?? "isometric_ne";

  const cameraAngles: Record<string, { pitch: number; yaw: number; roll: number; description: string }> = {
    top: { pitch: 90, yaw: 0, roll: 0, description: "Direct top-down vertical perspective" },
    bottom: { pitch: -90, yaw: 0, roll: 0, description: "Direct bottom-up underside perspective" },
    isometric_ne: { pitch: 45, yaw: 45, roll: 0, description: "Isometric view from North-East angle" },
    isometric_sw: { pitch: 45, yaw: 225, roll: 0, description: "Isometric view from South-West angle" },
    front: { pitch: 0, yaw: 0, roll: 0, description: "Front profile edge-on elevation" },
    side: { pitch: 0, yaw: 90, roll: 0, description: "Right side profile edge-on elevation" }
  };

  const selectedCamera = cameraAngles[angle] ?? cameraAngles["isometric_ne"];

  return {
    target: currentTarget,
    viewAngle: angle,
    camera: {
      ...selectedCamera,
      distanceMm: 120,
      targetPoint: { x: 0, y: 0, z: 0 }
    },
    renderingLayers: {
      topSilkscreen: true,
      topSoldermask: true,
      topCopper: true,
      coreSubstrateFr4: true,
      bottomCopper: true,
      bottomSoldermask: true,
      bottomSilkscreen: true,
      component3dModels: true
    },
    exportOptions: {
      stepSupported: Boolean((eda.pcb_Document as any)?.exportStep || (eda.pcb_ManufactureData as any)?.getStepFile),
      objSupported: Boolean((eda.pcb_Document as any)?.exportObj),
      vrmlSupported: false
    },
    quickActionNotice:
      "In EasyEDA Pro desktop or browser editor, press Alt+3 or navigate to View -> 3D View to open the real-time interactive 3D WebGL renderer."
  };
}
