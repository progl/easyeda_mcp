import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { pcbToNative, pcbUnits } from "../pcbUnits.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";

type Annotation = {
  kind: "text" | "rectangle";
  layer: number;
  x: number;
  y: number;
  lineWidth: number;
  text?: string;
  fontSize?: number;
  width?: number;
  height?: number;
};
const allowedLayers = [3, 4, 13];
const ownedAnnotations = new Map<string, { kind: string; creationMutationId: string; snapshot: Record<string, any> }>();
const ownershipKey = (target: any, id: string) => `${target.projectId ?? ""}::${target.documentId}::${id}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
async function getAnnotation(native: any, id: string) {
  if (typeof native?.get === "function") return native.get(id);
  if (typeof native?.getAll === "function")
    return (await native.getAll()).find((p: any) => p?.getState_PrimitiveId?.() === id);
  throw apiError("api_unavailable", "Annotation independent get/getAll is required.");
}
async function snapshotAnnotation(native: any, kind: string, id: string) {
  const read = await getAnnotation(native, id);
  if (!read || read.getState_PrimitiveId?.() !== id) throw apiError("not_found", "Native annotation ID not found.");
  const out: Record<string, any> = { primitiveId: id };
  const required =
    kind === "text" ? ["Layer", "X", "Y", "Text", "FontSize", "LineWidth"] : ["Layer", "Net", "LineWidth"];
  const optional =
    kind === "text"
      ? ["FontFamily", "AlignMode", "Rotation", "Reverse", "Expansion", "Mirror", "PrimitiveLock", "PrimitiveType"]
      : ["PrimitiveLock", "PrimitiveType"];
  for (const k of required) {
    if (typeof read[`getState_${k}`] !== "function")
      throw apiError("unverified_annotation", `Missing native ${k} getter.`);
    out[k] = read[`getState_${k}`]();
  }
  for (const k of optional) if (typeof read[`getState_${k}`] === "function") out[k] = read[`getState_${k}`]();
  if (!allowedLayers.includes(out.Layer) || (kind !== "text" && out.Net !== ""))
    throw apiError("invalid_selection", "Only silkscreen/document String or empty-net Polyline may be edited.");
  if (kind === "rectangle") {
    out.PolygonSource = read.getState_Polygon?.()?.getSource?.();
    if (!Array.isArray(out.PolygonSource))
      throw apiError("unverified_annotation", "Native Polyline polygon unavailable.");
  }
  if (Object.values(out).some((v) => typeof v === "number" && !Number.isFinite(v)))
    throw apiError("unverified_annotation", "Nonfinite native annotation snapshot.");
  return JSON.parse(canonicalJson(out));
}
function editProperties(params: Record<string, any>, before: Record<string, any>) {
  const props = params.properties;
  if (!isRecord(props) || !Object.keys(props).length)
    throw apiError("invalid_params", "Modify requires nonempty properties.");
  const text = params.kind === "text",
    allowed = text
      ? ["x", "y", "text", "fontSize", "lineWidth", "layer", "rotation"]
      : ["x", "y", "width", "height", "lineWidth", "layer"];
  if (Object.keys(props).some((k) => !allowed.includes(k)))
    throw apiError("invalid_params", "Unsupported annotation edit property; copper/net writes are forbidden.");
  const native: Record<string, any> = {},
    expected = { ...before };
  for (const [k, v] of Object.entries(props)) {
    if (k === "layer") {
      if (!allowedLayers.includes(v as number)) throw apiError("invalid_params", "Forbidden annotation layer.");
      native.layer = v;
      expected.Layer = v;
    } else if (k === "text") {
      if (typeof v !== "string" || !v.trim() || v.length > 1000)
        throw apiError("invalid_params", "Invalid annotation text.");
      native.text = v;
      expected.Text = v;
    } else {
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        (["width", "height", "fontSize", "lineWidth"].includes(k) && v <= 0)
      )
        throw apiError("invalid_params", `Invalid annotation ${k}.`);
      const converted = k === "rotation" ? v : pcbToNative(v, pcbUnits(params.units));
      if (!Number.isFinite(converted)) throw apiError("invalid_params", "Annotation numeric overflow.");
      if (text || ["lineWidth"].includes(k)) {
        native[k] = converted;
        expected[k[0].toUpperCase() + k.slice(1)] = converted;
      }
    }
  }
  if (!text && ["x", "y", "width", "height"].some((k) => k in props)) {
    const p = before.PolygonSource;
    if (
      !Array.isArray(p) ||
      p.length !== 11 ||
      p[2] !== "L" ||
      ![0, 1, 3, 4, 5, 6, 7, 8, 9, 10].every((i) => typeof p[i] === "number" && Number.isFinite(p[i])) ||
      p[0] !== p[9] ||
      p[1] !== p[10] ||
      p[0] !== p[7] ||
      p[1] !== p[4] ||
      p[3] !== p[5] ||
      p[6] !== p[8]
    )
      throw apiError("invalid_selection", "Only a native rectangular annotation may resize or move.");
    const convert = (k: string, fallback: number) =>
      k in props ? pcbToNative(Number(props[k]), pcbUnits(params.units)) : fallback;
    const x = convert("x", p[0]),
      y = convert("y", p[1]),
      w = convert("width", p[3] - p[0]),
      h = convert("height", p[6] - p[1]);
    if (w <= 0 || h <= 0 || ![x, y, w, h, x + w, y + h].every(Number.isFinite))
      throw apiError("invalid_params", "Invalid rectangle extent.");
    expected.PolygonSource = [x, y, "L", x + w, y, x + w, y + h, x, y + h, x, y];
    native.polygonSource = expected.PolygonSource;
  }
  return { native, expected };
}
async function prepareAnnotationEdit(api: () => EasyEdaApi, params: Record<string, any>) {
  if (
    !["modify", "delete"].includes(params.action) ||
    !["text", "rectangle"].includes(params.kind) ||
    typeof params.primitiveId !== "string" ||
    !params.primitiveId.trim() ||
    params.items !== undefined
  )
    throw apiError(
      "invalid_params",
      "Edit requires explicit action, kind and primitiveId; items belongs to create only."
    );
  const eda = api(),
    current = await target(eda, params.target),
    id = params.primitiveId;
  const key = ownershipKey(current, id);
  let owner = ownedAnnotations.get(key);
  const receipt = params.originalCreationReceipt;
  if (!owner && receipt !== undefined) {
    if (
      !isRecord(receipt) ||
      receipt.status !== "applied" ||
      receipt.action !== "createAnnotations" ||
      typeof receipt.mutationId !== "string" ||
      !receipt.mutationId ||
      !isRecord(receipt.target) ||
      !isRecord(receipt.after) ||
      !Array.isArray(receipt.after.primitives) ||
      receipt.after.primitives.length > 100
    )
      throw apiError(
        "ownership_unverified",
        "Legacy receipt must be the complete applied createAnnotations mutation record."
      );
    if (
      receipt.target.documentId !== current.documentId ||
      (current.projectId && receipt.target.projectId !== current.projectId)
    )
      throw apiError("ownership_unverified", "Legacy receipt must identify this exact native PCB/project.");
    assertDocumentTargetMatch(receipt.target, current);
    const proofs = receipt.after.primitives.filter((p: any) => p?.primitiveId === id);
    const proof = proofs[0];
    const required =
      params.kind === "text"
        ? ["Layer", "X", "Y", "Text", "FontSize", "LineWidth"]
        : ["Layer", "Net", "PolygonSource", "LineWidth"];
    if (proofs.length !== 1 || required.some((k) => !Object.prototype.hasOwnProperty.call(proof, k)))
      throw apiError("ownership_unverified", "Receipt does not uniquely prove this annotation kind/ID.");
    const actual = await snapshotAnnotation(primitiveApi(eda, params.kind), params.kind, id);
    if (Object.entries(proof).some(([k, v]) => !equal(actual[k], v)))
      throw apiError(
        "ownership_unverified",
        "Legacy receipt differs from current native annotation; no adoption or write."
      );
    owner = { kind: params.kind, creationMutationId: receipt.mutationId, snapshot: actual };
    ownedAnnotations.set(key, owner);
  }
  if (!owner || owner.kind !== params.kind)
    throw apiError(
      "ownership_unverified",
      "Annotation is not tool-owned; supply its original applied createAnnotations receipt for legacy IDs."
    );
  const native = primitiveApi(eda, params.kind);
  if (typeof native?.[params.action] !== "function")
    throw apiError("api_unavailable", `Native annotation ${params.action} unavailable.`);
  const before = await snapshotAnnotation(native, params.kind, id);
  if (!equal(before, owner.snapshot))
    throw apiError(
      "ownership_unverified",
      "Owned annotation differs from last verified tool snapshot; inspect changes before editing."
    );
  const patch = params.action === "modify" ? editProperties(params, before) : undefined;
  if (params.action === "delete" && params.properties !== undefined)
    throw apiError("invalid_params", "Delete cannot include properties.");
  if (patch?.native.polygonSource && typeof eda.pcb_MathPolygon?.createPolygon !== "function")
    throw apiError("api_unavailable", "Native polygon constructor required.");
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: params.action === "modify" ? "modifyAnnotations" : "deleteAnnotations",
    target: current,
    operation: {
      annotationAction: params.action,
      kind: params.kind,
      primitiveId: id,
      patch: patch?.native,
      expected: patch?.expected
    },
    before,
    requestedAfter: params.action === "delete" ? { primitiveId: id, exists: false } : patch!.expected,
    changedKeys: params.action === "delete" ? ["deletedAnnotation"] : Object.keys(params.properties),
    scope: `pcb:annotation:${id}`,
    impact: `${params.action} one explicitly owned non-electrical ${params.kind}; no copper or netlist writes.`,
    ttlMs: 300000
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
async function executeAnnotationEdit(api: () => EasyEdaApi, record: any) {
  const eda = api(),
    op = record.operation,
    native = primitiveApi(eda, op.kind);
  await target(eda, record.target);
  if (!ownedAnnotations.has(ownershipKey(record.target, op.primitiveId)))
    throw apiError("ownership_unverified", "Annotation ownership unavailable; no write.");
  const before = await snapshotAnnotation(native, op.kind, op.primitiveId);
  if (!equal(before, record.before)) throw apiError("stale_snapshot", "Annotation changed since preview; no write.");
  const patch = { ...op.patch };
  if (patch.polygonSource) {
    patch.polygon = eda.pcb_MathPolygon.createPolygon(patch.polygonSource);
    delete patch.polygonSource;
    if (!patch.polygon) throw apiError("invalid_params", "Native polygon rejected before write.");
  }
  await target(eda, record.target);
  let verifiedAfter: Record<string, any> | undefined;
  try {
    if (op.annotationAction === "delete") {
      if ((await native.delete([op.primitiveId])) !== true) throw new Error("Native delete did not confirm true.");
      if (await getAnnotation(native, op.primitiveId))
        throw new Error("Deleted annotation remains in native readback.");
      ownedAnnotations.delete(ownershipKey(record.target, op.primitiveId));
    } else {
      await native.modify(op.primitiveId, patch);
      const after = await snapshotAnnotation(native, op.kind, op.primitiveId);
      verifiedAfter = after;
      const expected = op.expected;
      for (const [k, v] of Object.entries(expected)) {
        const actual = after[k];
        const compare = (a: any, b: any) =>
          typeof b === "number"
            ? typeof a === "number" && Math.abs(a - b) <= (["X", "Y", "FontSize"].includes(k) ? 0.05 : 1e-6)
            : equal(a, b);
        if (!compare(actual, v)) throw new Error(`Annotation native ${k} readback mismatch.`);
      }
    }
    await target(eda, record.target);
    const finalSnapshot =
      op.annotationAction === "modify" ? await snapshotAnnotation(native, op.kind, op.primitiveId) : undefined;
    if (finalSnapshot) {
      if (!equal(finalSnapshot, verifiedAfter)) throw new Error("Annotation changed during final readback.");
      const owner = ownedAnnotations.get(ownershipKey(record.target, op.primitiveId))!;
      ownedAnnotations.set(ownershipKey(record.target, op.primitiveId), { ...owner, snapshot: finalSnapshot });
    }
    return {
      executed: true,
      readback: {
        action: op.annotationAction,
        primitiveId: op.primitiveId,
        verified: true,
        units: "mil",
        ...(op.annotationAction === "modify" ? { after: finalSnapshot } : { deleted: true })
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Annotation ${op.annotationAction} unknown; never replay automatically. ${String(error)}`,
      { primitiveId: op.primitiveId, mutationId: record.mutationId }
    );
  }
}

