import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const pair = (value: any) =>
  isRecord(value) && typeof value.uuid === "string" && typeof value.libraryUuid === "string"
    ? { uuid: value.uuid, libraryUuid: value.libraryUuid }
    : undefined;
function options(params: Record<string, any>) {
  const identity = params.sourceIdentity;
  if (
    !isRecord(identity) ||
    !["projectId", "schematicName", "pageName"].every(
      (k) =>
        typeof identity[k] === "string" &&
        identity[k].length > 0 &&
        identity[k].length <= 512 &&
        identity[k] === identity[k].trim()
    )
  )
    throw apiError("invalid_params", "Explicit sourceIdentity projectId/schematicName/pageName required.");
  if (
    typeof params.primitiveId !== "string" ||
    !params.primitiveId ||
    params.primitiveId.length > 512 ||
    !/^[a-z0-9]{32}$/i.test(params.libraryUuid ?? "") ||
    typeof params.name !== "string" ||
    !params.name ||
    params.name !== params.name.trim() ||
    params.name.length > 512
  )
    throw apiError("invalid_params", "Explicit primitiveId, 32-character libraryUuid and exact device name required.");
  return {
    sourceIdentity: {
      projectId: String(identity.projectId),
      schematicName: String(identity.schematicName),
      pageName: String(identity.pageName)
    },
    primitiveId: params.primitiveId as string,
    libraryUuid: params.libraryUuid as string,
    name: params.name as string
  };
}
function environment(
  api: () => EasyEdaApi,
  op: ReturnType<typeof options>,
  expectedTarget?: any,
  phase: "prepare" | "apply" = "prepare"
) {
  const eda = api(),
    deadline = Date.now() + 40000;
  for (const [owner, method] of [
    [eda.sch_SourcePrimitiveComponent, "replace"],
    [eda.sch_SourcePrimitiveComponent, "get"],
    [eda.sch_SourceNet, "getConnections"],
    [eda.sch_PrimitiveComponent, "get"],
    [eda.dmt_Schematic, "getCurrentSchematicInfo"],
    [eda.dmt_Schematic, "getSchematicPageInfo"],
    [eda.lib_Device, "search"],
    [eda.lib_Device, "get"]
  ] as const)
    if (typeof owner?.[method] !== "function")
      throw apiError(
        "capability_unavailable",
        `Official replacement and independent source/net/reference readback capability ${method} required before writing.`
      );
  const startedAt = Date.now();
  let writeDispatched = false;
  const bounded = async <T>(step: string, fn: () => Promise<T> | T, write = false): Promise<T> => {
    const remaining = deadline - Date.now();
    const callBudgetMs = Math.max(0, Math.min(write ? 40000 : 5000, remaining));
    const evidence = () => ({
      phase,
      step,
      callBudgetMs,
      overallBudgetMs: 40000,
      elapsedMs: Date.now() - startedAt,
      remainingOverallMs: Math.max(0, deadline - Date.now()),
      writeDispatched,
      retryAllowed: false,
      nativeCancellationAvailable: false
    });
    const timeout = () =>
      apiError(
        "native_observation_timeout",
        `Replacement ${phase} step ${step} exceeded native observation budget ${callBudgetMs}ms (overall40s, elapsed=${Date.now() - startedAt}ms). No native cancellation/retry or subsequent step is performed.`,
        evidence()
      );
    if (remaining <= 0) throw timeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (Date.now() >= deadline) throw timeout();
          if (write) writeDispatched = true;
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout()), callBudgetMs);
        })
      ]);
    } catch (error) {
      if ((error as any)?.code === "native_observation_timeout") throw error;
      throw apiError(
        "native_observation_failed",
        `Replacement ${phase} step ${step} failed: ${String(error)}; budget=${callBudgetMs}ms, elapsed=${Date.now() - startedAt}ms. No automatic retry.`,
        { ...evidence(), causeCode: (error as any)?.code }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const guard = async () => {
    const current = extractDocumentIdentity(
      await bounded("dmt_SelectControl.getCurrentDocumentInfo", () => eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
    );
    if (
      current.documentType !== "schematic" ||
      !current.documentId ||
      current.projectId !== op.sourceIdentity.projectId
    )
      throw apiError("target_mismatch", "Active schematic/project must match the explicit source project.");
    if (expectedTarget) assertDocumentTargetMatch(expectedTarget, current);
    const schematic = await bounded("dmt_Schematic.getCurrentSchematicInfo", () =>
      eda.dmt_Schematic.getCurrentSchematicInfo()
    );
    const page = await bounded("dmt_Schematic.getSchematicPageInfo", () =>
      eda.dmt_Schematic.getSchematicPageInfo(current.documentId)
    );
    if (
      !schematic?.uuid ||
      schematic.name !== op.sourceIdentity.schematicName ||
      page?.uuid !== current.documentId ||
      page.parentSchematicUuid !== schematic.uuid ||
      page.name !== op.sourceIdentity.pageName
    )
      throw apiError(
        "target_mismatch",
        "Explicit source schematic/page names do not match the independently active page."
      );
    return current;
  };
  const value = (result: any, context: string) => {
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value))
      throw apiError("unverified_source", `${context} did not return documented ok:true/value.`, result);
    return result.value as any;
  };
  const snapshot = async (id: string) => {
    await guard();
    const source = value(
      await bounded("sch_SourcePrimitiveComponent.get", () =>
        eda.sch_SourcePrimitiveComponent.get({ ...op.sourceIdentity, primitiveId: id })
      ),
      "sch_SourcePrimitiveComponent.get"
    );
    if (
      source.primitiveId !== id ||
      typeof source.designator !== "string" ||
      !Array.isArray(source.pins) ||
      !source.pins.length ||
      ![source.x, source.y, source.rotation].every(Number.isFinite) ||
      typeof source.mirror !== "boolean" ||
      !isRecord(source.properties)
    )
      throw apiError("unverified_source", "Complete native source component and nonempty pins are required.");
    const raw = await bounded("sch_PrimitiveComponent.get", () => eda.sch_PrimitiveComponent.get(id));
    const uniqueId = raw?.getState_UniqueId?.(),
      component = pair(raw?.getState_Component?.()),
      footprint = pair(raw?.getState_Footprint?.());
    if (raw?.getState_PrimitiveId?.() !== id || typeof uniqueId !== "string" || !uniqueId || !component || !footprint)
      throw apiError(
        "unverified_binding",
        "Independent live component uniqueId/device/footprint references are required; save the schematic first."
      );
    const pins: any[] = [];
    for (const pin of source.pins) {
      if (
        typeof pin.pinId !== "string" ||
        !pin.pinId ||
        typeof pin.pinNumber !== "string" ||
        !pin.pinNumber ||
        ![pin.x, pin.y].every(Number.isFinite)
      )
        throw apiError("unverified_netlinks", "Source pin ID/number/position missing.");
      const connections = value(
        await bounded(`sch_SourceNet.getConnections pinNumber=${pin.pinNumber} pinId=${pin.pinId}`, () =>
          eda.sch_SourceNet.getConnections({ ...op.sourceIdentity, primitiveId: pin.pinId })
        ),
        `sch_SourceNet.getConnections pinNumber=${pin.pinNumber} pinId=${pin.pinId}`
      );
      if (connections.net !== null && typeof connections.net !== "string")
        throw apiError("unverified_netlinks", "Native pin net must be a string or documented null (unconnected).");
      pins.push({ pinNumber: pin.pinNumber, net: connections.net, x: pin.x, y: pin.y });
    }
    if (new Set(pins.map((p) => p.pinNumber)).size !== pins.length)
      throw apiError(
        "ambiguous_pin_map",
        "Duplicate pin numbers cannot be mapped safely by this narrow connector replacement tool."
      );
    pins.sort((a, b) => a.pinNumber.localeCompare(b.pinNumber));
    await guard();
    return JSON.parse(canonicalJson({ source, uniqueId, component, footprint, pins }));
  };
  const catalog = async () => {
    const rows = await bounded("lib_Device.search", () =>
      eda.lib_Device.search(op.name, op.libraryUuid, undefined, undefined, 100, 1)
    );
    if (!Array.isArray(rows) || rows.length >= 100)
      throw apiError("ambiguous_device", "Exact device resolution is incomplete; no replacement permitted.");
    const matches = rows.filter((r) => r?.name === op.name && (!r.libraryUuid || r.libraryUuid === op.libraryUuid));
    if (matches.length !== 1 || typeof matches[0].uuid !== "string")
      throw apiError("ambiguous_device", "Requested library and exact device name must resolve to one catalog item.");
    const item = await bounded("lib_Device.get", () => eda.lib_Device.get(matches[0].uuid, op.libraryUuid));
    if (!isRecord(item) || item.name !== op.name || item.uuid !== matches[0].uuid || !pair(item.footprint))
      throw apiError("unverified_catalog", "Native catalog device and explicit footprint association are required.");
    return {
      device: { uuid: matches[0].uuid, libraryUuid: op.libraryUuid },
      name: op.name,
      footprint: pair(item.footprint),
      model3D: pair(item.model3D) ?? null
    };
  };
  return { eda, bounded, guard, snapshot, catalog };
}
export async function prepareSchematicDeviceReplace(api: () => EasyEdaApi, params: Record<string, any>) {
  const op = options(params),
    env = environment(api, op, params.target),
    target = await env.guard();
  const before = await env.snapshot(op.primitiveId),
    catalog = await env.catalog();
  if (same(before.component, catalog.device))
    throw apiError("no_effective_change", "Component already references the requested catalog device.");
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: "replaceDevice",
    target,
    operation: { ...op, catalog },
    before,
    requestedAfter: {
      device: catalog,
      preserveUniqueId: before.uniqueId,
      preservePinNetMap: before.pins.map((p: any) => ({ pinNumber: p.pinNumber, net: p.net })),
      pcbUpdated: false,
      modelGeometryVerified: false
    },
    changedKeys: ["deviceReference", "footprintReference"],
    scope: `schematic:replace:${op.primitiveId}`,
    impact:
      "Replace exactly one schematic library device using the public source replace API. Preserve independent uniqueId and every pin-number/net/position. No force, create/delete fallback or PCB update. Native model geometry and later PCB sync remain unverified.",
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executeSchematicDeviceReplace(
  api: () => EasyEdaApi,
  record: any
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const op = options(record.operation),
    env = environment(api, op, record.target, "apply");
  await env.guard();
  const before = await env.snapshot(op.primitiveId);
  if (!same(before, record.before) || !same(await env.catalog(), record.operation.catalog))
    throw apiError("stale_snapshot", "Component/pin nets/catalog changed since replacement preview; no write.");
  await env.guard();
  try {
    const result = await env.bounded(
      "sch_SourcePrimitiveComponent.replace",
      () =>
        env.eda.sch_SourcePrimitiveComponent.replace({
          ...op.sourceIdentity,
          primitiveId: op.primitiveId,
          libraryUuid: op.libraryUuid,
          name: op.name
        }),
      true
    );
    if (isRecord(result) && result.ok === false && isRecord(result.error) && result.error.code === "REPLACE_REJECTED") {
      if (!same(await env.snapshot(op.primitiveId), before))
        throw new Error("Native rejection unexpectedly changed the component.");
      throw apiError(
        "native_replace_rejected",
        `REPLACE_REJECTED: ${String(result.error.message ?? "Native pin/symbol tolerance rejected replacement; no change verified.")}`,
        { mutationId: record.mutationId, rejected: true, verified: false, nativeError: result.error }
      );
    }
    if (
      !isRecord(result) ||
      result.ok !== true ||
      !isRecord(result.value) ||
      typeof result.value.primitiveId !== "string" ||
      !result.value.primitiveId
    )
      throw new Error(`Native replace did not return documented success: ${canonicalJson(result)}`);
    const id = result.value.primitiveId,
      after = await env.snapshot(id);
    if (
      after.uniqueId !== before.uniqueId ||
      after.source.designator !== before.source.designator ||
      !same(after.pins, before.pins) ||
      !["x", "y", "rotation", "mirror", "subPartName"].every((k) => same(after.source[k], before.source[k]))
    )
      throw new Error("Replacement changed protected uniqueId/designator/pin-number net map or source geometry.");
    const requested = record.operation.catalog;
    const deviceReferenceVerified = same(after.component, requested.device),
      footprintReferenceVerified = same(after.footprint, requested.footprint);
    if (
      !deviceReferenceVerified &&
      same(after.source.properties, before.source.properties) &&
      same(after.component, before.component)
    )
      throw new Error("Independent source and live references show no replacement; inspect stale/native outcome.");
    await env.guard();
    return {
      executed: true,
      readback: {
        primitiveId: id,
        originalPrimitiveId: op.primitiveId,
        uniqueId: after.uniqueId,
        designator: after.source.designator,
        pinNetMap: after.pins.map((p: any) => ({ pinNumber: p.pinNumber, net: p.net })),
        deviceReference: after.component,
        footprintReference: after.footprint,
        deviceReferenceVerified,
        footprintReferenceVerified,
        schematicVerified: deviceReferenceVerified && footprintReferenceVerified,
        verified: false,
        modelGeometryVerified: false,
        pcbUpdated: false,
        catalogModel3D: requested.model3D,
        sourceProperties: after.source.properties,
        limitations: [
          "Model3D is a catalog association only, not placed PCB geometry proof.",
          "Project-library copies may have different UUIDs; those references remain unverified rather than inferred from names.",
          "PCB importChanges and independent pad/net/3D readback are a separate operation."
        ]
      }
    };
  } catch (error) {
    if ((error as any)?.code === "native_replace_rejected") throw error;
    throw apiError(
      "write_readback_unknown",
      `Schematic device replacement outcome unknown; never replay automatically. mutationId=${record.mutationId}; ${String(error)}`,
      { mutationId: record.mutationId, primitiveId: op.primitiveId }
    );
  }
}
