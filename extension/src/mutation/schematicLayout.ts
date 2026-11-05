import { compareSchematicSnapshots, type SheetMetadataDiff } from "./schematicSnapshotDiff.js";
import { getBoardInventory } from "./boardOperations.js";
import { apiError, isRecord, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { parseNativeNetlist } from "../../../src/schematic/nativeNetlist.js";
import { collectNativeNetlist, validateNativeNetlistTimeoutMs } from "../handlers/nativeNetlist.js";
import { extensionMutations } from "./mutationManager.js";
import { readPage } from "./schematicPages.js";
import {
  annotationProperties,
  readSchematicAttributes,
  restoreSchematicAttributes,
  schematicAttributeBackendPatch
} from "./schematicAttributes.js";
import {
  blockWireSegments as segments,
  blockTouches as touches,
  blockIntersects as intersects
} from "./schematicBlockTransfer.js";
import type { EasyEdaApi } from "../types.js";
import { findWireById, wireReadbackData } from "./schematicWireMutations.js";
import { getSchematicAttributeInventory } from "../handlers/schematicAttributeInventory.js";
import { guardedSchematicApi } from "./schematicExecutionGuard.js";
import { buildSafeWireOrder } from "./schematicWireOrder.js";

const sortIds = (items: any[]) => items.sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw apiError("invalid_params", `${label} must be finite.`);
  return value;
}
function prop(item: any, key: string, alternate?: string) {
  const fn = item?.[`getState_${key[0].toUpperCase() + key.slice(1)}`];
  if (typeof fn === "function") return fn.call(item);
  if (item && key in item) return item[key];
  return alternate ? item?.[alternate] : undefined;
}
function shapeRecord(item: any, type: "text" | "rectangle") {
  const keys =
    type === "text"
      ? [
          "primitiveId",
          "x",
          "y",
          "content",
          "rotation",
          "textColor",
          "fontName",
          "fontSize",
          "bold",
          "italic",
          "underLine",
          "alignMode"
        ]
      : [
          "primitiveId",
          "topLeftX",
          "topLeftY",
          "width",
          "height",
          "cornerRadius",
          "rotation",
          "color",
          "fillColor",
          "lineWidth",
          "lineType",
          "fillStyle"
        ];
  return Object.fromEntries(
    keys
      .map((key) => [key, prop(item, key, key === "topLeftX" ? "x" : key === "topLeftY" ? "y" : undefined)])
      .filter(([, value]) => value !== undefined)
  );
}
async function decorations(api: () => EasyEdaApi, strict = false) {
  const eda = api();
  const texts = await eda.sch_PrimitiveText?.getAll?.();
  const rectangles = await eda.sch_PrimitiveRectangle?.getAll?.();
  if (strict && (!Array.isArray(texts) || !Array.isArray(rectangles)))
    throw apiError("unverified_inventory", "Complete native current-page text and rectangle arrays required.");
  return {
    texts: sortIds(toArray(texts).map((v) => shapeRecord(v, "text"))),
    rectangles: sortIds(toArray(rectangles).map((v) => shapeRecord(v, "rectangle")))
  };
}
async function sheetState(api: () => EasyEdaApi) {
  const data = await readPage(api);
  return { components: sortIds(data.components), wires: sortIds(data.wires) };
}
async function targetMatches(api: () => EasyEdaApi, target: DocumentIdentity) {
  assertDocumentTargetMatch(target, extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo()));
}
function requireMethods(eda: EasyEdaApi, methods: Array<[string, string]>) {
  for (const [owner, name] of methods)
    if (typeof eda[owner]?.[name] !== "function")
      throw apiError("capability_unavailable", `Required API ${owner}.${name} is unavailable; no writes started.`);
}
function prepared(record: MutationRecord) {
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: record.action,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt,
    units: "10mil"
  };
}

