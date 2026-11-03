import { apiError, isRecord, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";

export async function activeSchematic(api: () => EasyEdaApi, expected?: any) {
  const target = extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo());
  if (expected) assertDocumentTargetMatch(expected, target);
  if (target.documentType !== "schematic" || !target.documentId || !target.projectId)
    throw apiError("invalid_target", "An active schematic page and project are required.");
  const schematic = await api().dmt_Schematic?.getCurrentSchematicInfo?.();
  if (!schematic?.uuid) throw apiError("capability_unavailable", "Cannot identify the current schematic.");
  const pages = toArray(await api().dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo()).filter(isRecord);
  if (!pages.some((p) => p.uuid === target.documentId))
    throw apiError("invalid_target", "Active page is outside the current schematic.");
  return { target, schematicId: String(schematic.uuid), pages };
}
export async function focusPage(api: () => EasyEdaApi, pageId: string, projectId: string) {
  await api().dmt_EditorControl.openDocument(pageId);
  const target = extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo());
  assertDocumentTargetMatch({ documentId: pageId, projectId, documentType: "schematic" }, target);
}
export function plain(value: any): any {
  return JSON.parse(JSON.stringify(value));
}
export async function readPage(api: () => EasyEdaApi) {
  const eda = api();
  const components = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, false))
    .filter(isRecord)
    .map(plain);
  const wires = toArray(await eda.sch_PrimitiveWire.getAll())
    .filter(isRecord)
    .map(plain);
  return { components, wires };
}
export async function listSchematicPages(api: () => EasyEdaApi, params: Record<string, any> = {}) {
  const { target, schematicId, pages } = await activeSchematic(api, params.target);
  const result: any[] = [];
  try {
    for (const p of pages) {
      const item: any = { pageId: p.uuid, name: p.name, schematicId, active: p.uuid === target.documentId };
      if (params.includeCounts) {
        await focusPage(api, String(p.uuid), target.projectId!);
        const data = await readPage(api);
        item.componentCount = data.components.filter((c) => c.componentType === "part").length;
        item.wireCount = data.wires.length;
        item.componentAnchorBounds = anchorBounds(data.components.filter((c) => c.componentType === "part"));
        item.overRecommendedLimit = item.componentCount >= 150;
        const sheet = data.components.find((c) => c.componentType === "sheet");
        item.format = sheet?.otherProperty?.["Page Size"];
      }
      result.push(item);
    }
  } finally {
    if (params.includeCounts) await focusPage(api, target.documentId!, target.projectId!);
  }
  return {
    target,
    schematicId,
    pages: result,
    recommendedComponentLimit: 150,
    boundsNote: "Bounds describe component anchors, not symbol or text extents.",
    focusRestored: true
  };
}
function anchorBounds(comps: any[]) {
  const pts = comps.filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
  if (!pts.length) return null;
  return {
    left: Math.min(...pts.map((c) => c.x)),
    right: Math.max(...pts.map((c) => c.x)),
    top: Math.min(...pts.map((c) => c.y)),
    bottom: Math.max(...pts.map((c) => c.y))
  };
}
const formats: Record<string, [number, number]> = {
  A4: [1170, 825],
  A3: [1654, 1170],
  A2: [2339, 1654],
  A1: [3311, 2339],
  A0: [4681, 3311]
};
export async function prepareSchematicPage(api: () => EasyEdaApi, params: Record<string, any>) {
  const context = await activeSchematic(api, params.target);
  const action = String(params.action);
  if (!["create", "rename", "format"].includes(action))
    throw apiError("invalid_params", "Page action must be create, rename, or format.");
  const page = context.pages.find((p) => p.uuid === params.pageId);
  if (action !== "create" && !page) throw apiError("page_not_found", "Page is not in the current schematic.");
  if (
    action !== "format" &&
    (typeof params.name !== "string" || !params.name.trim() || params.name.length > 128 || /[\r\n]/.test(params.name))
  )
    throw apiError("invalid_params", "A page name of 1 to 128 characters is required.");
  if (
    action !== "format" &&
    context.pages.some(
      (p) => String(p.name).toLowerCase() === params.name.trim().toLowerCase() && p.uuid !== params.pageId
    )
  )
    throw apiError("duplicate_name", "Page name already exists.");
  if (action === "format" && !formats[params.format])
    throw apiError("invalid_params", "Format must be A0, A1, A2, A3, or A4.");
  let sheet;
  if (action === "format") {
    try {
      await focusPage(api, params.pageId, context.target.projectId!);
      sheet = (await readPage(api)).components.find((c) => c.componentType === "sheet");
    } finally {
      await focusPage(api, context.target.documentId!, context.target.projectId!);
    }
    if (!sheet) throw apiError("capability_unavailable", "Page has no editable drawing frame.");
  }
  const operation = {
    action: "schematicPage",
    pageAction: action,
    schematicId: context.schematicId,
    pageId: params.pageId,
    name: params.name?.trim(),
    format: params.format,
    sheet
  };
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: "schematicPage",
    target: context.target,
    operation,
    before: plain(context.pages),
    requestedAfter: operation,
    scope: `schematic:${context.schematicId}`,
    impact: `${action} schematic page; saving remains separate.`
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
export async function executeSchematicPage(record: MutationRecord, api: () => EasyEdaApi) {
  const op = record.operation as any;
  const context = await activeSchematic(api, record.target);
  if (context.schematicId !== op.schematicId || canonicalJson(context.pages) !== canonicalJson(record.before))
    throw apiError("stale_mutation", "Schematic pages changed after preview.");
  let pageId = op.pageId;
  let actualName = op.name;
  try {
    if (op.pageAction === "create") {
      pageId = await api().dmt_Schematic.createSchematicPage(op.schematicId);
      if (!pageId) throw new Error("Native page creation returned no UUID");
    }
    if (op.pageAction !== "format") {
      if ((await api().dmt_Schematic.modifySchematicPageName(pageId, op.name)) === false)
        throw new Error("Native rename failed");
      const page = await api().dmt_Schematic.getSchematicPageInfo(pageId);
      if (
        !page ||
        page.parentSchematicUuid !== op.schematicId ||
        String(page.name).toLowerCase() !== op.name.toLowerCase()
      )
        throw new Error("Page readback failed");
      actualName = page.name;
    } else {
      await focusPage(api, pageId, context.target.projectId!);
      const sheet = (await readPage(api)).components.find((c) => c.primitiveId === op.sheet.primitiveId);
      if (canonicalJson(sheet) !== canonicalJson(op.sheet))
        throw apiError("stale_mutation", "Drawing frame changed after preview.");
      const [width, height] = formats[op.format];
      const otherProperty = {
        ...sheet.otherProperty,
        "Page Size": op.format,
        Width: String(width),
        Height: String(height)
      };
      await api().sch_PrimitiveComponent.modify(sheet.primitiveId, { otherProperty });
      const actual = (await readPage(api)).components.find((c) => c.primitiveId === sheet.primitiveId);
      if (canonicalJson(actual?.otherProperty) !== canonicalJson(otherProperty))
        throw new Error("Drawing frame readback failed");
    }
    return {
      executed: true,
      readback: { pageId, name: actualName, requestedName: op.name, format: op.format, verified: true, saved: false }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Page operation needs inspection (pageId=${pageId ?? "unknown"}); do not replay. ${String(error)}`
    );
  } finally {
    if (op.pageAction === "format") await focusPage(api, context.target.documentId!, context.target.projectId!);
  }
}
