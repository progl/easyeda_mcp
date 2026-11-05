import { buildNamedStubPlan, parseReviewedPinContract } from "./schematicNamedStubPlan.js";
import { compareSchematicSnapshots } from "./schematicSnapshotDiff.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
import { schematicLegacySnapshotEnvironment } from "./schematicPrune.js";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const namedPair = (v: any) => ({ ...pair(v), name: v?.name });
const pair = (v: any) =>
  v && typeof v.uuid === "string" && typeof v.libraryUuid === "string"
    ? { uuid: v.uuid, libraryUuid: v.libraryUuid }
    : undefined;
function options(p: any) {
  for (const k of ["projectId", "documentId", "expectedBoardName", "protectedBoardName", "primitiveId"])
    if (typeof p[k] !== "string" || !p[k] || p[k] !== p[k].trim() || p[k].length > 512)
      throw apiError("invalid_params", `Explicit ${k} required.`);
  if (p.expectedBoardName === p.protectedBoardName || p.expectedBoardName === "Board1")
    throw apiError("protected_board", "Original Board1/protected board cannot be replaced.");
  if (!["stage", "commit"].includes(p.phase))
    throw apiError("invalid_params", "Explicit stage or commit phase required.");
  const wireStrategy = p.wireStrategy ?? "preserve";
  if (!["preserve", "recreateNamedStubs"].includes(wireStrategy))
    throw apiError("invalid_params", "Explicit supported wireStrategy required.");
  if (wireStrategy === "preserve" && p.stubWires !== undefined)
    throw apiError("invalid_params", "stubWires are only valid with explicit recreateNamedStubs.");
  if (
    wireStrategy === "recreateNamedStubs" &&
    p.phase === "commit" &&
    (!Array.isArray(p.stubWires) ||
      !p.stubWires.length ||
      p.stubWires.length > 100 ||
      p.stubWires.some(
        (v: any) => !v || typeof v.pinNumber !== "string" || !v.pinNumber || typeof v.wireId !== "string" || !v.wireId
      ))
  )
    throw apiError(
      "invalid_params",
      "Explicit reviewed stubWires pinNumber/wireId list required for named-stub commit."
    );
  if (p.reviewedPinContract !== undefined && (p.phase !== "commit" || wireStrategy !== "recreateNamedStubs"))
    throw apiError(
      "invalid_pin_contract",
      "Reviewed2to3 pin contract is commit-only and named-stub-only; preserve remains strict."
    );
  const reviewedPinContract =
    p.reviewedPinContract === undefined ? undefined : parseReviewedPinContract(p.reviewedPinContract);
  const result = {
    ...(reviewedPinContract ? { reviewedPinContract } : {}),
    wireStrategy,
    projectId: p.projectId,
    documentId: p.documentId,
    expectedBoardName: p.expectedBoardName,
    protectedBoardName: p.protectedBoardName,
    primitiveId: p.primitiveId,
    phase: p.phase
  };
  if (p.phase === "commit") {
    if (typeof p.stageMutationId !== "string" || !p.stageMutationId)
      throw apiError("invalid_params", "Applied stageMutationId required.");
    if (!pair(p.expectedFootprint) || typeof p.expectedFootprint.name !== "string" || !p.expectedFootprint.name)
      throw apiError(
        "invalid_params",
        "Commit requires explicitly reviewed full native expectedFootprint from the stage result."
      );
    return {
      ...result,
      stageMutationId: p.stageMutationId,
      ...(wireStrategy === "recreateNamedStubs"
        ? { stubWires: p.stubWires.map((v: any) => ({ pinNumber: v.pinNumber, wireId: v.wireId })) }
        : {}),
      expectedFootprint: {
        ...pair(p.expectedFootprint),
        name: p.expectedFootprint.name
      }
    };
  }
  for (const k of ["temporaryDesignator", "temporaryUniqueId"])
    if (typeof p[k] !== "string" || !p[k] || p[k] !== p[k].trim() || p[k].length > 512)
      throw apiError("invalid_params", `Explicit ${k} required.`);
  if (
    ![p.stagingX, p.stagingY].every(Number.isFinite) ||
    !/^[a-z0-9]{32}$/i.test(p.device?.uuid ?? "") ||
    !/^[a-z0-9]{32}$/i.test(p.device?.libraryUuid ?? "") ||
    typeof p.device?.name !== "string" ||
    !p.device.name
  )
    throw apiError("invalid_params", "Full explicit catalog device and finite stagingX/Y required.");
  return {
    ...result,
    device: p.device,
    stagingX: p.stagingX,
    stagingY: p.stagingY,
    temporaryDesignator: p.temporaryDesignator,
    temporaryUniqueId: p.temporaryUniqueId
  };
}
function envFor(api: () => EasyEdaApi, op: any) {
  const env = schematicLegacySnapshotEnvironment(api, { ...op, componentIds: [], wireIds: [] }, true);
  for (const k of ["create", "modify", "delete"])
    if (typeof env.eda.sch_PrimitiveComponent?.[k] !== "function")
      throw apiError("capability_unavailable", `Public Component.${k} required.`);
  if (op.wireStrategy === "recreateNamedStubs")
    for (const k of ["create", "delete"])
      if (typeof env.eda.sch_PrimitiveWire?.[k] !== "function")
        throw apiError("capability_unavailable", `Public Wire.${k} required for explicit named-stub replacement.`);
  return env;
}
function original(s: any, id: string) {
  const c = s.components.find((c: any) => c.PrimitiveId === id && c.ComponentType === "part");
  if (
    !c ||
    !pair(c.Footprint) ||
    !c.UniqueId ||
    !c.Designator ||
    !s.nativeMembership.some((v: any) => v.uniqueId === c.UniqueId && v.designator === c.Designator) ||
    typeof c.AddIntoBom !== "boolean" ||
    typeof c.AddIntoPcb !== "boolean" ||
    typeof c.SubPartName !== "string" ||
    s.components.some((v: any) => v.PrimitiveId !== id && (v.UniqueId === c.UniqueId || v.Designator === c.Designator))
  )
    throw apiError("invalid_selection", "Unique original part identity/footprint required.");
  const membership = s.nativeMembership.find((v: any) => v.uniqueId === c.UniqueId && v.designator === c.Designator);
  const physical = s.pins.filter((p: any) => p.componentId === id);
  if (
    !membership ||
    membership.pins.length !== physical.length ||
    !membership.pins.every((p: any) => physical.some((q: any) => q.pinNumber === p.pinNumber && q.net === p.net))
  )
    throw apiError(
      "incomplete_pin_membership",
      "Every native pin including NC must have independent public pin geometry; no delete permitted."
    );
  return c;
}
function without(s: any, id: string, ref: string) {
  return {
    ...s,
    components: s.components.filter((c: any) => c.PrimitiveId !== id),
    pins: s.pins.filter((p: any) => p.componentId !== id),
    nativeDesignators: s.nativeDesignators.filter((r: string) => r !== ref),
    nativeMembership: s.nativeMembership.filter(
      (v: any) => v.uniqueId !== s.components.find((c: any) => c.PrimitiveId === id)?.UniqueId
    ),
    nativeUniqueIds: s.nativeUniqueIds.filter(
      (u: string) => u !== s.components.find((c: any) => c.PrimitiveId === id)?.UniqueId
    )
  };
}
function pins(s: any, id: string, c: any) {
  return s.pins
    .filter((p: any) => p.componentId === id)
    .map((p: any) => ({
      number: p.pinNumber,
      x: p.X - c.X,
      y: p.Y - c.Y,
      rotation: p.Rotation,
      length: p.PinLength,
      shape: p.PinShape,
      type: p.PinType
    }))
    .sort((a: any, b: any) => a.number.localeCompare(b.number));
}
function geometry(before: any, after: any, old: any, fresh: any) {
  const a = pins(before, old.PrimitiveId, old),
    b = pins(after, fresh.PrimitiveId, fresh);
  if (
    !a.length ||
    a.length !== b.length ||
    !a.every((p: any, i: number) => {
      const q = b[i];
      return (
        Math.abs(p.x - q.x) <= 1e-6 && Math.abs(p.y - q.y) <= 1e-6 && same({ ...p, x: 0, y: 0 }, { ...q, x: 0, y: 0 })
      );
    })
  )
    throw apiError(
      "incompatible_pin_geometry",
      "Pin numbers/relative geometry differ; original is retained, no delete permitted."
    );
}
function snapshotFailure(
  code: string,
  message: string,
  comparison: ReturnType<typeof compareSchematicSnapshots>
): never {
  const summary = comparison.differences
    .map((d) => `${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`)
    .join("; ");
  throw apiError(code, `${message} ${summary}`, {
    differences: comparison.differences,
    derivedMetadataDiffs: comparison.derivedMetadataDiffs
  });
}
function stageProof(
  before: any,
  after: any,
  op: any,
  id: string,
  requireGeometry = true,
  audit?: { derivedMetadataDiffs: any[] }
) {
  const old = original(before, op.primitiveId),
    fresh = original(after, id);
  const kept = compareSchematicSnapshots(before, without(after, id, fresh.Designator), op.documentId);
  if (audit) audit.derivedMetadataDiffs = kept.derivedMetadataDiffs;
  const failures = [
    ["staged.Designator", fresh.Designator === op.temporaryDesignator],
    ["staged.UniqueId", fresh.UniqueId === op.temporaryUniqueId],
    ["staged.X", fresh.X === op.stagingX],
    ["staged.Y", fresh.Y === op.stagingY],
    ["staged.Rotation", fresh.Rotation === old.Rotation],
    ["staged.Mirror", fresh.Mirror === old.Mirror],
    ["staged.Component.reference", !!pair(fresh.Component)],
    ["staged.Component.name", fresh.Component?.name === op.device.name],
    ["staged.Component.libraryUuid", fresh.Component?.libraryUuid === op.device.libraryUuid],
    ["staged.Footprint.reference", !!pair(fresh.Footprint)],
    ["staged.Footprint.name", fresh.Footprint?.name === op.footprint.name],
    ["staged.Footprint.libraryUuid", fresh.Footprint?.libraryUuid === op.footprint.libraryUuid]
  ]
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  if (failures.length)
    throw apiError(
      "unverified_stage",
      `Stage identity/reference guard failed: ${failures.join(", ")}; no original delete.`,
      { failedChecks: failures }
    );
  if (!kept.equal) snapshotFailure("unverified_stage", "Kept stage snapshot changed; no original delete.", kept);
  if (after.pins.some((p: any) => p.componentId === id && p.net !== ""))
    throw apiError("occupied_staging_position", "Temporary pins must all be native NC; original retained.");
  const stagedPins = after.pins.filter((p: any) => p.componentId === id);
  for (const p of stagedPins) {
    if (before.pins.some((q: any) => Math.hypot(p.X - q.X, p.Y - q.Y) <= 1e-6))
      throw apiError("occupied_staging_position", "Temporary pin overlaps an existing pin; original retained.");
    for (const wire of before.wires) {
      const coords = wire.Line.flat();
      for (let i = 0; i + 3 < coords.length; i += 2) {
        const [x, y, u, v] = coords.slice(i, i + 4),
          dx = u - x,
          dy = v - y;
        const t = Math.max(0, Math.min(1, ((p.X - x) * dx + (p.Y - y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(p.X - x - t * dx, p.Y - y - t * dy) <= 1e-6)
          throw apiError("occupied_staging_position", "Temporary pin touches a native wire; original retained.");
      }
    }
  }
  if (requireGeometry) geometry(before, after, old, fresh);
  return fresh;
}
function stageRecord(op: any) {
  const r = extensionMutations.get(op.stageMutationId);
  if (
    r.domain !== "schematic" ||
    r.action !== "legacyDeviceStage" ||
    r.status !== "applied" ||
    !r.after ||
    !same(
      Object.fromEntries(
        ["projectId", "documentId", "expectedBoardName", "protectedBoardName", "primitiveId"].map((k) => [
          k,
          (r.operation as any)[k]
        ])
      ),
      Object.fromEntries(
        ["projectId", "documentId", "expectedBoardName", "protectedBoardName", "primitiveId"].map((k) => [k, op[k]])
      )
    )
  )
    throw apiError(
      "invalid_stage_receipt",
      "Matching applied stage receipt required; unknown stages cannot be replayed or committed."
    );
  return r as any;
}
export async function prepareLegacyDeviceRecreate(api: () => EasyEdaApi, params: Record<string, any>) {
  const op: any = options(params),
    env = envFor(api, op),
    context = await env.guard(),
    before = await env.snapshot();
  const old = original(before, op.primitiveId);
  if (op.phase === "stage") {
    if (typeof env.eda.lib_Device?.get !== "function")
      throw apiError("capability_unavailable", "Public lib_Device.get required.");
    const device = await env.read("lib_Device.get", () =>
      env.eda.lib_Device.get(op.device.uuid, op.device.libraryUuid)
    );
    if (
      !device ||
      !same(pair(device), pair(op.device)) ||
      device.name !== op.device.name ||
      !pair(device.association?.footprint)
    )
      throw apiError("invalid_device_reference", "Exact catalog device with real associated footprint required.");
    op.device = device;
    if (typeof env.eda.lib_Footprint?.get !== "function")
      throw apiError("capability_unavailable", "Public lib_Footprint.get metadata required before stage create.");
    const ref = device.association.footprint;
    const footprint = await env.read("lib_Footprint.get", () => env.eda.lib_Footprint.get(ref.uuid, ref.libraryUuid));
    if (!footprint || !same(pair(footprint), pair(ref)) || typeof footprint.name !== "string" || !footprint.name)
      throw apiError("unverified_catalog_footprint", "Catalog footprint metadata/reference required before write.");
    op.footprint = { ...pair(footprint), name: footprint.name };
    if (
      before.nativeDesignators.includes(op.temporaryDesignator) ||
      before.nativeUniqueIds.includes(op.temporaryUniqueId) ||
      before.components.some(
        (c: any) => c.Designator === op.temporaryDesignator || c.UniqueId === op.temporaryUniqueId
      ) ||
      (op.stagingX === old.X && op.stagingY === old.Y)
    )
      throw apiError("occupied_staging_position", "Temporary identity/position must differ from current parts.");
  } else {
    const stage = stageRecord(op);
    const comparison = compareSchematicSnapshots(stage.after.snapshot, before, op.documentId);
    if (!comparison.equal)
      snapshotFailure("stale_snapshot", "Page changed after staging; no original delete.", comparison);
    stageProof(
      stage.before,
      before,
      stage.operation,
      stage.after.stagedPrimitiveId,
      op.wireStrategy !== "recreateNamedStubs"
    );
    if (op.wireStrategy === "recreateNamedStubs")
      op.wirePlan = buildNamedStubPlan(
        before,
        op.primitiveId,
        stage.after.stagedPrimitiveId,
        op.stubWires,
        op.reviewedPinContract
      );
    if (!same(op.expectedFootprint, stage.after.cachedFootprint))
      throw apiError(
        "unreviewed_footprint",
        "Commit expectedFootprint must exactly match the explicitly reviewed real cached stage reference."
      );
  }
  const r = extensionMutations.prepare({
    domain: "schematic",
    action: op.phase === "stage" ? "legacyDeviceStage" : "legacyDeviceCommit",
    target: context.target,
    operation: op,
    before,
    requestedAfter: {
      phase: op.phase,
      originalPrimitiveId: op.primitiveId,
      wireStrategy: op.wireStrategy,
      ...(op.wirePlan ? { wirePlan: op.wirePlan } : {}),
      preservedUniqueId: old.UniqueId,
      preservedDesignator: old.Designator,
      catalogDeviceReference:
        op.phase === "stage"
          ? { ...pair(op.device), name: op.device.name }
          : { ...pair(stageRecord(op).operation.device), name: stageRecord(op).operation.device.name },
      catalogFootprintReference: op.phase === "stage" ? op.footprint : stageRecord(op).operation.footprint,
      actualReviewedFootprint: op.phase === "commit" ? op.expectedFootprint : null,
      oldNativeFootprint: old.Footprint,
      copperPadGeometryVerified: false,
      originalRetainedUntilSeparateCommit: true,
      pcbSyncVerified: false,
      modelGeometryVerified: false,
      catalogOriginVerified: false
    },
    changedKeys: [op.phase === "stage" ? "stagedComponent" : "replacedComponent"],
    scope: `schematic:legacy-recreate:${op.documentId}`,
    impact:
      "Legacy staged recreate on copied board only. No Source API, implicit wire changes, rollback, cleanup, PCB sync or mutation replay. Stage mismatch retains both parts. Commit separately deletes original once and modifies staged part once only after exact independent native proof.",
    ttlMs: 300000
  });
  return {
    mutationId: r.mutationId,
    confirmation: r.confirmation,
    target: r.target,
    preview: r.preview,
    expiresAt: r.expiresAt
  };
}
export async function executeLegacyDeviceRecreate(api: () => EasyEdaApi, record: any) {
  const op: any = record.operation,
    env = envFor(api, op),
    before = await env.snapshot();
  const preflightComparison = compareSchematicSnapshots(record.before, before, op.documentId);
  if (!preflightComparison.equal)
    snapshotFailure("stale_snapshot", "Full native snapshot changed; no write.", preflightComparison);
  const old = original(before, op.primitiveId),
    journal: any = {
      phase: "preflight",
      sdkPending: false,
      createCalls: 0,
      modifyCalls: 0,
      deleteCalls: 0,
      wireCreateCalls: 0,
      wireDeleteCalls: 0,
      createdWireIds: []
    };
  let write = false;
  const progress = (phase: string) => {
    journal.phase = phase;
    extensionMutations.recordExecutionEvidence(record.mutationId, journal);
  };
  const guard = async () => {
    env.ensure();
    await env.guard();
    env.ensure();
    if (extensionMutations.get(record.mutationId).status !== "running")
      throw new Error("Lifecycle expired; no subsequent native write.");
  };
  const call = async (kind: "create" | "modify" | "delete" | "wireDelete" | "wireCreate", fn: () => Promise<any>) => {
    await guard();
    write = true;
    journal.sdkPending = true;
    journal[`${kind}Calls`]++;
    progress(`${kind}_dispatched`);
    try {
      return await fn();
    } finally {
      journal.sdkPending = false;
      progress(`${kind}_settled`);
    }
  };
  try {
    if (op.phase === "stage") {
      // Original SDK write promises are never raced/cancelled; lifecycle keeps its lock until settlement.
      const created = await call("create", () =>
        env.eda.sch_PrimitiveComponent.create(
          op.device,
          op.stagingX,
          op.stagingY,
          undefined, // Let the requested catalog device select its own default symbol subpart.
          old.Rotation,
          old.Mirror,
          old.AddIntoBom,
          old.AddIntoPcb
        )
      );
      const id = created?.getState_PrimitiveId?.() ?? created?.primitiveId;
      journal.stagedPrimitiveId = id ?? null;
      if (typeof id !== "string" || !id) throw new Error("Create returned no native ID; do not recreate.");
      await call("modify", () =>
        env.eda.sch_PrimitiveComponent.modify(id, {
          designator: op.temporaryDesignator,
          uniqueId: op.temporaryUniqueId
        })
      );
      const after = await env.snapshot(),
        audit = { derivedMetadataDiffs: [] as any[] };
      const freshStage = stageProof(before, after, op, id, op.wireStrategy !== "recreateNamedStubs", audit);
      let geometryCompatible = true;
      if (op.wireStrategy === "recreateNamedStubs")
        try {
          geometry(before, after, old, freshStage);
        } catch (error) {
          if ((error as any)?.code !== "incompatible_pin_geometry") throw error;
          geometryCompatible = false;
        }
      progress("stage_verified");
      return {
        executed: true,
        readback: {
          verified: true,
          phase: "stage",
          geometryCompatible,
          originalPinGeometry: pins(before, op.primitiveId, old),
          stagedPinGeometry: pins(after, id, freshStage),
          wireStrategy: op.wireStrategy ?? "preserve",
          stagedPrimitiveId: id,
          snapshot: after,
          catalogDeviceReference: { ...pair(op.device), name: op.device.name },
          catalogFootprintReference: op.footprint,
          copperPadGeometryVerified: false,
          cachedComponent: namedPair(after.components.find((c: any) => c.PrimitiveId === id).Component),
          cachedFootprint: namedPair(after.components.find((c: any) => c.PrimitiveId === id).Footprint),
          catalogOriginVerified: false,
          originalRetained: true,
          derivedMetadataDiffs: [...preflightComparison.derivedMetadataDiffs, ...audit.derivedMetadataDiffs],
          pcbSyncVerified: false,
          modelGeometryVerified: false
        }
      };
    }
    const stage = stageRecord(op),
      id = stage.after.stagedPrimitiveId;
    stageProof(stage.before, before, stage.operation, id, op.wireStrategy !== "recreateNamedStubs");
    const wirePlan =
      op.wireStrategy === "recreateNamedStubs"
        ? buildNamedStubPlan(before, op.primitiveId, id, op.stubWires, op.reviewedPinContract)
        : undefined;
    if (wirePlan && !same(wirePlan, op.wirePlan))
      throw apiError("stale_snapshot", "Reviewed named-stub plan changed; no delete.");
    if (!same(op.expectedFootprint, stage.after.cachedFootprint))
      throw apiError("unreviewed_footprint", "Reviewed cached footprint changed; no delete.");
    const result = await call("delete", () => env.eda.sch_PrimitiveComponent.delete([op.primitiveId]));
    if (result !== true) throw new Error("Original delete not acknowledged; no final modify.");
    const absenceDeadline = Math.min(env.deadline, Date.now() + 3000);
    let absent = false;
    do {
      const remaining = await env.componentRows();
      journal.absenceReadPolls = (journal.absenceReadPolls ?? 0) + 1;
      if (!remaining.some((c: any) => c.PrimitiveId === op.primitiveId)) {
        absent = true;
        break;
      }
      if (Date.now() >= absenceDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, absenceDeadline - Date.now())));
    } while (Date.now() <= absenceDeadline);
    if (!absent) throw new Error("Original still present after bounded read-only observation; no final modify.");
    if (wirePlan) {
      const deleted = await call("wireDelete", () => env.eda.sch_PrimitiveWire.delete(wirePlan.oldWireIds));
      if (deleted !== true)
        throw new Error("Selected native wire batch delete not acknowledged; no final modify/stub create.");
      const until = Math.min(env.deadline, Date.now() + 3000);
      let gone = false;
      do {
        const raw = await env.read("Wire.getAll after explicit deletion", () => env.eda.sch_PrimitiveWire.getAll());
        if (!Array.isArray(raw)) throw new Error("Native wire array unavailable after delete.");
        const ids = raw.map((w: any) =>
          typeof w.getState_PrimitiveId === "function" ? w.getState_PrimitiveId() : w.primitiveId
        );
        journal.wireAbsenceReadPolls = (journal.wireAbsenceReadPolls ?? 0) + 1;
        if (wirePlan.oldWireIds.every((v: string) => !ids.includes(v))) {
          gone = true;
          break;
        }
        if (Date.now() >= until) break;
        await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
      } while (Date.now() <= until);
      if (!gone) throw new Error("An explicitly deleted old stub remains; no final modify/stub create.");
    }
    await call("modify", () =>
      env.eda.sch_PrimitiveComponent.modify(id, {
        x: old.X,
        y: old.Y,
        rotation: old.Rotation,
        mirror: old.Mirror,
        uniqueId: old.UniqueId,
        designator: old.Designator,
        addIntoBom: old.AddIntoBom,
        addIntoPcb: old.AddIntoPcb
      })
    );
    const executedStubs: any[] = [];
    if (wirePlan) {
      const value = (v: any, key: string) =>
        typeof v?.[`getState_${key}`] === "function"
          ? v[`getState_${key}`]()
          : v?.[key[0].toLowerCase() + key.slice(1)];
      let pinRows: Array<{ number: string; x: number; y: number; rotation: number }> = [];
      const pinsDeadline = Math.min(env.deadline, Date.now() + 3000);
      let ready = false;
      do {
        const rawPins = await env.read("Native new pins after final component modify", () =>
          env.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)
        );
        journal.finalPinReadPolls = (journal.finalPinReadPolls ?? 0) + 1;
        pinRows = Array.isArray(rawPins)
          ? rawPins.map((p: any) => ({
              number: String(value(p, "PinNumber") ?? ""),
              x: value(p, "X"),
              y: value(p, "Y"),
              rotation: value(p, "Rotation")
            }))
          : [];
        ready =
          pinRows.length === wirePlan.stubs.length + (wirePlan.extraNCpins?.length ?? 0) &&
          (wirePlan.extraNCpins ?? []).every((extra: any) => {
            const p = pinRows.find((p) => p.number === extra.pinNumber);
            return p && p.x === extra.X && p.y === extra.Y && p.rotation === extra.Rotation;
          }) &&
          new Set(pinRows.map((p) => p.number)).size === pinRows.length &&
          wirePlan.stubs.every((stub: any) => {
            const p = pinRows.find((p) => p.number === stub.pinNumber);
            return (
              p &&
              [p.x, p.y, p.rotation].every(Number.isFinite) &&
              p.x === stub.newLine[0] &&
              p.y === stub.newLine[1] &&
              p.rotation === stub.newPinRotation
            );
          });
        if (ready) break;
        if (Date.now() >= pinsDeadline) break;
        await new Promise((r) => setTimeout(r, Math.min(100, pinsDeadline - Date.now())));
      } while (Date.now() <= pinsDeadline);
      if (!ready)
        throw new Error(
          "Final native pin numbers/positions/rotations differ from reviewed plan after read-only poll; no stub create."
        );
      for (const stub of wirePlan.stubs) {
        const p = pinRows.find((p) => p.number === stub.pinNumber);
        if (
          !p ||
          ![p.x, p.y].every(Number.isFinite) ||
          Math.abs(p.x - stub.newLine[0]) > 1e-6 ||
          Math.abs(p.y - stub.newLine[1]) > 1e-6
        )
          throw new Error(`Native final pin ${stub.pinNumber} differs from reviewed plan; no stub create.`);
      }
      for (const stub of wirePlan.stubs) {
        const p = pinRows.find((p) => p.number === stub.pinNumber)!;
        const line = [p.x, p.y, p.x + stub.newLine[2] - stub.newLine[0], p.y + stub.newLine[3] - stub.newLine[1]];
        const created = await call("wireCreate", () =>
          env.eda.sch_PrimitiveWire.create(line, stub.net, stub.color, stub.lineWidth, stub.lineType)
        );
        const wireId = created?.getState_PrimitiveId?.() ?? created?.primitiveId;
        if (
          typeof wireId !== "string" ||
          !wireId ||
          before.wires.some((w: any) => w.PrimitiveId === wireId) ||
          journal.createdWireIds.includes(wireId)
        )
          throw new Error(`Native stub ${stub.pinNumber} returned no distinct new wire ID; no replay.`);
        journal.createdWireIds.push(wireId);
        executedStubs.push({ ...stub, createdWireId: wireId, line });
        progress("wire_create_verified_id");
      }
    }
    const after = await env.snapshot(),
      fresh = original(after, id);
    if (
      after.components.some((c: any) => c.PrimitiveId === op.primitiveId) ||
      fresh.UniqueId !== old.UniqueId ||
      fresh.Designator !== old.Designator ||
      fresh.X !== old.X ||
      fresh.Y !== old.Y ||
      fresh.Rotation !== old.Rotation ||
      fresh.Mirror !== old.Mirror ||
      fresh.AddIntoBom !== old.AddIntoBom ||
      fresh.AddIntoPcb !== old.AddIntoPcb ||
      !same(namedPair(fresh.Footprint), stage.after.cachedFootprint) ||
      !same(namedPair(fresh.Component), stage.after.cachedComponent)
    )
      throw new Error("Final native identity/pose/footprint mismatch.");
    if (wirePlan) {
      geometry(stage.after.snapshot, after, original(stage.after.snapshot, id), fresh);
      for (const stub of executedStubs) {
        const w = after.wires.find((w: any) => w.PrimitiveId === stub.createdWireId);
        const pts = Array.isArray(w?.Line) ? w.Line.flat() : [];
        const equal = (a: number[], b: number[]) =>
          a.length === b.length && a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) <= 1e-6);
        if (
          !w ||
          w.Net !== stub.net ||
          !(equal(pts, stub.line) || equal(pts, [stub.line[2], stub.line[3], stub.line[0], stub.line[1]]))
        )
          throw new Error(`Native created wire ${stub.createdWireId} net/geometry mismatch.`);
      }
      if (after.wires.some((w: any) => wirePlan.oldWireIds.includes(w.PrimitiveId)))
        throw new Error("An old selected wire remains after stub recreation.");
    } else geometry(before, after, old, fresh);
    const oldMap = before.pins
      .filter((p: any) => p.componentId === old.PrimitiveId)
      .map((p: any) => ({ number: p.pinNumber, net: p.net }))
      .sort((a: any, b: any) => a.number.localeCompare(b.number));
    const newMap = after.pins
      .filter((p: any) => p.componentId === id)
      .map((p: any) => ({ number: p.pinNumber, net: p.net }))
      .sort((a: any, b: any) => a.number.localeCompare(b.number));
    const expectedKept = without(
      without(before, old.PrimitiveId, old.Designator),
      id,
      stage.operation.temporaryDesignator
    );
    const actualKept = without(after, id, old.Designator);
    if (wirePlan) {
      expectedKept.wires = expectedKept.wires.filter((w: any) => !wirePlan.oldWireIds.includes(w.PrimitiveId));
      actualKept.wires = actualKept.wires.filter((w: any) => !journal.createdWireIds.includes(w.PrimitiveId));
    }
    const expectedMap = op.reviewedPinContract
      ? [
          ...oldMap.map((p: any) => ({
            number: op.reviewedPinContract.mapping.find((m: any) => m.oldPinNumber === p.number)?.newPinNumber,
            net: p.net
          })),
          ...op.reviewedPinContract.extraNCpins.map((p: any) => ({ number: p.pinNumber, net: "" }))
        ].sort((a: any, b: any) => a.number.localeCompare(b.number))
      : oldMap;
    if (!same(expectedMap, newMap))
      throw new Error("Native reviewed pin mapping/extraNC or original pin net/NC map changed.");
    const finalComparison = compareSchematicSnapshots(expectedKept, actualKept, op.documentId);
    if (!finalComparison.equal)
      snapshotFailure("unverified_replacement", "Kept parts/wires/texts changed.", finalComparison);
    progress("replacement_verified");
    return {
      executed: true,
      readback: {
        verified: true,
        phase: "commit",
        ...(op.reviewedPinContract
          ? {
              reviewedPinContract: op.reviewedPinContract,
              expectedPinNets: expectedMap,
              observedPinNets: newMap,
              extraNativeNcVerified: true
            }
          : {}),
        oldPrimitiveId: op.primitiveId,
        newPrimitiveId: id,
        uniqueId: fresh.UniqueId,
        designator: fresh.Designator,
        pinNetMap: newMap,
        footprint: fresh.Footprint,
        wiresUnchanged: !wirePlan,
        keptWiresUnchanged: true,
        wireStrategy: op.wireStrategy ?? "preserve",
        ...(wirePlan
          ? { deletedWireIds: wirePlan.oldWireIds, createdWireIds: journal.createdWireIds, stubs: executedStubs }
          : {}),
        keptPartsUnchanged: true,
        derivedMetadataDiffs: [...preflightComparison.derivedMetadataDiffs, ...finalComparison.derivedMetadataDiffs],
        fullNativeSchematicMembershipUnchanged: true,
        catalogOriginVerified: false,
        copperPadGeometryVerified: false,
        pcbSyncVerified: false,
        modelGeometryVerified: false
      }
    };
  } catch (error) {
    progress("stopped");
    if (write)
      throw apiError(
        "write_readback_unknown",
        `Legacy recreate stopped after native write; no retry/rollback/cleanup. ${String(error)}`,
        journal
      );
    throw error;
  }
}

