import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
import { createPcbPreservationEnvironment } from "./mechanicalPadMutations.js";
import {
  encodePcbPreservationInventory,
  decodePcbPreservationInventory,
  samePcbPreservationInventory,
  PCB_PRESERVATION_ENCODING
} from "./pcbPreservationEncoding.js";
type Row = Record<string, any>;
const KEY = "3D Model Transform",
  ACTION = "setPcbComponent3dTransform";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const id = (v: any) => typeof v === "string" && !!v && v === v.trim() && v.length <= 512;
const normalizeKey = (v: string) => v.toLowerCase().replace(/\s+/g, "");
export function parseNative3dTuple(value: unknown): number[] {
  if (typeof value !== "string" || value.length > 2000)
    throw apiError("invalid_params", "Exact native legacy tuple9 string required; v2 matrices are unsupported.");
  const parts = value.split(",");
  if (
    parts.length !== 9 ||
    parts.some((v) => !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(v.trim()) || !Number.isFinite(Number(v)))
  )
    throw apiError("invalid_params", "Native legacy tuple must contain exactly9 finite explicit numbers.");
  return parts.map(Number);
}
function input(p: Row, write = false) {
  const keys = ["projectId", "pcbUuid", "expectedBoardName", "protectedBoardName", "primitiveId"];
  if (
    keys.some((k) => !id(p[k])) ||
    p.protectedBoardName !== "Board1" ||
    p.expectedBoardName.toLowerCase() === "board1"
  )
    throw apiError("invalid_params", "Exact active project/PCB/component and distinct protected Board1 required.");
  if (write) {
    keys.push("expectedOldTuple", "newTuple", "expectedModelRef", "expectedFootprintRef");
    parseNative3dTuple(p.expectedOldTuple);
    if (
      !Array.isArray(p.newTuple) ||
      p.newTuple.length !== 9 ||
      p.newTuple.some((v: any) => typeof v !== "number" || !Number.isFinite(v))
    )
      throw apiError(
        "invalid_params",
        "Exactly9 finite caller-reviewed native tuple numbers required; no automatic unit/sign conversion."
      );
    for (const key of ["expectedModelRef", "expectedFootprintRef"]) {
      const r = p[key];
      if (
        !isRecord(r) ||
        !id(r.uuid) ||
        typeof r.libraryUuid !== "string" ||
        Object.keys(r).some((k) => !["uuid", "libraryUuid", "name"].includes(k)) ||
        (r.name !== undefined && typeof r.name !== "string")
      )
        throw apiError("invalid_params", `Exact public ${key} required.`);
    }
    if (p.newTuple.join(",") === p.expectedOldTuple)
      throw apiError("invalid_params", "Transform is unchanged; no mutation required.");
  }
  if (Object.keys(p).some((k) => !keys.includes(k)))
    throw apiError("invalid_params", "Only one explicit 3D Model Transform property may be staged.");
  return JSON.parse(canonicalJson(p));
}
const packed = (state: Row) => ({
  boards: state.boards,
  attributes: state.attributes,
  inventory: encodePcbPreservationInventory(state.inventory)
});
const unpacked = (state: Row) => ({
  boards: state.boards,
  attributes: state.attributes,
  inventory: decodePcbPreservationInventory(state.inventory)
});
const sameState = (a: Row, b: Row) =>
  same(a.boards, b.boards) &&
  same(a.attributes, b.attributes) &&
  samePcbPreservationInventory(a.inventory, b.inventory);