export async function prepareSchematicAnnotation(
  api: () => EasyEdaApi,
  params: Record<string, any>,
  target: DocumentIdentity
) {
  const annotationAction = params.action ?? "create";
  if (params.persistenceMode !== undefined && params.persistenceMode !== "legacy32TransactionalTextReplace")
    throw apiError("invalid_params", "Unknown annotation persistenceMode.");
  if (annotationAction === "create" && params.persistenceMode !== undefined)
    throw apiError("invalid_params", "Compatibility persistenceMode applies only to explicit modify/delete.");
  if (annotationAction === "modify" || annotationAction === "delete") return prepareAnnotationEdit(api, params, target);
  if (annotationAction !== "create")
    throw apiError("invalid_params", "Annotation action must be create, modify or delete.");
  if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100)
    throw apiError("invalid_params", "annotation.items must contain 1 to 100 text/rectangle items.");
  const items = params.items.map((v: any) => {
    if (!isRecord(v) || !["text", "rectangle"].includes(String(v.type)))
      throw apiError("invalid_params", "Annotation type must be text or rectangle.");
    const x = number(v.x, "x"),
      y = number(v.y, "y");
    if (v.type === "text") {
      if (typeof v.text !== "string" || !v.text.trim() || v.text.length > 2000)
        throw apiError("invalid_params", "Annotation text must contain 1 to 2000 characters.");
      const fontSize = number(v.fontSize ?? 12, "fontSize");
      if (fontSize <= 0 || fontSize > 100)
        throw apiError("invalid_params", "fontSize must be positive and at most 100 native 10mil units.");
      return { type: "text", x, y, text: v.text, fontSize, bold: Boolean(v.bold), color: v.color ?? null };
    }
    const width = number(v.width, "width"),
      height = number(v.height, "height"),
      lineWidth = number(v.lineWidth ?? 1, "lineWidth");
    if (width <= 0 || height <= 0 || lineWidth < 1 || lineWidth > 10)
      throw apiError("invalid_params", "Rectangle dimensions must be positive; lineWidth must be 1 to 10.");
    return { type: "rectangle", x, y, width, height, lineWidth, color: v.color ?? null };
  });
  for (const type of new Set(items.map((item) => item.type)))
    requireMethods(api(), [
      [type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle", "getAll"],
      [type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle", "create"]
    ]);
  const before = { electrical: await sheetState(api), decorations: await decorations(api) };
  const existing = (item: any) =>
    item.type === "text"
      ? before.decorations.texts.some((t) => t.x === item.x && t.y === item.y && t.content === item.text)
      : before.decorations.rectangles.some(
          (r) => r.topLeftX === item.x && r.topLeftY === item.y && r.width === item.width && r.height === item.height
        );
  if (items.some(existing) || new Set(items.map((item) => canonicalJson(item))).size !== items.length)
    throw apiError(
      "annotation_already_exists",
      "Duplicate annotation or an identical annotation already exists; inspect before preparing another batch."
    );
  await targetMatches(api, target);
  return prepared(
    extensionMutations.prepare({
      domain: "schematic",
      action: "annotateSchematic",
      target,
      operation: { action: "annotateSchematic", items, before },
      before: { pageId: target.documentId, itemCount: 0 },
      requestedAfter: { pageId: target.documentId, items },
      scope: `page:${target.documentId}`,
      impact: `Creates ${items.length} non-electrical text/rectangle annotations; no components or wires are changed.`,
      ttlMs: 15 * 60_000
    })
  );
}
function annotationMatches(item: any, actual: any) {
  if (!actual) return false;
  const wanted =
    item.type === "text"
      ? { x: item.x, y: item.y, content: item.text, fontSize: item.fontSize, bold: item.bold }
      : {
          topLeftX: item.x,
          topLeftY: item.y,
          width: item.width,
          height: item.height,
          fillColor: "none",
          lineWidth: item.lineWidth
        };
  return Object.entries(wanted).every(([key, value]) =>
    typeof value === "number"
      ? typeof actual[key] === "number" && Math.abs(actual[key] - value) < 1e-8
      : actual[key] === value
  );
}
export async function executeSchematicAnnotation(record: MutationRecord, api: () => EasyEdaApi) {
  if (["modify", "delete"].includes(String(record.operation.annotationAction)))
    return executeAnnotationEdit(record, api);
  const execution = guardedSchematicApi(api, record.target);
  api = execution.api;
  const op = record.operation as any;
  await targetMatches(api, record.target);
  if (!same(op.before, { electrical: await sheetState(api), decorations: await decorations(api) }))
    throw apiError("stale_mutation", "Page or annotations changed after preview.");
  for (const type of new Set(op.items.map((item: any) => item.type)))
    requireMethods(api(), [
      [type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle", "create"],
      [type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle", "getAll"]
    ]);
  const journal: Array<{ id: string; type: string }> = [];
  try {
    for (const item of op.items) {
      const created =
        item.type === "text"
          ? await api().sch_PrimitiveText.create(
              item.x,
              item.y,
              item.text,
              0,
              item.color,
              null,
              item.fontSize,
              item.bold,
              false,
              false,
              1
            )
          : await api().sch_PrimitiveRectangle.create(
              item.x,
              item.y,
              item.width,
              item.height,
              0,
              0,
              item.color,
              "none",
              item.lineWidth,
              0
            );
      const id = prop(created, "primitiveId");
      if (!id) throw new Error("Annotation creation returned no primitive ID.");
      journal.push({ id: String(id), type: item.type });
    }
    const deadline = Date.now() + 1500;
    while (true) {
      const actual = await decorations(api);
      if (
        journal.every((entry, index) =>
          annotationMatches(
            op.items[index],
            (entry.type === "text" ? actual.texts : actual.rectangles).find((a) => a.primitiveId === entry.id)
          )
        )
      )
        break;
      if (Date.now() >= deadline)
        throw new Error("Native annotation readback did not confirm the requested content/geometry/font.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!same(op.before.electrical, await sheetState(api)))
      throw new Error("Electrical primitives changed during annotation creation.");
    await targetMatches(api, record.target);
    return {
      executed: true,
      readback: { verified: true, units: "10mil", electricalPrimitivesUnchanged: true, journal, saved: false }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Annotation batch incomplete. Do not replay. Journal=${JSON.stringify(journal)}. ${String(error)}`
    );
  }
}

// Explicit existing-decoration edits use only current-page public primitives.
// No write promise is raced: lifecycle retains its lock until SDK settlement.
function annotationId(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32)
  )
    throw apiError("invalid_params", `Explicit ${label} required.`);
  return value;
}
async function annotationEditScope(api: () => EasyEdaApi, params: any, target: DocumentIdentity) {
  if (
    !isRecord(params.target) ||
    !params.target.projectId ||
    !params.target.documentId ||
    params.target.documentType !== "schematic"
  )
    throw apiError(
      "invalid_params",
      "Annotation modify/delete requires explicit annotation.target projectId/documentId/documentType."
    );
  assertDocumentTargetMatch(params.target, target);
  await targetMatches(api, target);
  let compatibilityVersion: string | undefined;
  if (params.persistenceMode === "legacy32TransactionalTextReplace") {
    requireMethods(api(), [["sys_Environment", "getEditorCurrentVersion"]]);
    compatibilityVersion = await api().sys_Environment.getEditorCurrentVersion(true);
    if (compatibilityVersion !== "3.2.209")
      throw apiError(
        "capability_unavailable",
        "Text transaction compatibility is pinned to reviewed legacy editor 3.2.209; no fallback."
      );
  }
  const expectedBoardName = annotationId(params.expectedBoardName, "expectedBoardName");
  const protectedBoardName = annotationId(params.protectedBoardName, "protectedBoardName");
  const inventory = await getBoardInventory(api, { projectId: target.projectId, target });
  const board = inventory.boards.find((b) => b.name === expectedBoardName);
  if (
    !board ||
    expectedBoardName === protectedBoardName ||
    !inventory.boards.some((b) => b.name === protectedBoardName) ||
    inventory.currentBoardName !== expectedBoardName ||
    !board.schematic.pages.some((p) => p.uuid === target.documentId)
  )
    throw apiError("invalid_target", "Current page must belong to the explicit non-protected board.");
  return {
    ...(compatibilityVersion ? { compatibilityVersion } : {}),
    documentId: target.documentId,
    boardName: board.name,
    schematicUuid: board.schematic.uuid,
    projectId: inventory.projectId,
    boards: inventory.boards
  };
}
export function compareAnnotationStates(expected: any, observed: any, documentId: string) {
  const a = JSON.parse(canonicalJson(expected)),
    b = JSON.parse(canonicalJson(observed));
  const derivedMetadataDiffs: SheetMetadataDiff[] = [];
  const ownsPage = (state: any) =>
    state.scope?.documentId === documentId &&
    state.scope?.boards?.some(
      (board: any) =>
        board.name === state.scope.boardName &&
        board.schematic?.uuid === state.scope.schematicUuid &&
        board.schematic.pages?.some((page: any) => page.uuid === documentId)
    );
  const oldFrames = a.electrical?.components?.filter((c: any) => c.componentType === "sheet") ?? [];
  const newFrames = b.electrical?.components?.filter((c: any) => c.componentType === "sheet") ?? [];
  // getAll(undefined,false) is active-page scoped. Require one exact frame and unchanged
  // independently guarded owning/protected-board inventory, never normalize all sheet IDs.
  if (ownsPage(a) && ownsPage(b) && same(a.scope, b.scope) && oldFrames.length === 1 && newFrames.length === 1) {
    const old = oldFrames[0],
      fresh = newFrames[0];
    if (old.primitiveId && old.primitiveId === fresh.primitiveId && old.otherProperty && fresh.otherProperty)
      for (const key of ["@Update Date", "@Update Time"]) {
        const x = old.otherProperty[key],
          y = fresh.otherProperty[key];
        const valid = (v: any) =>
          typeof v === "string" &&
          (key === "@Update Date"
            ? /^\d{4}-\d{2}-\d{2}$/.test(v) &&
              !Number.isNaN(Date.parse(v + "T00:00:00Z")) &&
              new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v
            : /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v));
        if (valid(x) && valid(y) && x !== y) {
          derivedMetadataDiffs.push({
            documentId,
            primitiveId: old.primitiveId,
            componentType: "sheet",
            property: `otherProperty.${key}`,
            before: x,
            after: y
          });
          fresh.otherProperty[key] = x;
        }
      }
  }
  const comparison = compareSchematicSnapshots({ state: a }, { state: b }, documentId);
  return { ...comparison, derivedMetadataDiffs };
}
function annotationDifferenceMessage(comparison: ReturnType<typeof compareAnnotationStates>) {
  return `Differences=${JSON.stringify(comparison.differences)}; derivedMetadataDiffs=${JSON.stringify(comparison.derivedMetadataDiffs)}`;
}
async function annotationEditState(api: () => EasyEdaApi, params: any, target: DocumentIdentity) {
  const scope = await annotationEditScope(api, params, target);
  requireMethods(api(), [
    ["sch_PrimitiveText", "getAll"],
    ["sch_PrimitiveRectangle", "getAll"],
    ["sch_PrimitiveComponent", "getAllPinsByPrimitiveId"]
  ]);
  const rawComponents = await api().sch_PrimitiveComponent.getAll(undefined, false);
  const rawWires = await api().sch_PrimitiveWire.getAll();
  if (!Array.isArray(rawComponents) || !Array.isArray(rawWires))
    throw apiError("unverified_inventory", "Complete native current-page component/wire arrays required.");
  const electrical = {
    components: sortIds(JSON.parse(JSON.stringify(rawComponents))),
    wires: sortIds(JSON.parse(JSON.stringify(rawWires)))
  };
  const pins: any[] = [];
  for (const c of electrical.components.filter((c) => c.componentType === "part")) {
    const nativePins = await api().sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
    if (!Array.isArray(nativePins)) throw apiError("unverified_inventory", "Native component pin list unavailable.");
    for (const pin of nativePins) {
      const primitiveId = annotationId(prop(pin, "primitiveId"), "pin primitiveId");
      const pinNumber = annotationId(String(prop(pin, "pinNumber") ?? ""), "pin number");
      const values = Object.fromEntries(
        ["x", "y", "rotation", "pinName", "pinType", "pinShape", "pinLength", "pinColor"]
          .map((key) => [key, prop(pin, key)])
          .filter(([, value]) => value !== undefined)
      );
      pins.push({
        componentPrimitiveId: c.primitiveId,
        primitiveId,
        pinNumber,
        ...values,
        raw: JSON.parse(JSON.stringify(pin))
      });
    }
  }
  const decor = await decorations(api, true);
  const allIds = [...electrical.components, ...electrical.wires, ...decor.texts, ...decor.rectangles, ...pins].map(
    (v) => annotationId(v.primitiveId, "primitiveId")
  );
  if (new Set(allIds).size !== allIds.length)
    throw apiError("unverified_inventory", "Ambiguous current-page primitive IDs.");
  const native = await collectNativeNetlist(api(), true, 10000);
  if (
    native.status !== "available" ||
    !native.text ||
    !native.scope?.verified ||
    native.ambiguousDesignators?.length ||
    native.scope.projectId !== scope.projectId ||
    native.scope.boardName !== scope.boardName ||
    native.scope.schematicUuid !== scope.schematicUuid
  )
    throw apiError(
      "native_connectivity_unavailable",
      "Verified native current-schematic/project/board connectivity scope required."
    );
  const nets = [...parseNativeNetlist(native.text, native.format)]
    .map(([net, members]) => [net, [...members].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const finalScope = await annotationEditScope(api, params, target);
  if (!same(scope, finalScope)) throw apiError("stale_mutation", "Native annotation scope changed during observation.");
  return JSON.parse(
    canonicalJson({ scope, electrical, pins: sortIds(pins), decorations: decor, native: { scope: native.scope, nets } })
  );
}
export async function getSchematicAnnotationInventory(api: () => EasyEdaApi, params: Record<string, any>) {
  const target = extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo());
  const scope = await annotationEditScope(api, params, target);
  requireMethods(api(), [
    ["sch_PrimitiveText", "getAll"],
    ["sch_PrimitiveRectangle", "getAll"]
  ]);
  const result = await decorations(api, true);
  const ids = [...result.texts, ...result.rectangles].map((v) => annotationId(v.primitiveId, "annotation primitiveId"));
  if (new Set(ids).size !== ids.length) throw apiError("unverified_inventory", "Free annotation IDs are ambiguous.");
  if (!same(scope, await annotationEditScope(api, params, target)))
    throw apiError("stale_mutation", "Annotation inventory scope changed during read.");
  return {
    target,
    scope,
    ...result,
    units: "10mil",
    readOnly: true,
    persistenceVerified: false,
    note: "Current-page free decoration getters only. No mutation staged, CAD write, focus navigation or persisted-file proof."
  };
}
function annotationPatch(item: any) {
  const allowed =
    item.type === "text"
      ? ["text", "x", "y", "fontSize", "bold", "color"]
      : ["x", "y", "width", "height", "lineWidth", "color"];
  if (Object.keys(item).some((key) => !["type", "primitiveId", ...allowed].includes(key)))
    throw apiError(
      "invalid_params",
      "Unknown annotation edit field; only explicit supported non-electrical properties are accepted."
    );
  const patch: Record<string, any> = {};
  for (const key of allowed) {
    if (item[key] === undefined) continue;
    let value = item[key];
    if (key === "text") {
      if (typeof value !== "string" || !value.trim() || value.length > 2000)
        throw apiError("invalid_params", "Annotation text must contain 1 to 2000 characters.");
    } else if (key === "bold") {
      if (typeof value !== "boolean") throw apiError("invalid_params", "bold must be boolean.");
    } else if (key === "color") {
      if (typeof value !== "string" || !value || value.length > 128)
        throw apiError(
          "invalid_params",
          "Explicit nonempty color string required; default/null resets are not supported by edit proof."
        );
    } else {
      value = number(value, key);
      if (
        (["width", "height", "fontSize"].includes(key) && value <= 0) ||
        (key === "fontSize" && value > 100) ||
        (key === "lineWidth" && (value < 1 || value > 10))
      )
        throw apiError("invalid_params", "Annotation dimensions/font/lineWidth are outside the supported range.");
    }
    const nativeKey =
      key === "text"
        ? "content"
        : key === "color" && item.type === "text"
          ? "textColor"
          : key === "x" && item.type === "rectangle"
            ? "topLeftX"
            : key === "y" && item.type === "rectangle"
              ? "topLeftY"
              : key;
    patch[nativeKey] = value;
  }
  if (!Object.keys(patch).length) throw apiError("invalid_params", "At least one explicit modification required.");
  return patch;
}
async function prepareAnnotationEdit(api: () => EasyEdaApi, params: any, target: DocumentIdentity) {
  if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100)
    throw apiError("invalid_params", "annotation.items must contain 1 to 100 explicit IDs.");
  const items = params.items.map((item: any) => {
    if (!isRecord(item) || !["text", "rectangle"].includes(String(item.type)))
      throw apiError("invalid_params", "Explicit text/rectangle type required.");
    const primitiveId = annotationId(item.primitiveId, "annotation primitiveId");
    if (params.action === "delete" && Object.keys(item).some((k) => !["type", "primitiveId"].includes(k)))
      throw apiError("invalid_params", "Deletion accepts only type and primitiveId.");
    const owner = item.type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle";
    if (params.persistenceMode === "legacy32TransactionalTextReplace" && item.type === "text") {
      requireMethods(api(), [["sch_PrimitiveCircle", "delete"]]);
      if (params.action === "modify")
        requireMethods(api(), [
          ["sch_PrimitiveText", "create"],
          ["sch_PrimitiveText", "get"]
        ]);
    } else requireMethods(api(), [[owner, params.action]]);
    return { type: item.type, primitiveId, ...(params.action === "modify" ? { patch: annotationPatch(item) } : {}) };
  });
  if (new Set(items.map((v: any) => v.primitiveId)).size !== items.length)
    throw apiError("invalid_params", "Duplicate annotation IDs refused.");
  const before = await annotationEditState(api, params, target);
  for (const item of items) {
    const actual = (item.type === "text" ? before.decorations.texts : before.decorations.rectangles).find(
      (v: any) => v.primitiveId === item.primitiveId
    );
    if (!actual)
      throw apiError(
        "annotation_not_found",
        "Explicit primitiveId/type must resolve uniquely in current-page free decorations; electrical objects are forbidden."
      );
    if (
      params.persistenceMode === "legacy32TransactionalTextReplace" &&
      params.action === "modify" &&
      item.type === "text"
    ) {
      fullReplacementText({ ...actual, ...item.patch });
      (item as any).createAlignMode = await replacementAlignMode(api, actual);
    }
  }
  return {
    ...prepared(
      extensionMutations.prepare({
        domain: "schematic",
        action: "annotateSchematic",
        target,
        operation: {
          action: "annotateSchematic",
          annotationAction: params.action,
          ...(params.persistenceMode ? { persistenceMode: params.persistenceMode } : {}),
          items,
          guards: {
            target: params.target,
            expectedBoardName: params.expectedBoardName,
            protectedBoardName: params.protectedBoardName,
            ...(params.persistenceMode ? { persistenceMode: params.persistenceMode } : {})
          },
          before
        },
        before,
        requestedAfter: {
          annotationAction: params.action,
          items,
          derivedMetadataDiffs: [],
          ...(params.persistenceMode
            ? {
                persistenceMode: params.persistenceMode,
                persistenceVerified: false,
                note: "Text replacements receive new primitive IDs; persistence requires saved Epro proof."
              }
            : {})
        },
        scope: `page:${target.documentId}`,
        impact: `${params.action} ${items.length} explicit current-page free annotations; all other decorations/electrical primitives and scoped native connectivity must remain unchanged.${params.persistenceMode ? " Explicit runtime-specific 3.2.209 workaround: public Circle.delete([reviewed TEXT ID]) reaches the editor transaction; replacement TEXT gets a new ID. This is outside ordinary Circle type semantics (official issue https://github.com/easyeda/easyeda-api-sdk/issues/36). Reload persisted baseline first; no saved-file/persistence claim, rollback or automatic replay." : " Native in-memory proof only; persistence is not established."}`,
        ttlMs: 300000
      })
    ),
    destructive: params.action === "delete" || params.persistenceMode === "legacy32TransactionalTextReplace"
  };
}
// Bundled 3.2.209 legacy getAllText reports (vAlign + 1) * 2 + hAlign,
// unlike getText/create's 1..9 enum. Values 4 and 6 are ambiguous: never invert them.
async function replacementAlignMode(api: () => EasyEdaApi, original: any) {
  const exact = shapeRecord(await api().sch_PrimitiveText.get(original.primitiveId), "text");
  const alignment = exact.alignMode;
  const rawByEnum = [undefined, 2, 4, 6, 3, 5, 7, 4, 6, 8];
  if (
    !Number.isInteger(alignment) ||
    alignment < 1 ||
    alignment > 9 ||
    !same({ ...exact, alignMode: rawByEnum[alignment] }, original)
  )
    throw apiError(
      "unverified_inventory",
      "Exact TEXT getter/style and legacy inventory alignment disagree; no replacement."
    );
  return alignment;
}
function fullReplacementText(text: any) {
  const keys = [
    "x",
    "y",
    "content",
    "rotation",
    "textColor",
    "fontName",
    "fontSize",
    "bold",
    "italic",
    "underLine",
    "alignMode"
  ];
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(text, key)))
    throw apiError("unverified_inventory", "Complete original text style/coordinates required before replacement.");
  for (const key of ["x", "y", "rotation"]) number(text[key], key);
  if (
    typeof text.content !== "string" ||
    text.content.length > 2000 ||
    !["bold", "italic", "underLine"].every((key) => typeof text[key] === "boolean") ||
    !["textColor", "fontName"].every((key) => text[key] === null || typeof text[key] === "string") ||
    !(
      text.fontSize === null ||
      (typeof text.fontSize === "number" && Number.isFinite(text.fontSize) && text.fontSize > 0 && text.fontSize <= 100)
    ) ||
    !Number.isInteger(text.alignMode) ||
    text.alignMode < 0 ||
    text.alignMode > 9
  )
    throw apiError("unverified_inventory", "Original text style has unsupported or unknown values; no replacement.");
  return Object.fromEntries(keys.map((key) => [key, text[key]]));
}
async function executeAnnotationEdit(record: MutationRecord, api: () => EasyEdaApi) {
  const op = record.operation as any;
  if (record.domain !== "schematic" || record.action !== "annotateSchematic" || !same(record.before, op.before))
    throw apiError("invalid_params", "Complete original explicit annotation edit preview required.");
  const before = await annotationEditState(api, op.guards, record.target);
  const preflight = compareAnnotationStates(op.before, before, String(record.target.documentId));
  if (!preflight.equal)
    throw apiError(
      "stale_mutation",
      `Current-page decorations/electrical state/pins/native scope changed after preview; no write. ${annotationDifferenceMessage(preflight)}`,
      preflight
    );
  const derivedMetadataDiffs = [...preflight.derivedMetadataDiffs];
  const compatibility = op.persistenceMode === "legacy32TransactionalTextReplace";
  for (const item of op.items) {
    if (compatibility && item.type === "text") {
      requireMethods(api(), [["sch_PrimitiveCircle", "delete"]]);
      if (op.annotationAction === "modify")
        requireMethods(api(), [
          ["sch_PrimitiveText", "create"],
          ["sch_PrimitiveText", "get"]
        ]);
    } else
      requireMethods(api(), [
        [item.type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle", op.annotationAction]
      ]);
  }
  const expected = JSON.parse(canonicalJson(before));
  const journal: any[] = [];
  const deadline = Date.now() + 40000;
  const guardWrite = async () => {
    if (Date.now() >= deadline) throw new Error("Annotation edit budget expired; no subsequent write.");
    const scope = await annotationEditScope(api, op.guards, record.target);
    if (!same(scope, before.scope))
      throw new Error("Annotation owning/protected-board scope changed; no subsequent write.");
  };
  try {
    for (const item of op.items) {
      await guardWrite();
      const key = item.type === "text" ? "texts" : "rectangles";
      const old = expected.decorations[key].find((v: any) => v.primitiveId === item.primitiveId);
      if (!old) throw new Error("Explicit annotation ID is no longer present in expected current-page inventory.");
      if (compatibility && item.type === "text") {
        const entry: any = { oldId: item.primitiveId, type: "text", action: op.annotationAction };
        journal.push(entry);
        if (op.annotationAction === "modify") {
          const full = fullReplacementText({ ...old, ...item.patch });
          const createAlignMode = await replacementAlignMode(api, old);
          if (createAlignMode !== item.createAlignMode)
            throw new Error("Exact TEXT alignment changed after preview; no replacement.");
          entry.createDispatched = true;
          const created = await api().sch_PrimitiveText.create(
            full.x,
            full.y,
            full.content,
            full.rotation,
            full.textColor,
            full.fontName,
            full.fontSize,
            full.bold,
            full.italic,
            full.underLine,
            createAlignMode
          );
          const newId = annotationId(prop(created, "primitiveId"), "new text primitiveId");
          entry.newId = newId;
          if (
            [
              ...before.electrical.components,
              ...before.electrical.wires,
              ...before.pins,
              ...expected.decorations.texts,
              ...expected.decorations.rectangles
            ].some((v: any) => v.primitiveId === newId)
          )
            throw new Error("Replacement returned an existing primitive ID; old text retained.");
          const partial = JSON.parse(canonicalJson(expected.decorations));
          partial.texts.push({ primitiveId: newId, ...full });
          sortIds(partial.texts);
          const fresh = await decorations(api, true);
          if (!same(partial, fresh))
            throw new Error(
              "Replacement content/full style/coordinates or kept decorations unconfirmed; old text retained."
            );
          const replacement = fresh.texts.find((text: any) => text.primitiveId === newId);
          if ((await replacementAlignMode(api, replacement)) !== createAlignMode)
            throw new Error("Replacement exact alignment differs; old text retained.");
          await guardWrite();
          entry.deleteDispatched = true;
          const deleted = await api().sch_PrimitiveCircle.delete([item.primitiveId]);
          if (deleted !== true) throw new Error("Transactional text delete acknowledgment unconfirmed.");
          expected.decorations.texts = partial.texts.filter((v: any) => v.primitiveId !== item.primitiveId);
        } else {
          const fresh = await decorations(api, true);
          if (!same(expected.decorations, fresh))
            throw new Error("Current TEXT/kept decoration inventory changed before transactional delete.");
          await guardWrite();
          entry.deleteDispatched = true;
          if ((await api().sch_PrimitiveCircle.delete([item.primitiveId])) !== true)
            throw new Error("Transactional text delete acknowledgment unconfirmed.");
          expected.decorations.texts = expected.decorations.texts.filter(
            (v: any) => v.primitiveId !== item.primitiveId
          );
        }
      } else {
        const owner = api()[item.type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle"];
        journal.push({ primitiveId: item.primitiveId, type: item.type, action: op.annotationAction, dispatched: true });
        const result =
          op.annotationAction === "delete"
            ? await owner.delete(item.primitiveId)
            : await owner.modify(item.primitiveId, item.patch);
        if (op.annotationAction === "delete" ? result !== true : prop(result, "primitiveId") !== item.primitiveId)
          throw new Error("Native annotation acknowledgment unconfirmed.");
        if (op.annotationAction === "delete")
          expected.decorations[key] = expected.decorations[key].filter((v: any) => v.primitiveId !== item.primitiveId);
        else Object.assign(old, item.patch);
      }
    }
    const actual = await annotationEditState(api, op.guards, record.target);
    const finalComparison = compareAnnotationStates(expected, actual, String(record.target.documentId));
    derivedMetadataDiffs.push(...finalComparison.derivedMetadataDiffs);
    if (!finalComparison.equal)
      throw new Error(
        `Independent annotation readback differs from exact requested delta or electrical/native/kept-decoration preservation. ${annotationDifferenceMessage(finalComparison)}`
      );
    return {
      executed: true,
      readback: {
        verified: true,
        units: "10mil",
        annotationAction: op.annotationAction,
        journal,
        derivedMetadataDiffs,
        electricalPrimitivesUnchanged: true,
        pinsUnchanged: true,
        nativeConnectivityVerified: true,
        keptDecorationsPreserved: true,
        saved: false,
        persistenceVerified: false,
        persistence: false,
        ...(compatibility
          ? { persistenceMode: op.persistenceMode, compatibilityVersion: before.scope.compatibilityVersion }
          : {}),
        limitations: [
          "Only native in-memory readback verified. Saving/reopening persistence remains a separate check; no source fallback or automatic replay."
        ]
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Annotation edit incomplete; never replay automatically. Journal=${JSON.stringify(journal)}. derivedMetadataDiffs=${JSON.stringify(derivedMetadataDiffs)}. ${String(error)}`
    );
  }
}

type Move = { primitiveId: string; designator: string; dx: number; dy: number; x: number; y: number };
const translatedLine = (line: any, dx: number, dy: number): any =>
  Array.isArray(line[0])
    ? line.map((path: number[]) => path.map((v, index) => v + (index % 2 ? dy : dx)))
    : line.map((v: number, index: number) => v + (index % 2 ? dy : dx));
async function nativeFingerprint(api: () => EasyEdaApi, timeout: number) {
  const native = await collectNativeNetlist(api(), true, timeout);
  if (native.status !== "available" || native.text === undefined || native.ambiguousDesignators?.length)
    throw apiError(
      "native_connectivity_unavailable",
      `Native connectivity is required before/after layout: ${native.reason ?? native.status}; ambiguous designators are not accepted.`
    );
  const nets = parseNativeNetlist(native.text, native.format);
  const memberNets = new Map<string, string>();
  for (const [net, members] of nets)
    for (const member of members) {
      if (memberNets.has(member) && memberNets.get(member) !== net)
        throw apiError("native_connectivity_unavailable", `Ambiguous native pin-net membership: ${member}`);
      memberNets.set(member, net);
    }
  return canonicalJson(
    [...nets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([net, members]) => [net, [...members].sort()])
  );
}
function nativeTopologyDifference(expected: string, actual: string) {
  const a = new Map<string, string[]>(JSON.parse(expected)),
    b = new Map<string, string[]>(JSON.parse(actual));
  const pinMap = (nets: Map<string, string[]>) =>
    new Map([...nets].flatMap(([net, members]) => members.map((member) => [member, net] as [string, string])));
  const left = pinMap(a),
    right = pinMap(b),
    first: Array<Record<string, unknown>> = [];
  let changedPins = 0;
  const short = (value: string | undefined) =>
    value === undefined ? null : value.length > 128 ? value.slice(0, 128) + "…" : value;
  for (const member of [...new Set([...left.keys(), ...right.keys()])].sort())
    if (left.get(member) !== right.get(member)) {
      changedPins++;
      if (first.length < 8)
        first.push({
          member: short(member),
          expectedNet: short(left.get(member)),
          actualNet: short(right.get(member))
        });
    }
  const changedNets = [...new Set([...a.keys(), ...b.keys()])].filter((net) => !same(a.get(net), b.get(net))).sort();
  return { changedPins, changedNets: changedNets.length, first, firstNetNames: changedNets.slice(0, 8).map(short) };
}
async function reconcileNativeFingerprint(
  api: () => EasyEdaApi,
  expected: string,
  timeout: number,
  executionDeadline: number
) {
  // This is a total post-write read window, also bounded by the executor's hard deadline.
  // Never repeat a write, and never accept a different or unavailable native topology.
  const deadline = Math.min(executionDeadline, Date.now() + timeout);
  let attempts = 0,
    actual: string | undefined,
    lastError: string | undefined;
  while (Date.now() < deadline) {
    attempts++;
    try {
      actual = await nativeFingerprint(api, Math.max(1, deadline - Date.now()));
      lastError = undefined;
      if (actual === expected && Date.now() <= deadline) return { verified: true, attempts, reconciled: attempts > 1 };
    } catch (error) {
      lastError = String(error).slice(0, 200);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  return {
    verified: false,
    attempts,
    reconciled: false,
    deadlineExpired: Date.now() >= deadline,
    ...(actual !== undefined ? { differing: nativeTopologyDifference(expected, actual) } : {}),
    ...(lastError ? { lastReadError: lastError } : {})
  };
}
function electricalReadback(value: any) {
  return {
    ...value,
    wires: value.wires.map((wire: any) => ({
      ...wire,
      line: segments(wire.line)
        .map(({ x1, y1, x2, y2 }) => {
          const points = [
            [x1, y1],
            [x2, y2]
          ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          return points.flat();
        })
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
    }))
  };
}
function sameLayout(a: any, b: any) {
  return same(
    { ...a, electrical: electricalReadback(a.electrical) },
    { ...b, electrical: electricalReadback(b.electrical) }
  );
}
function layoutDifferences(expected: any, actual: any) {
  const counts: Record<string, number> = {},
    first: Array<Record<string, unknown>> = [];
  for (const [kind, left, right] of [
    ["component", expected.electrical.components, actual.electrical.components],
    ["wire", electricalReadback(expected.electrical).wires, electricalReadback(actual.electrical).wires],
    ["attribute", expected.attributes, actual.attributes],
    ["text", expected.decorations.texts, actual.decorations.texts],
    ["rectangle", expected.decorations.rectangles, actual.decorations.rectangles]
  ] as Array<[string, any[], any[]]>) {
    const a = new Map(left.map((v) => [v.primitiveId, v])),
      b = new Map(right.map((v) => [v.primitiveId, v]));
    for (const id of new Set([...a.keys(), ...b.keys()]))
      if (!same(a.get(id), b.get(id))) {
        counts[kind] = (counts[kind] ?? 0) + 1;
        if (first.length < 8)
          first.push({
            kind,
            primitiveId: id,
            fields:
              a.has(id) && b.has(id)
                ? [...new Set([...Object.keys(a.get(id)), ...Object.keys(b.get(id))])].filter(
                    (key) => !same(a.get(id)[key], b.get(id)[key])
                  )
                : [a.has(id) ? "missing" : "unexpected"]
          });
      }
  }
  return { counts, first };
}
async function layoutAttributes(api: () => EasyEdaApi, parentIds?: string[]) {
  const electrical = parentIds ? undefined : await sheetState(api);
  const ids = parentIds ?? [
    ...new Set([...electrical!.components, ...electrical!.wires].map((item) => String(item.primitiveId)))
  ];
  const records = new Map<string, any>();
  for (let offset = 0; offset < ids.length; offset += 300) {
    const report = await getSchematicAttributeInventory(api, { parentIds: ids.slice(offset, offset + 300) });
    const counts = report.counts as any;
    if (
      counts.invalidRecords ||
      counts.conflicts ||
      (report.parents as any[]).some((p) => p.error || p.fallbackError || p.missingCount)
    )
      throw apiError(
        "attribute_inventory_incomplete",
        "Parent attribute inventory has unread or conflicting records; no safe attribute layout."
      );
    for (const item of report.attributes as any[]) {
      const { sources: _sources, ...data } = item;
      if (records.has(String(data.primitiveId)) && !same(records.get(String(data.primitiveId)), data))
        throw apiError("attribute_inventory_incomplete", "Attribute changed during parent inventory.");
      records.set(String(data.primitiveId), data);
    }
  }
  // Preserve independently enumerated labels when available; never assume global [] means no parent attributes.
  if (!parentIds)
    for (const attr of await readSchematicAttributes(api)) {
      if (records.has(attr.primitiveId) && !same(records.get(attr.primitiveId), attr))
        throw apiError("attribute_inventory_incomplete", "Global/parent attribute states disagree.");
      records.set(String(attr.primitiveId), attr);
    }
  return sortIds([...records.values()]);
}
async function layoutState(api: () => EasyEdaApi) {
  return {
    electrical: await sheetState(api),
    attributes: await layoutAttributes(api),
    decorations: await decorations(api)
  };
}

function layoutCapabilities(eda: EasyEdaApi) {
  requireMethods(eda, [
    ["sch_PrimitiveComponent", "getAll"],
    ["sch_PrimitiveComponent", "modify"],
    ["sch_PrimitiveComponent", "getAllPinsByPrimitiveId"],
    ["sch_PrimitiveWire", "getAll"],
    ["sch_PrimitiveWire", "modify"],
    ["sch_PrimitiveAttribute", "getAll"],
    ["sch_PrimitiveAttribute", "modify"],
    ["sch_ManufactureData", "getNetlistFile"]
  ]);
}
export async function prepareSchematicLayout(
  api: () => EasyEdaApi,
  params: Record<string, any>,
  target: DocumentIdentity
) {
  const preparation = guardedSchematicApi(api, target);
  api = preparation.api;
  layoutCapabilities(api());
  const buses = toArray(await api().sch_PrimitiveBus?.getAll?.());
  if (buses.length)
    throw apiError(
      "unsupported_primitive",
      "Bus-bearing pages require an explicit bus-aware layout; no writes started."
    );
  const timeout = validateNativeNetlistTimeoutMs(params.nativeNetlistTimeoutMs);
  const native = await nativeFingerprint(api, timeout);
  const before = await layoutState(api);
  const source = before.electrical;
  if (params.placements && params.componentIds)
    throw apiError("invalid_params", "Use placements or componentIds plus dx/dy, not both.");
  const requested =
    params.placements ??
    (Array.isArray(params.componentIds) ? params.componentIds.map((component: string) => ({ component })) : undefined);
  if (!Array.isArray(requested) || !requested.length || requested.length > 100)
    throw apiError("invalid_params", "layout requires 1 to 100 placements or componentIds.");
  const moves: Move[] = requested
    .map((item: any) => {
      const identifier = String(item.component ?? "");
      const localId = identifier.startsWith(`${target.documentId}:`)
        ? identifier.slice(String(target.documentId).length + 1)
        : identifier;
      const found = source.components.filter((c) => c.primitiveId === localId || c.designator === identifier);
      if (found.length !== 1 || found[0].componentType !== "part" || !found[0].uniqueId)
        throw apiError("component_not_found", `A unique part with preserved uniqueId is required: ${identifier}`);
      const c = found[0];
      const oldX = number(c.x, "component x"),
        oldY = number(c.y, "component y");
      const x = params.placements ? number(item.x, "placement x") : oldX + number(params.dx ?? 0, "dx");
      const y = params.placements ? number(item.y, "placement y") : oldY + number(params.dy ?? 0, "dy");
      return { primitiveId: c.primitiveId, designator: c.designator, dx: x - oldX, dy: y - oldY, x, y };
    })
    .sort((a, b) => a.primitiveId.localeCompare(b.primitiveId));
  if (new Set(moves.map((m) => m.primitiveId)).size !== moves.length)
    throw apiError("invalid_params", "Duplicate component aliases are not allowed.");
  if (moves.every((m) => !m.dx && !m.dy)) throw apiError("no_effective_change", "All placements are unchanged.");
  const byId = new Map(moves.map((m) => [m.primitiveId, m]));
  const pins: Array<{ componentId: string; x: number; y: number }> = [];
  for (const c of source.components)
    if (c.componentType !== "sheet")
      for (const p of toArray(await api().sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)).filter(
        isRecord
      ))
        pins.push({ componentId: c.primitiveId, x: number(p.x, "pin x"), y: number(p.y, "pin y") });
  const all = source.wires.map((wire) => ({ wire, segments: segments(wire.line) }));
  const unseen = new Set(all.map((_, index) => index));
  const wires: Array<{ primitiveId: string; dx: number; dy: number; line: any }> = [];
  while (unseen.size) {
    const chosen = [unseen.values().next().value as number];
    unseen.delete(chosen[0]);
    for (let index = 0; index < chosen.length; index++)
      for (const candidate of [...unseen])
        if (all[chosen[index]].segments.some((a) => all[candidate].segments.some((b) => intersects(a, b)))) {
          chosen.push(candidate);
          unseen.delete(candidate);
        }
    const owners = pins.filter((p) =>
      chosen.some((index) => all[index].segments.some((segment) => touches(segment, p)))
    );
    if (!owners.some((p) => byId.has(p.componentId))) continue;
    if (owners.some((p) => !byId.has(p.componentId)))
      throw apiError("block_boundary", "Selected wire is shared with a component outside the block.");
    const deltas = owners.map((p) => byId.get(p.componentId)!);
    if (deltas.some((delta) => delta.dx !== deltas[0].dx || delta.dy !== deltas[0].dy))
      throw apiError(
        "shared_wire_delta_conflict",
        `Shared wire components require one delta: ${[...new Set(deltas.map((m) => m.designator))].join(", ")}; different deltas were requested.`
      );
    for (const index of chosen) {
      const w = all[index].wire;
      if (!String(w.net ?? "").trim()) throw apiError("unnamed_boundary", "Name all selected wire nets before layout.");
      wires.push({
        primitiveId: w.primitiveId,
        dx: deltas[0].dx,
        dy: deltas[0].dy,
        line: translatedLine(w.line, deltas[0].dx, deltas[0].dy)
      });
    }
  }
  const orderedIds = buildSafeWireOrder(
    source.wires,
    wires.filter((w) => w.dx || w.dy)
  );
  const wireRank = new Map(orderedIds.map((id, index) => [id, index]));
  wires.sort(
    (a, b) =>
      (wireRank.get(a.primitiveId) ?? Number.MAX_SAFE_INTEGER) -
      (wireRank.get(b.primitiveId) ?? Number.MAX_SAFE_INTEGER)
  );
  const wireById = new Map(wires.map((w) => [w.primitiveId, w]));
  const finalPins = pins.map((p) => ({
    ...p,
    x: p.x + (byId.get(p.componentId)?.dx ?? 0),
    y: p.y + (byId.get(p.componentId)?.dy ?? 0)
  }));
  const finalWires = all.map(({ wire }) => ({
    id: wire.primitiveId,
    segments: segments(wireById.get(wire.primitiveId)?.line ?? wire.line)
  }));
  for (const pin of finalPins)
    if (byId.has(pin.componentId)) {
      if (finalPins.some((other) => other.componentId !== pin.componentId && other.x === pin.x && other.y === pin.y))
        throw apiError("destination_collision", "Final collision: component pins would overlap.");
      if (finalWires.some((w) => !wireById.has(w.id) && w.segments.some((s) => touches(s, pin))))
        throw apiError("destination_collision", "Moved pins would intersect stationary wires.");
    }
  for (const moved of wires) {
    const mine = segments(moved.line);
    for (const other of finalWires) {
      if (other.id === moved.primitiveId) continue;
      const otherMove = wireById.get(other.id);
      if (otherMove && otherMove.dx === moved.dx && otherMove.dy === moved.dy) continue;
      if (mine.some((a) => other.segments.some((b) => intersects(a, b))))
        throw apiError("destination_collision", "Final wires from independently moved blocks would intersect.");
    }
    if (
      finalPins.some((p) => {
        const owner = byId.get(p.componentId);
        return (!owner || owner.dx !== moved.dx || owner.dy !== moved.dy) && mine.some((s) => touches(s, p));
      })
    )
      throw apiError("destination_collision", "Moved wires would intersect component pins from another block.");
  }
  const anchors = source.components
    .filter((c) => c.componentType === "part")
    .map((c) => ({
      id: c.primitiveId,
      x: c.x + (byId.get(c.primitiveId)?.dx ?? 0),
      y: c.y + (byId.get(c.primitiveId)?.dy ?? 0)
    }));
  if (anchors.some((a) => byId.has(a.id) && anchors.some((b) => b.id !== a.id && a.x === b.x && a.y === b.y)))
    throw apiError("destination_collision", "Final collision: component anchors would overlap.");
  const selectedPins = pins.filter((p) => byId.has(p.componentId));
  const points = [
    ...selectedPins,
    ...moves.map((m) => source.components.find((c) => c.primitiveId === m.primitiveId)!)
  ];
  const minX = Math.min(...points.map((p) => p.x)) - 100,
    maxX = Math.max(...points.map((p) => p.x)) + 100;
  const minY = Math.min(...points.map((p) => p.y)) - 100,
    maxY = Math.max(...points.map((p) => p.y)) + 100;
  const inBlock = (x: any, y: any) =>
    typeof x === "number" && typeof y === "number" && x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (
    before.decorations.texts.some((t) => inBlock(t.x, t.y)) ||
    before.attributes.some((a) => !a.parentPrimitiveId && inBlock(a.x, a.y))
  )
    throw apiError(
      "unsupported_primitive",
      "Existing free text or independent net labels inside the block require explicit handling before layout."
    );
  await targetMatches(api, target);
  return prepared(
    extensionMutations.prepare({
      domain: "schematic",
      action: "layoutSchematic",
      target,
      operation: { action: "layoutSchematic", before, moves, wires, native, timeout },
      before: { pageId: target.documentId, components: moves.map((m) => m.designator), wireCount: wires.length },
      requestedAfter: {
        placements: moves.map((m) => ({ component: m.designator, x: m.x, y: m.y })),
        wireCount: wires.length
      },
      scope: `page:${target.documentId}`,
      impact: `Moves ${moves.length} original parts and ${wires.length} attached wires in place; preserves primitive IDs, unique IDs and native connectivity. Symbol/text body clearance is not inferred. Non-atomic: inspect journal after uncertainty.`,
      ttlMs: 15 * 60_000
    })
  );
}

export async function executeSchematicLayout(record: MutationRecord, api: () => EasyEdaApi) {
  const execution = guardedSchematicApi(api, record.target);
  api = execution.api;
  const op = record.operation as any;
  layoutCapabilities(api());
  await targetMatches(api, record.target);
  if (!same(op.before, await layoutState(api)))
    throw apiError("stale_mutation", "Page, components, wires or attributes changed after layout preview.");
  const checkedOrder = buildSafeWireOrder(
    op.before.electrical.wires,
    op.wires.filter((w: any) => w.dx || w.dy)
  );
  if (
    !same(
      checkedOrder,
      op.wires.filter((w: any) => w.dx || w.dy).map((w: any) => w.primitiveId)
    )
  )
    throw apiError("stale_mutation", "Stored wire order is not safe; prepare the layout again.");
  const journal = {
    phase: "components",
    movedComponents: [] as string[],
    movedWires: [] as string[],
    currentWire: undefined as string | undefined
  };
  let differing: Record<string, unknown> | undefined;
  try {
    for (const move of op.moves as Move[])
      if (move.dx || move.dy) {
        await api().sch_PrimitiveComponent.modify(move.primitiveId, { x: move.x, y: move.y });
        await execution.guard();
        journal.movedComponents.push(move.primitiveId);
      }
    journal.phase = "wires";
    for (const wire of op.wires)
      if (wire.dx || wire.dy) {
        const original = op.before.electrical.wires.find((item: any) => item.primitiveId === wire.primitiveId);
        journal.currentWire = wire.primitiveId;
        journal.phase = "wire_write";
        // SDK modify(id, patch) replaces a wire through a constructor with empty-net/null-style defaults.
        // It also dispatches done() without awaiting persistence: never invoke done() a second time.
        await api().sch_PrimitiveWire.modify(wire.primitiveId, {
          line: wire.line,
          net: original.net,
          color: original.color,
          lineWidth: original.lineWidth,
          lineType: original.lineType
        });
        // modify() resolves before its SDK fire-and-forget RPC persists. A second dispatch can
        // overlap the previous transaction. Confirm this exact wire before sending the next one.
        journal.phase = "wire_readback";
        const wanted = wireReadbackData({ ...original, line: wire.line });
        const deadline = Date.now() + op.timeout;
        while (true) {
          let actual;
          try {
            actual = await findWireById(api, wire.primitiveId);
          } catch {
            /* transient missing readback */
          }
          const normalized = (item: any) => electricalReadback({ components: [], wires: [item] }).wires[0];
          if (actual && same(normalized(wanted), normalized(actual))) break;
          if (Date.now() >= deadline) {
            differing = {
              wireCount: 1,
              first: [
                {
                  kind: "wire",
                  primitiveId: wire.primitiveId,
                  fields: actual
                    ? Object.keys(wanted).filter((key) =>
                        key === "line"
                          ? !same(normalized(wanted).line, normalized(actual).line)
                          : !same(wanted[key], actual[key])
                      )
                    : ["missing"]
                }
              ]
            };
            throw new Error("Per-wire persistence readback did not confirm; later wires were not dispatched.");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await execution.guard();
        journal.movedWires.push(wire.primitiveId);
        journal.currentWire = undefined;
      }
    journal.phase = "attributes";
    for (const owner of [...op.moves, ...op.wires]) {
      const attrs = op.before.attributes.filter((a: any) => a.parentPrimitiveId === owner.primitiveId);
      if (attrs.length) await restoreSchematicAttributes(api, owner.primitiveId, attrs, owner.dx, owner.dy);
    }
    const expected = JSON.parse(canonicalJson(op.before));
    for (const move of op.moves)
      Object.assign(
        expected.electrical.components.find((c: any) => c.primitiveId === move.primitiveId),
        { x: move.x, y: move.y }
      );
    for (const wire of op.wires)
      expected.electrical.wires.find((w: any) => w.primitiveId === wire.primitiveId).line = wire.line;
    for (const attr of expected.attributes) {
      const owner = [...op.moves, ...op.wires].find((m: any) => m.primitiveId === attr.parentPrimitiveId);
      if (owner) Object.assign(attr, annotationProperties(attr, owner.dx, owner.dy));
    }
    journal.phase = "layout_readback";
    const deadline = Date.now() + op.timeout;
    while (true) {
      const actual = await layoutState(api);
      if (sameLayout(expected, actual)) break;
      if (Date.now() >= deadline) {
        differing = layoutDifferences(expected, actual);
        throw new Error("Native layout readback did not confirm positions, identities and annotations.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    journal.phase = "native_readback";
    const nativeReadback = await reconcileNativeFingerprint(api, op.native, op.timeout, execution.deadline);
    if (!nativeReadback.verified) {
      differing = { nativeConnectivity: nativeReadback };
      throw new Error("Native connectivity did not reconcile after layout.");
    }
    await targetMatches(api, record.target);
    journal.phase = "verified";
    return {
      executed: true,
      readback: {
        verified: true,
        units: "10mil",
        identityPreserved: true,
        nativeConnectivityVerified: true,
        nativeReadback,
        journal,
        saved: false,
        visualRenderVerified: false,
        attributeCoverage:
          "Explicit component/wire parents enumerated; absence of independent attributes is not proven.",
        geometryLimits:
          "Electrical point/segment collisions checked; symbol and text body bounds require the packing plan."
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `In-place layout incomplete. Do not replay. ${JSON.stringify({
        phase: journal.phase,
        dispatchedComponents: journal.movedComponents.length,
        confirmedWires: journal.movedWires.length,
        firstComponentIds: journal.movedComponents.slice(0, 8),
        firstWireIds: journal.movedWires.slice(0, 8),
        currentWire: journal.currentWire,
        differing
      })}. ${String(error).slice(0, 500)}`
    );
  }
}

export async function prepareSchematicAttributeLayout(
  api: () => EasyEdaApi,
  params: Record<string, any>,
  target: DocumentIdentity
) {
  const execution = guardedSchematicApi(api, target);
  api = execution.api;
  requireMethods(api(), [
    ["sch_PrimitiveAttribute", "getAll"],
    ["sch_PrimitiveAttribute", "modify"],
    ["sch_PrimitiveComponent", "getAll"],
    ["sch_PrimitiveWire", "getAll"],
    ["sch_ManufactureData", "getNetlistFile"]
  ]);
  if (
    !Array.isArray(params.parentIds) ||
    !params.parentIds.length ||
    params.parentIds.length > 300 ||
    params.parentIds.some((id: any) => typeof id !== "string" || !id)
  )
    throw apiError("invalid_params", "attributeLayout.parentIds requires 1–300 explicit parent IDs.");
  if (!Array.isArray(params.placements) || !params.placements.length || params.placements.length > 1000)
    throw apiError("invalid_params", "attributeLayout.placements requires 1–1000 exact attribute IDs and positions.");
  const parentIds = [...new Set<string>(params.parentIds)].sort();
  const electrical = await sheetState(api),
    parents = new Set([...electrical.components, ...electrical.wires].map((c) => String(c.primitiveId)));
  if (parentIds.some((id) => !parents.has(id)))
    throw apiError("invalid_target", "All attribute parents must belong to the active sheet.");
  const attributes = await layoutAttributes(api, parentIds);
  const placements = params.placements
    .map((p: any) => {
      const attributeId = String(p.attributeId ?? ""),
        attr = attributes.find((a) => a.primitiveId === attributeId);
      if (!attr)
        throw apiError(
          "attribute_not_found",
          `Exact attribute ID is missing from requested parent inventory: ${attributeId}`
        );
      if (!Number.isFinite(attr.x) || !Number.isFinite(attr.y))
        throw apiError("unsupported_geometry", "Attribute must expose finite public coordinates.");
      return { attributeId, x: number(p.x, "attribute x"), y: number(p.y, "attribute y") };
    })
    .sort((a: any, b: any) => a.attributeId.localeCompare(b.attributeId));
  if (new Set(placements.map((p: any) => p.attributeId)).size !== placements.length)
    throw apiError("invalid_params", "Duplicate attribute IDs.");
  if (
    placements.every((p: any) => {
      const a = attributes.find((a) => a.primitiveId === p.attributeId);
      return a.x === p.x && a.y === p.y;
    })
  )
    throw apiError("no_effective_change", "All attribute positions are unchanged.");
  const timeout = validateNativeNetlistTimeoutMs(params.nativeNetlistTimeoutMs),
    native = await nativeFingerprint(api, timeout);
  await execution.guard();
  return prepared(
    extensionMutations.prepare({
      domain: "schematic",
      action: "layoutSchematicAttributes",
      target,
      operation: {
        action: "layoutSchematicAttributes",
        parentIds,
        placements,
        before: { electrical, attributes },
        native,
        timeout
      },
      before: { parentIds, attributeCount: attributes.length },
      requestedAfter: { placements },
      changedKeys: ["attributePositions"],
      scope: `page:${target.documentId}`,
      impact:
        "Moves only explicitly identified existing attributes. Preserves parent IDs, text, public font/style and native electrical membership; no canvas-render verification.",
      ttlMs: 15 * 60_000
    })
  );
}
export async function executeSchematicAttributeLayout(record: MutationRecord, api: () => EasyEdaApi) {
  const execution = guardedSchematicApi(api, record.target);
  api = execution.api;
  const op = record.operation as any;
  await execution.guard();
  const current = { electrical: await sheetState(api), attributes: await layoutAttributes(api, op.parentIds) };
  if (!same(current, op.before))
    throw apiError("stale_mutation", "Electrical primitives or attribute inventory changed after preview.");
  let phase = "attributes",
    currentAttribute: string | undefined;
  let confirmed = 0;
  let nativeReadback: Awaited<ReturnType<typeof reconcileNativeFingerprint>> | undefined;
  const expected = JSON.parse(canonicalJson(op.before.attributes));
  try {
    for (const placement of op.placements) {
      currentAttribute = placement.attributeId;
      const old = op.before.attributes.find((a: any) => a.primitiveId === placement.attributeId);
      if (old.x === placement.x && old.y === placement.y) continue;
      const wanted = { ...old, x: placement.x, y: placement.y };
      await api().sch_PrimitiveAttribute.modify(
        placement.attributeId,
        schematicAttributeBackendPatch({ x: placement.x, y: placement.y })
      );
      const deadline = Math.min(execution.deadline, Date.now() + op.timeout);
      while (true) {
        const attrs = await readSchematicAttributes(api, old.parentPrimitiveId);
        if (
          same(
            attrs.find((a) => a.primitiveId === placement.attributeId),
            wanted
          )
        )
          break;
        if (Date.now() >= deadline) throw new Error("Attribute persistence readback did not confirm exact fields.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await execution.guard();
      Object.assign(
        expected.find((a: any) => a.primitiveId === placement.attributeId),
        { x: placement.x, y: placement.y }
      );
      confirmed++;
      currentAttribute = undefined;
    }
    phase = "readback";
    if (
      !same(op.before.electrical, await sheetState(api)) ||
      !same(expected, await layoutAttributes(api, op.parentIds))
    )
      throw new Error("Electrical primitives or unrequested attribute fields changed.");
    phase = "native_readback";
    nativeReadback = await reconcileNativeFingerprint(api, op.native, op.timeout, execution.deadline);
    if (!nativeReadback.verified) throw new Error("Native connectivity did not reconcile after attribute layout.");
    await execution.guard();
    return {
      executed: true,
      readback: {
        verified: true,
        identityPreserved: true,
        nativeConnectivityVerified: true,
        visualRenderVerified: false,
        confirmedAttributes: confirmed,
        nativeReadback,
        units: "10mil",
        saved: false,
        coverage: "Explicit requested parents only; independent attribute absence is not inferred."
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Attribute layout uncertain. Do not replay. ${JSON.stringify({ phase, confirmedAttributes: confirmed, currentAttribute, nativeReadback })}. ${String(error).slice(0, 500)}`
    );
  }
}