/** Reconcile only a settled SDK stage outcome; never writes CAD or assumes pin compatibility. */
export async function reconcileLegacyDeviceStage(api: () => EasyEdaApi, params: Record<string, any>) {
  if (typeof params.mutationId !== "string" || !params.mutationId)
    throw apiError("invalid_params", "Original settled stage mutationId required.");
  return extensionMutations.reconcileSettledUnknown({
    mutationId: params.mutationId,
    domain: "schematic",
    action: "legacyDeviceStage",
    allowVerifiedAppliedRestore: true,
    originalRecord: params.originalRecord,
    verify: async (record) => {
      const op: any = record.operation,
        evidence: any = record.executionEvidence;
      options(op);
      const id = evidence?.stagedPrimitiveId;
      if (
        op.phase !== "stage" ||
        typeof id !== "string" ||
        !id ||
        evidence.createCalls !== 1 ||
        evidence.modifyCalls !== 1 ||
        evidence.deleteCalls !== 0 ||
        evidence.sdkPending !== false ||
        !op.footprint ||
        !record.before?.nativeMembership
      )
        throw apiError(
          "reconciliation_unproven",
          "Exact stage operation/before and settled one-create/one-modify/no-delete evidence required."
        );
      const restoredApplied = record.status === "applied";
      if (
        restoredApplied &&
        (!record.after?.snapshot ||
          record.after.verified !== true ||
          record.after.phase !== "stage" ||
          record.after.originalRetained !== true ||
          record.after.stagedPrimitiveId !== id ||
          !pair(record.after.cachedComponent) ||
          !pair(record.after.cachedFootprint))
      )
        throw apiError(
          "reconciliation_unproven",
          "Complete applied stage after/snapshot/native cached references must match settled SDK stage ID."
        );
      const env = envFor(api, op);
      await env.guard();
      const after = await env.snapshot();
      if (restoredApplied) {
        const comparison = compareSchematicSnapshots(record.after.snapshot, after, op.documentId);
        if (!comparison.equal)
          snapshotFailure(
            "reconciliation_unproven",
            "Applied stage native snapshot changed; no registry restoration.",
            comparison
          );
      }
      const audit = { derivedMetadataDiffs: [] as any[] };
      const fresh = stageProof(record.before, after, op, id, false, audit),
        old = original(record.before, op.primitiveId);
      if (
        restoredApplied &&
        (!same(record.after.cachedComponent, namedPair(fresh.Component)) ||
          !same(record.after.cachedFootprint, namedPair(fresh.Footprint)))
      )
        throw apiError(
          "reconciliation_unproven",
          "Applied cached component/footprint differs from exact native references; no registry restoration."
        );
      let geometryCompatible = true;
      try {
        geometry(record.before, after, old, fresh);
      } catch (error) {
        if ((error as any)?.code !== "incompatible_pin_geometry") throw error;
        geometryCompatible = false;
      }
      return {
        verified: true,
        phase: "stage",
        reconciledReadOnly: true,
        stagedPrimitiveId: id,
        snapshot: after,
        originalRetained: true,
        derivedMetadataDiffs: audit.derivedMetadataDiffs,
        geometryCompatible,
        originalPinGeometry: pins(record.before, op.primitiveId, old),
        stagedPinGeometry: pins(after, id, fresh),
        cachedComponent: namedPair(fresh.Component),
        cachedFootprint: namedPair(fresh.Footprint),
        catalogDeviceReference: { ...pair(op.device), name: op.device.name },
        catalogFootprintReference: op.footprint,
        catalogOriginVerified: false,
        copperPadGeometryVerified: false,
        pcbSyncVerified: false,
        modelGeometryVerified: false,
        nativeCreateReplayed: false,
        nativeDeleteInvoked: false,
        proofScope: "staged_creation_and_original_kept_native_snapshot_unchanged"
      };
    }
  });
}