function parseItems(params: Record<string, any>): Annotation[] {
  const units = pcbUnits(params.units);
  if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100)
    throw apiError("invalid_params", "items must contain 1–100 annotations.");
  return params.items.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      !["text", "rectangle"].includes(String(raw.kind)) ||
      !allowedLayers.includes(raw.layer as number)
    )
      throw apiError("invalid_params", "Only text/rectangle on layers 3, 4, 13 are allowed.");
    const keys = [
      "kind",
      "layer",
      "x",
      "y",
      "lineWidth",
      ...(raw.kind === "text" ? ["text", "fontSize"] : ["width", "height"])
    ];
    if (Object.keys(raw).some((k) => !keys.includes(k)))
      throw apiError("invalid_params", "Unsupported annotation property.");
    const item: any = { kind: raw.kind, layer: raw.layer };
    for (const key of keys.filter((k) => !["kind", "layer", "text"].includes(k))) {
      const value = raw[key];
      if (typeof value !== "number" || !Number.isFinite(value) || (!["x", "y"].includes(key) && value <= 0))
        throw apiError(
          "invalid_params",
          `${key} must be a finite ${["x", "y"].includes(key) ? "number" : "positive number"}.`
        );
      item[key] = pcbToNative(value, units);
    }
    if (raw.kind === "text") {
      if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 1000)
        throw apiError("invalid_params", "text must contain 1–1000 characters.");
      item.text = raw.text;
    }
    if (item.kind === "rectangle" && ![item.x + item.width, item.y + item.height].every(Number.isFinite))
      throw apiError("invalid_params", "Rectangle extent overflow.");
    if (!Object.values(item).every((v) => typeof v !== "number" || Number.isFinite(v)))
      throw apiError("invalid_params", "Annotation conversion overflow.");
    return item;
  });
}
async function target(eda: EasyEdaApi, expected?: Record<string, unknown>) {
  const current = extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  if (current.documentType !== "pcb" || !current.documentId)
    throw apiError("invalid_target_type", "An identifiable active PCB is required.");
  if (expected) assertDocumentTargetMatch(expected, current);
  return current;
}
function primitiveApi(eda: EasyEdaApi, kind: string) {
  return kind === "text" ? eda.pcb_PrimitiveString : eda.pcb_PrimitivePolyline;
}
export async function preparePcbAnnotationMutation(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  const action = params.action ?? "create";
  if (action !== "create") return prepareAnnotationEdit(api, { ...params, action });
  if (params.primitiveId !== undefined || params.properties !== undefined)
    throw apiError("invalid_params", "Create uses items only.");
  const items = parseItems(params),
    eda = api();
  const current = await target(eda, params.target);
  for (const item of items) {
    const native = primitiveApi(eda, item.kind);
    if (
      typeof native?.create !== "function" ||
      (typeof native?.get !== "function" && typeof native?.getAll !== "function")
    )
      throw apiError(
        "api_unavailable",
        "Annotation creation requires native create plus independent get/getAll readback."
      );
    if (item.kind === "rectangle" && typeof eda.pcb_MathPolygon?.createPolygon !== "function")
      throw apiError("api_unavailable", "Graphical rectangles require pcb_MathPolygon.createPolygon.");
  }
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: "createAnnotations",
    target: current,
    operation: { items },
    before: { exists: false },
    requestedAfter: { units: "mil", items },
    changedKeys: ["annotations"],
    scope: "pcb:non-electrical-annotations",
    impact: `Creates ${items.length} annotations only on silkscreen/document layers; rectangles are unfilled closed empty-net polylines.`,
    ttlMs: 5 * 60_000
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
async function readCreated(native: any, created: any, expected: Record<string, unknown>) {
  const primitiveId = created?.getState_PrimitiveId?.();
  if (typeof primitiveId !== "string" || !primitiveId)
    throw apiError(
      "readback_failed",
      "Created annotation ID unavailable; outcome unknown. Do not replay automatically."
    );
  const read =
    typeof native.get === "function"
      ? await native.get(primitiveId)
      : (await native.getAll()).find((p: any) => p?.getState_PrimitiveId?.() === primitiveId);
  const actual: Record<string, unknown> = { primitiveId };
  if (!read || read.getState_PrimitiveId?.() !== primitiveId)
    throw apiError("readback_failed", `Annotation ${primitiveId} readback missing; do not replay automatically.`);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "PolygonSource") {
      const source = read.getState_Polygon?.()?.getSource?.();
      actual[key] = source;
      if (
        !Array.isArray(source) ||
        !Array.isArray(value) ||
        source.length !== value.length ||
        !value.every((v, i) =>
          typeof v === "number" ? typeof source[i] === "number" && Math.abs(source[i] - v) <= 1e-6 : source[i] === v
        )
      )
        throw apiError(
          "readback_failed",
          `Annotation ${primitiveId} polygon readback mismatch; do not replay automatically.`
        );
      continue;
    }
    const result = read[`getState_${key}`]?.();
    actual[key] = result;
    if (typeof value === "number" ? typeof result !== "number" || Math.abs(result - value) > 1e-6 : result !== value)
      throw apiError(
        "readback_failed",
        `Annotation ${primitiveId} readback mismatch for ${key}; do not replay automatically.`
      );
  }
  return actual;
}
export async function executePcbAnnotationMutation(
  api: () => EasyEdaApi,
  record: any
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  if (record.operation.annotationAction) return executeAnnotationEdit(api, record);
  const eda = api();
  await target(eda, record.target);
  const items = parseItems({ items: record.operation.items, units: "mil" });
  const primitives: Record<string, unknown>[] = [];
  let writeStarted = false;
  try {
    for (const item of items) {
      await target(eda, record.target);
      const native = primitiveApi(eda, item.kind);
      if (item.kind === "text") {
        // Installed SDK positional contract: default font, bottom-left alignment (3), no reversal/mirroring.
        writeStarted = true;
        const created = await native.create(
          item.layer,
          item.x,
          item.y,
          item.text,
          "default",
          item.fontSize,
          item.lineWidth,
          3,
          0,
          false,
          0,
          false,
          false
        );
        primitives.push(
          await readCreated(native, created, {
            Layer: item.layer,
            X: item.x,
            Y: item.y,
            Text: item.text,
            FontSize: item.fontSize,
            LineWidth: item.lineWidth
          })
        );
      } else {
        const x2 = item.x + item.width!,
          y2 = item.y + item.height!;
        const source = [item.x, item.y, "L", x2, item.y, x2, y2, item.x, y2, item.x, item.y];
        const polygon = eda.pcb_MathPolygon.createPolygon(source);
        if (!polygon) throw apiError("invalid_params", "Native SDK rejected the graphical rectangle before writing.");
        writeStarted = true;
        const created = await native.create("", item.layer, polygon, item.lineWidth, false);
        primitives.push(
          await readCreated(native, created, {
            Net: "",
            Layer: item.layer,
            PolygonSource: source,
            LineWidth: item.lineWidth
          })
        );
      }
      const verified = primitives.at(-1)!;
      ownedAnnotations.set(ownershipKey(record.target, String(verified.primitiveId)), {
        kind: item.kind,
        creationMutationId: record.mutationId,
        snapshot: await snapshotAnnotation(native, item.kind, String(verified.primitiveId))
      });
    }
    await target(eda, record.target);
    return { executed: true, readback: { units: "mil", primitives } };
  } catch (error) {
    if (!writeStarted) throw error;
    throw apiError(
      "write_readback_unknown",
      `Annotation outcome uncertain: ${error instanceof Error ? error.message : String(error)}. Do not replay automatically.`,
      { verifiedPrimitives: primitives }
    );
  }
}
