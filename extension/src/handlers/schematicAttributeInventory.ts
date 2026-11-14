import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";
import type { EasyEdaApi } from "../types.js";

const fields = [
  "primitiveId",
  "parentPrimitiveId",
  "key",
  "value",
  "x",
  "y",
  "rotation",
  "fontName",
  "fontSize",
  "color",
  "fillColor",
  "bold",
  "italic",
  "underLine",
  "alignMode",
  "keyVisible",
  "valueVisible"
];
function project(item: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    const getter = item?.[`getState_${key[0].toUpperCase() + key.slice(1)}`];
    if (typeof getter === "function") {
      const value = getter.call(item);
      if (value !== undefined) out[key] = value;
    }
  }
  if (typeof out.primitiveId !== "string" || !out.primitiveId || typeof item?.getState_ParentPrimitiveId !== "function")
    throw new Error("Attribute lacks public ID/parent getters.");
  return out;
}
export async function getSchematicAttributeInventory(
  api: () => EasyEdaApi,
  params: Record<string, any> = {}
): Promise<Record<string, unknown>> {
  const eda = api();
  const target = extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  if (params.target) assertDocumentTargetMatch(params.target, target);
  if (target.documentType !== "schematic" || !target.documentId)
    throw apiError("invalid_target", "An identifiable active schematic page is required.");
  const guard = async () =>
    assertDocumentTargetMatch(target, extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.()));
  if (typeof eda.sch_PrimitiveAttribute?.getAll !== "function")
    throw apiError("capability_unavailable", "sch_PrimitiveAttribute.getAll is required.");
  const warnings: string[] = [];
  let parentIds: string[];
  const auto = params.parentIds === undefined;
  if (!auto) {
    if (
      !Array.isArray(params.parentIds) ||
      params.parentIds.length < 1 ||
      params.parentIds.length > 300 ||
      params.parentIds.some((id: unknown) => typeof id !== "string" || !id.trim())
    )
      throw apiError("invalid_params", "parentIds must contain 1–300 nonempty primitive IDs.");
    parentIds = [...new Set<string>(params.parentIds)];
  } else {
    if (typeof eda.sch_PrimitiveComponent?.getAll !== "function" || typeof eda.sch_PrimitiveWire?.getAll !== "function")
      throw apiError("capability_unavailable", "Auto parent enumeration requires component and wire getAll.");
    const components = await eda.sch_PrimitiveComponent.getAll(undefined, false);
    await guard();
    const wires = await eda.sch_PrimitiveWire.getAll();
    await guard();
    if (!Array.isArray(components) || !Array.isArray(wires))
      throw apiError("readback_failed", "Component/wire parent enumeration did not return arrays.");
    parentIds = [
      ...new Set<string>(
        [...components, ...wires]
          .map((item) =>
            typeof item?.getState_PrimitiveId === "function" ? item.getState_PrimitiveId() : item?.primitiveId
          )
          .filter((id) => typeof id === "string" && id)
      )
    ];
    if (parentIds.length > 300)
      throw apiError("invalid_params", "More than 300 parents: request explicit parentIds batches.");
    if (parentIds.length !== components.length + wires.length)
      warnings.push("Some parent IDs were missing or duplicated during component/wire enumeration.");
  }
  const requested = new Set(parentIds);
  const records = new Map<string, { data: Record<string, unknown>; sources: string[] }>();
  const globals = new Map<string, Record<string, unknown>>();
  const parentObserved = new Set<string>();
  let invalidRecords = 0,
    conflicts = 0,
    globalFailed = false;
  const read = (raw: unknown) => {
    if (!Array.isArray(raw)) throw new Error("Native attribute enumeration did not return an array.");
    const result: Record<string, unknown>[] = [];
    for (const item of raw) {
      try {
        result.push(project(item));
      } catch {
        invalidRecords++;
      }
    }
    return result;
  };
  const add = (data: Record<string, unknown>, source: string) => {
    const id = String(data.primitiveId),
      old = records.get(id);
    if (old) {
      if (canonicalJson(old.data) !== canonicalJson(data)) {
        conflicts++;
        warnings.push(`Conflicting getter snapshots for attribute ${id}; inventory is not atomic.`);
      }
      if (!old.sources.includes(source)) old.sources.push(source);
    } else records.set(id, { data, sources: [source] });
  };
  await guard();
  try {
    for (const data of read(await eda.sch_PrimitiveAttribute.getAll())) {
      globals.set(String(data.primitiveId), data);
      if (auto || requested.has(String(data.parentPrimitiveId))) add(data, "global");
    }
  } catch (error) {
    globalFailed = true;
    warnings.push(`Global attribute enumeration failed: ${String(error).slice(0, 200)}`);
  }
  const parents: Record<string, unknown>[] = [];
  for (const parentId of parentIds) {
    await guard();
    const result: Record<string, unknown> = { parentId, fallbackUsed: false };
    parents.push(result);
    let direct: Record<string, unknown>[];
    try {
      direct = read(await eda.sch_PrimitiveAttribute.getAll(parentId));
    } catch (error) {
      result.error = String(error).slice(0, 200);
      warnings.push(`Parent attribute enumeration failed: ${parentId}`);
      continue;
    }
    const accepted = direct.filter((data) => data.parentPrimitiveId === parentId);
    if (accepted.length !== direct.length)
      warnings.push(`Native parent query returned attributes belonging to another parent: ${parentId}`);
    const observed = new Set<string>();
    for (const data of accepted) {
      observed.add(String(data.primitiveId));
      parentObserved.add(String(data.primitiveId));
      add(data, `parent:${parentId}`);
    }
    result.directCount = accepted.length;
    const expected = [...globals.values()]
      .filter((data) => data.parentPrimitiveId === parentId)
      .map((data) => String(data.primitiveId));
    const missing = expected.filter((id) => !observed.has(id));
    if (!accepted.length || missing.length) {
      result.fallbackReason = !accepted.length ? "empty" : "incomplete_vs_global";
      const native = eda.sch_PrimitiveAttribute;
      if (typeof native.getAllPrimitiveId === "function" && typeof native.get === "function") {
        await guard();
        try {
          const ids = await native.getAllPrimitiveId(parentId);
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id))
            throw new Error("Attribute ID query did not return string IDs.");
          const wanted = [...new Set<string>([...ids, ...missing])].filter((id) => !observed.has(id));
          result.fallbackExpectedCount = wanted.length;
          if (wanted.length) {
            if (wanted.length > 2000) throw new Error("Parent attribute fallback exceeds 2000 IDs.");
            await guard();
            const fetched = await native.get(wanted);
            const data = read(Array.isArray(fetched) ? fetched : isRecord(fetched) ? [fetched] : []);
            result.fallbackUsed = true;
            for (const item of data) {
              if (item.parentPrimitiveId !== parentId || !wanted.includes(String(item.primitiveId))) {
                warnings.push(`Fallback returned unexpected attribute/parent for ${parentId}`);
                continue;
              }
              observed.add(String(item.primitiveId));
              parentObserved.add(String(item.primitiveId));
              add(item, `fallback_ids:${parentId}`);
            }
            const missingIds = wanted.filter((id) => !observed.has(id));
            result.missingCount = missingIds.length;
            if (missingIds.length)
              warnings.push(`Fallback left ${missingIds.length} attribute IDs unread for parent ${parentId}.`);
          }
        } catch (error) {
          result.fallbackError = String(error).slice(0, 200);
          warnings.push(`Parent attribute fallback failed: ${parentId}`);
        }
      } else if (missing.length)
        warnings.push(`Parent ${parentId} is incomplete versus global inventory and fallback APIs are unavailable.`);
    }
    result.observedCount = observed.size;
  }
  await guard();
  const globalIds = new Set(
    [...globals.values()]
      .filter((data) => auto || requested.has(String(data.parentPrimitiveId)))
      .map((data) => String(data.primitiveId))
  );
  const parentOnly = [...parentObserved].filter((id) => !globalIds.has(id));
  const globalOnly = [...globalIds].filter((id) => !parentObserved.has(id));
  if (parentOnly.length)
    warnings.push(`Global inventory omitted ${parentOnly.length} attributes observed through explicit parent queries.`);
  if (globalOnly.length)
    warnings.push(
      `${globalOnly.length} globally observed attributes were not confirmed through requested parent queries (possibly independent attributes in auto mode).`
    );
  if (invalidRecords)
    warnings.push(`${invalidRecords} records could not be projected through public attribute getters.`);
  return {
    target,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    snapshotAtomic: false,
    parentMode: auto ? "auto_current_page" : "explicit",
    status: warnings.length ? "partial" : "observed",
    counts: {
      parents: parentIds.length,
      global: globals.size,
      fromParents: parentObserved.size,
      unique: records.size,
      invalidRecords,
      conflicts
    },
    coverage: {
      globalFailed,
      parentOnlyCount: parentOnly.length,
      globalOnlyCount: globalOnly.length,
      parentOnlyIds: parentOnly.slice(0, 50),
      globalOnlyIds: globalOnly.slice(0, 50),
      pageEnumerationVerified: false,
      note: "Native enumeration coverage is reported, not assumed. Parent-only reads cannot prove the absence of independent labels."
    },
    parents,
    attributes: [...records.values()]
      .sort((a, b) => String(a.data.primitiveId).localeCompare(String(b.data.primitiveId)))
      .map((item) => ({ ...item.data, sources: item.sources })),
    warnings
  };
}
