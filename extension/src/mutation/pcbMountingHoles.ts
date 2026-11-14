import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { pcbToNative, pcbUnits } from "../pcbUnits.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";

type Hole = { x: number; y: number; diameter: number };
// Observed native Pad.get rounds centers and the outer pad shape. Allow 0.05mil;
// the higher precision drill getter deliberately keeps its tighter check.
const PAD_READBACK_TOLERANCE_MIL = 0.05;
function parse(params: Record<string, any>): Hole[] {
  const units = pcbUnits(params.units);
  if (!Array.isArray(params.holes) || !params.holes.length || params.holes.length > 100)
    throw apiError("invalid_params", "Provide 1–100 round non-plated mounting holes.");
  const holes = params.holes.map((h: any) => {
    if (
      !h ||
      Object.keys(h).some((k) => !["x", "y", "diameter"].includes(k)) ||
      ![h.x, h.y, h.diameter].every((v) => typeof v === "number" && Number.isFinite(v)) ||
      h.diameter <= 0
    )
      throw apiError("invalid_params", "Each hole needs finite x/y and a positive diameter only.");
    const result = { x: pcbToNative(h.x, units), y: pcbToNative(h.y, units), diameter: pcbToNative(h.diameter, units) };
    if (!Object.values(result).every(Number.isFinite)) throw apiError("invalid_params", "Hole conversion overflow.");
    return result;
  });
  if (holes.some((h, i) => holes.some((other, j) => j < i && Math.hypot(h.x - other.x, h.y - other.y) < 1e-4)))
    throw apiError("invalid_params", "Duplicate mounting hole centers.");
  return holes;
}
async function guard(eda: EasyEdaApi, expected?: any) {
  const current = extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  if (current.documentType !== "pcb" || !current.documentId || !current.projectId)
    throw apiError("invalid_target_type", "An identifiable active PCB/project is required.");
  if (expected) assertDocumentTargetMatch(expected, current);
  return current;
}
function sdk(eda: EasyEdaApi) {
  const pad = eda.pcb_PrimitivePad;
  if (!["create", "get", "getAll"].every((k) => typeof pad?.[k] === "function"))
    throw apiError("api_unavailable", "NPTH requires native Pad.create, Pad.get and Pad.getAll.");
  return pad;
}
async function assertVacant(pad: any, holes: Hole[]) {
  const pads = await pad.getAll();
  if (!Array.isArray(pads)) throw apiError("readback_failed", "Native pad inventory unavailable.");
  for (const h of holes)
    if (
      pads.some(
        (p) =>
          Math.abs(p.getState_X?.() - h.x) <= PAD_READBACK_TOLERANCE_MIL &&
          Math.abs(p.getState_Y?.() - h.y) <= PAD_READBACK_TOLERANCE_MIL
      )
    )
      throw apiError("occupied_center", "A mounting-hole center is occupied; inspect before preparing again.");
}
export async function prepareMountingHoles(api: () => EasyEdaApi, params: Record<string, any>) {
  const holes = parse(params),
    eda = api(),
    native = sdk(eda);
  const target = await guard(eda, params.target);
  await assertVacant(native, holes);
  await guard(eda, target);
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: "createMountingHoles",
    target,
    operation: { holes },
    before: { centersVacant: true },
    requestedAfter: { units: "mil", holes, metallization: false, net: "", layer: 12 },
    changedKeys: ["mountingHoles"],
    scope: "pcb:npth-mounting-holes",
    impact: `Creates ${holes.length} round non-plated holes as empty-net multi-layer pads with zero annular ring. Native drilling output still requires verification.`,
    ttlMs: 5 * 60000
  });
  return {
    units: "mil",
    inputUnits: pcbUnits(params.units),
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executeMountingHoles(api: () => EasyEdaApi, record: any) {
  const eda = api(),
    native = sdk(eda),
    holes = parse({ holes: record.operation.holes });
  await guard(eda, record.target);
  await assertVacant(native, holes);
  const verified: any[] = [];
  let started = false;
  async function read(id: string, h: Hole) {
    const p = await native.get(id);
    const actual = {
      primitiveId: p?.getState_PrimitiveId?.(),
      x: p?.getState_X?.(),
      y: p?.getState_Y?.(),
      layer: p?.getState_Layer?.(),
      net: p?.getState_Net?.(),
      hole: p?.getState_Hole?.(),
      pad: p?.getState_Pad?.(),
      holeOffsetX: p?.getState_HoleOffsetX?.(),
      holeOffsetY: p?.getState_HoleOffsetY?.(),
      metallization: p?.getState_Metallization?.()
    };
    if (
      actual.primitiveId !== id ||
      actual.layer !== 12 ||
      actual.net !== "" ||
      actual.metallization !== false ||
      ![actual.holeOffsetX, actual.holeOffsetY].every((v) => Number.isFinite(v) && Math.abs(v) <= 1e-4) ||
      ![actual.x, actual.y].every(Number.isFinite) ||
      Math.abs(actual.x - h.x) > PAD_READBACK_TOLERANCE_MIL ||
      Math.abs(actual.y - h.y) > PAD_READBACK_TOLERANCE_MIL ||
      actual.hole?.[0] !== "ROUND" ||
      !Number.isFinite(actual.hole?.[1]) ||
      Math.abs(actual.hole?.[1] - h.diameter) > 1e-4 ||
      actual.pad?.[0] !== "ELLIPSE" ||
      ![actual.pad?.[1], actual.pad?.[2]].every(
        (v) => Number.isFinite(v) && Math.abs(v - h.diameter) <= PAD_READBACK_TOLERANCE_MIL
      )
    )
      throw apiError("readback_failed", `NPTH ${id} independent geometry/plating readback mismatch.`);
    return actual;
  }
  try {
    for (const h of holes) {
      await guard(eda, record.target);
      started = true;
      // Installed SDK positional contract: MULTI, unnumbered, zero-ring ROUND hole, no metallization.
      const created = await native.create(
        12,
        "",
        h.x,
        h.y,
        0,
        ["ELLIPSE", h.diameter, h.diameter],
        "",
        ["ROUND", h.diameter],
        0,
        0,
        0,
        false,
        0
      );
      const id = created?.getState_PrimitiveId?.();
      if (typeof id !== "string" || !id) throw apiError("readback_failed", "Created NPTH ID unavailable.");
      verified.push(await read(id, h));
    }
    for (let i = 0; i < verified.length; i++) await read(verified[i].primitiveId, holes[i]);
    await guard(eda, record.target);
    return {
      executed: true,
      readback: { units: "mil", nonPlated: true, verified: true, holes: verified, manufactureDrillVerified: false }
    };
  } catch (error) {
    if (!started) throw error;
    throw apiError("write_readback_unknown", `NPTH outcome uncertain: ${String(error)}. Do not replay automatically.`, {
      verifiedHoles: verified
    });
  }
}