function environment(api: () => EasyEdaApi, scope: Row) {
  const env = createPcbPreservationEnvironment(api, scope);
  env.require(env.eda.sys_Environment, ["getEditorCurrentVersion"], "Reviewed3D transform adapter");
  env.require(env.eda.pcb_PrimitiveComponent, ["get"], "Independent component getter");
  env.require(env.eda.pcb_PrimitiveAttribute, ["getAll"], "All attribute preservation");
  async function guard() {
    const target = await env.guard();
    if ((await env.read("editor version", () => env.eda.sys_Environment.getEditorCurrentVersion(true))) !== "3.2.209")
      throw apiError("capability_unavailable", "3D property transaction is source-reviewed for editor3.2.209 only.");
    return target;
  }
  async function snapshot() {
    await guard();
    const boards = JSON.parse(
      canonicalJson(await env.read("board inventory", () => env.eda.dmt_Board.getAllBoardsInfo()))
    );
    const inventory = await env.snapshot();
    const raw = await env.read("Attribute.getAll", () => env.eda.pcb_PrimitiveAttribute.getAll());
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", "Complete native Attribute array required.");
    const attributes = raw.map((p) => env.row(p)).sort((a, b) => a.PrimitiveId.localeCompare(b.PrimitiveId));
    if (
      new Set(attributes.map((p) => p.PrimitiveId)).size !== attributes.length ||
      attributes.some((p) => p.PrimitiveType !== "Attribute" || !id(p.ParentPrimitiveId))
    )
      throw apiError("unverified_inventory", "Exact attribute IDs/types/parents required.");
    if (!same(boards, await env.read("board final", () => env.eda.dmt_Board.getAllBoardsInfo())))
      throw apiError("stale_snapshot", "Board inventory changed during observation.");
    await guard();
    return { boards, inventory, attributes };
  }
  function selected(state: Row) {
    const found = state.inventory.groups.Component.filter((p: Row) => p.PrimitiveId === scope.primitiveId),
      p = found[0];
    if (
      found.length !== 1 ||
      p.PrimitiveType !== "Component" ||
      ![1, 2].includes(p.Layer) ||
      !isRecord(p.OtherProperty) ||
      !isRecord(p.Model3D) ||
      !id(p.Model3D.uuid) ||
      !isRecord(p.Footprint) ||
      !id(p.Footprint.uuid)
    )
      throw apiError(
        "unverified_inventory",
        "Unique component with complete native model/footprint/property references required."
      );
    const aliases = Object.keys(p.OtherProperty).filter((k) => normalizeKey(k) === normalizeKey(KEY));
    if (aliases.length !== 1 || aliases[0] !== KEY)
      throw apiError(
        "unverified_inventory",
        "One exact canonical 3D Model Transform property required; aliases are unsupported."
      );
    parseNative3dTuple(p.OtherProperty[KEY]);
    if (
      state.attributes.some(
        (a: Row) =>
          a.ParentPrimitiveId === scope.primitiveId &&
          typeof a.Key === "string" &&
          normalizeKey(a.Key) === normalizeKey(KEY)
      )
    )
      throw apiError(
        "unverified_inventory",
        "Drawn transform attributes require separate review; no ambiguous attribute side effects."
      );
    return p;
  }
  async function independent(state: Row, methods = false) {
    const p = selected(state),
      native = await env.read("Component.get", () => env.eda.pcb_PrimitiveComponent.get(scope.primitiveId));
    if (!native || !same(env.row(native), p))
      throw apiError("stale_snapshot", "Independent component state differs from complete inventory.");
    if (methods) {
      if (
        typeof p.PrimitiveLock !== "boolean" ||
        typeof p.AddIntoBom !== "boolean" ||
        !["Designator", "UniqueId", "Name", "Manufacturer", "ManufacturerId", "Supplier", "SupplierId"].every(
          (k) => typeof p[k] === "string"
        )
      )
        throw apiError("unverified_inventory", "Public done core fields incomplete; no property setter or write.");
      env.require(native, ["toAsync", "setState_OtherProperty", "done"], "Public awaited component instance path");
    }
    return native;
  }
  return { ...env, guard, snapshot, selected, independent };
}
const count = (state: Row) => ({
  groups: Object.fromEntries(Object.entries(state.inventory.groups).map(([k, v]) => [k, (v as any[]).length])),
  physicalPads: state.inventory.componentPads.length,
  attributes: state.attributes.length
});
const units = {
  format: "legacy_tuple9",
  linearUnits: "mil",
  angleUnits: "degrees",
  order: ["dx", "dy", "dz", "rz", "rx", "ry", "tx", "ty", "tz"],
  automaticConversion: false
};
export async function readPcb3dTransform(api: () => EasyEdaApi, params: Row) {
  const scope = input(params),
    env = environment(api, scope),
    state = await env.snapshot();
  await env.independent(state);
  const p = env.selected(state);
  return {
    target: await env.guard(),
    scope,
    component: p,
    currentTupleRaw: p.OtherProperty[KEY],
    currentTuple: parseNative3dTuple(p.OtherProperty[KEY]),
    modelRef: p.Model3D,
    footprintRef: p.Footprint,
    pads: state.inventory.componentPads.filter((p: Row) => p.OwnerComponentId === scope.primitiveId),
    counts: count(state),
    units,
    readOnly: true,
    noCadWrite: true,
    native3dExportVerified: false
  };
}
export async function preparePcb3dTransform(api: () => EasyEdaApi, params: Row) {
  if (extensionMutations.getExecutionState().lockHeld)
    throw apiError("mutation_busy", "Original native executor is still active; no 3D mutation staged.");
  const op = input(params, true),
    env = environment(api, op),
    target = await env.guard(),
    before = await env.snapshot(),
    p = env.selected(before);
  if (
    p.OtherProperty[KEY] !== op.expectedOldTuple ||
    !same(p.Model3D, op.expectedModelRef) ||
    !same(p.Footprint, op.expectedFootprintRef)
  )
    throw apiError("stale_snapshot", "Reviewed old tuple/model/footprint differs from native baseline.");
  await env.independent(before, true);
  await env.guard();
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: ACTION,
    target,
    operation: op,
    before: packed(before),
    previewBefore: { component: p, counts: count(before), proofEncoding: PCB_PRESERVATION_ENCODING },
    requestedAfter: {
      primitiveId: op.primitiveId,
      property: KEY,
      expectedOldTuple: op.expectedOldTuple,
      newTuple: op.newTuple,
      newTupleRaw: op.newTuple.join(","),
      modelRef: p.Model3D,
      footprintRef: p.Footprint,
      units,
      native3dExportVerified: false
    },
    changedKeys: [`OtherProperty.${KEY}`],
    scope: `pcb:3d-transform:${op.projectId}:${op.pcbUuid}:${op.primitiveId}`,
    impact:
      "Change exactly one existing component 3D transform attribute through public awaited instance.done; preserve every other native property/BOM/model/footprint/pose/pad-net and geometry. No library edits, Source API, unit/sign inference, replay or automatic rollback. Separate saved archive and native3D20-pin/height proof required.",
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executePcb3dTransform(api: () => EasyEdaApi, record: any) {
  const op = input(record.operation, true),
    env = environment(api, op);
  if (
    record.domain !== "pcb" ||
    record.action !== ACTION ||
    record.target?.projectId !== op.projectId ||
    record.target?.documentId !== op.pcbUuid
  )
    throw apiError("invalid_params", "3D mutation identity mismatch.");
  const original = unpacked(record.before),
    before = await env.snapshot();
  if (!sameState(original, before))
    throw apiError("stale_snapshot", "Full native PCB/attributes/board scope changed; no write.");
  const p = env.selected(before);
  if (
    p.OtherProperty[KEY] !== op.expectedOldTuple ||
    !same(p.Model3D, op.expectedModelRef) ||
    !same(p.Footprint, op.expectedFootprintRef)
  )
    throw apiError("stale_snapshot", "Expected3D baseline/reference changed; no write.");
  const native = await env.independent(before, true),
    expected = unpacked(packed(before)),
    raw = op.newTuple.join(",");
  env.selected(expected).OtherProperty[KEY] = raw;
  let dispatched = false,
    sdkPending = false;
  const journal = () =>
    extensionMutations.recordExecutionEvidence(record.mutationId, {
      method: "public_component_instance_done",
      primitiveId: op.primitiveId,
      property: KEY,
      dispatched,
      sdkPending,
      nativeOriginalPromiseSettled: dispatched && !sdkPending,
      automaticReplay: false
    });
  try {
    await env.guard();
    env.ensure();
    const instance = native.toAsync();
    if (instance !== native || native.setState_OtherProperty({ [KEY]: raw }) !== native)
      throw new Error("Public async setter acknowledgment changed; no done dispatched.");
    dispatched = true;
    sdkPending = true;
    journal();
    try {
      const returned = await native.done();
      if (returned?.getState_PrimitiveId?.() !== op.primitiveId)
        throw new Error("Native done returned no exact component ID.");
    } finally {
      sdkPending = false;
      journal();
    }
    const after = await env.snapshot();
    if (!sameState(expected, after))
      throw new Error(
        "One-property exact delta or full kept field/BOM/FP/model/pad-net/geometry preservation unconfirmed."
      );
    await env.independent(after);
    await env.guard();
    return {
      executed: true,
      readback: {
        verified: true,
        primitiveId: op.primitiveId,
        property: KEY,
        beforeTuple: op.expectedOldTuple,
        afterTuple: raw,
        modelRef: p.Model3D,
        footprintRef: p.Footprint,
        onlyOnePropertyChanged: true,
        allOtherNativeFieldsPreserved: true,
        counts: count(after),
        units,
        saved: false,
        persistenceVerified: false,
        native3dExportVerified: false,
        modelPoseVerified: false
      }
    };
  } catch (error) {
    if (!dispatched) throw error;
    throw apiError(
      "write_readback_unknown",
      `3D transform outcome unknown; never replay/rollback automatically. ${String(error)}`,
      { primitiveId: op.primitiveId, property: KEY, sdkPending }
    );
  }
}
