import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import { canonicalJson, formatMutationConfirmation } from "../../../src/mutation/contracts.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";

type Selection = { trackIds: string[]; viaIds: string[] };
type Snapshot = { tracks: any[]; vias: any[]; components: any[]; pads: number };
const snapshots = new Map<
  string,
  { expiresAt: number; target: DocumentIdentity; state: Snapshot; selection: Selection }
>();
const value = (p: any, key: string) =>
  typeof p?.[`getState_${key}`] === "function" ? p[`getState_${key}`]() : p?.[key[0].toLowerCase() + key.slice(1)];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function selection(params: Record<string, any>): Selection {
  if (
    (Array.isArray(params.nets) && params.nets.length) ||
    (Array.isArray(params.ignoreNets) && params.ignoreNets.length)
  )
    throw apiError(
      "explicit_ids_required",
      "Unroute requires explicit trackIds/viaIds only; net-based automatic clearing is unsupported."
    );
  const parse = (ids: unknown): string[] => {
    if (ids === undefined) return [];
    if (
      !Array.isArray(ids) ||
      ids.length > 5000 ||
      ids.some((id) => typeof id !== "string" || !id.length || id !== id.trim() || id.length > 512)
    )
      throw apiError("explicit_ids_required", "Explicit IDs must be nonempty unique strings, at most 5000 total.");
    return ids;
  };
  const trackIds = parse(params.trackIds),
    viaIds = parse(params.viaIds),
    all = [...trackIds, ...viaIds];
  if (!all.length || all.length > 5000 || new Set(all).size !== all.length)
    throw apiError(
      "explicit_ids_required",
      "Unroute requires 1–5000 unique explicit trackIds/viaIds; no implicit clearRouting call is used."
    );
  return { trackIds: [...trackIds], viaIds: [...viaIds] };
}
function environment(api: () => EasyEdaApi, target?: Partial<DocumentIdentity>) {
  const eda = api(),
    deadline = Date.now() + 40000;
  const ensure = () => {
    if (Date.now() >= deadline)
      throw apiError("execution_budget_expired", "Explicit unroute 40s budget expired; no later deletes will start.");
  };
  const bounded = async <T>(call: () => T | Promise<T>): Promise<T> => {
    ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          ensure();
          return call();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                apiError(
                  "execution_budget_expired",
                  "Explicit unroute native call exceeded 40s budget; no later deletes will start."
                )
              ),
            Math.max(1, deadline - Date.now())
          );
        })
      ]);
      ensure();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const guard = async () => {
    const current = extractDocumentIdentity(await bounded(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.()));
    if (current.documentType !== "pcb" || !current.documentId || !current.projectId)
      throw apiError("invalid_target", "Explicit unroute requires identifiable active PCB/project.");
    if (target) assertDocumentTargetMatch(target, current);
    ensure();
    return current;
  };
  const requireApi = (owner: any, methods: string[], name: string) => {
    if (!methods.every((k) => typeof owner?.[k] === "function"))
      throw apiError("capability_unavailable", `${name} requires ${methods.join(", ")}; nothing deleted.`);
  };
  requireApi(eda.pcb_PrimitiveLine, ["getAll"], "Line inventory");
  requireApi(eda.pcb_PrimitiveVia, ["getAll"], "Via inventory");
  requireApi(eda.pcb_PrimitiveComponent, ["getAll", "getAllPinsByPrimitiveId"], "Component/pad inventory");
  const array = (raw: unknown, name: string): any[] => {
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", `${name} did not return a native array.`);
    return raw;
  };
  const byId = (items: any[], name: string) => {
    const ids = items.map((p) => p.primitiveId);
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length)
      throw apiError("unverified_inventory", `${name} inventory has missing/duplicate native IDs.`);
    return items.sort((a, b) => a.primitiveId.localeCompare(b.primitiveId));
  };
  const snapshot = async (chosen: Selection): Promise<Snapshot> => {
    await guard();
    const rawTracks = array(await bounded(() => eda.pcb_PrimitiveLine.getAll()), "Line"),
      rawVias = array(await bounded(() => eda.pcb_PrimitiveVia.getAll()), "Via");
    const selectedTracks = new Set(chosen.trackIds),
      selectedVias = new Set(chosen.viaIds);
    for (const [list, ids, kind] of [
      [rawTracks, selectedTracks, "track"],
      [rawVias, selectedVias, "via"]
    ] as const) {
      for (const raw of list)
        if (
          ids.has(value(raw, "PrimitiveId")) &&
          typeof raw.getParent === "function" &&
          (await bounded(() => raw.getParent())) != null
        )
          throw apiError("embedded_primitive", `Selected ${kind} has a native parent; deletion refused before write.`);
    }
    const tracks = byId(
      rawTracks.map((p) => {
        const row = Object.fromEntries(
          ["PrimitiveId", "Net", "Layer", "StartX", "StartY", "EndX", "EndY", "LineWidth", "PrimitiveLock"].map((k) => [
            k[0].toLowerCase() + k.slice(1),
            value(p, k)
          ])
        );
        if (
          ![row.startX, row.startY, row.endX, row.endY, row.lineWidth].every(Number.isFinite) ||
          typeof row.net !== "string"
        )
          throw apiError("unverified_geometry", "Native track geometry/net missing.");
        if (
          selectedTracks.has(String(row.primitiveId)) &&
          ![1, 2, ...Array.from({ length: 32 }, (_, i) => i + 15)].includes(Number(row.layer))
        )
          throw apiError("invalid_selection", "Selected Line is not on a copper signal layer.");
        return row;
      }),
      "Track"
    );
    const vias = byId(
      rawVias.map((p) => {
        const row = Object.fromEntries(
          ["PrimitiveId", "Net", "X", "Y", "Diameter", "HoleDiameter", "StartLayer", "EndLayer", "PrimitiveLock"].map(
            (k) => [k[0].toLowerCase() + k.slice(1), value(p, k)]
          )
        );
        if (![row.x, row.y, row.diameter, row.holeDiameter].every(Number.isFinite) || typeof row.net !== "string")
          throw apiError("unverified_geometry", "Native via geometry/net missing.");
        return row;
      }),
      "Via"
    );
    const rawComponents = array(await bounded(() => eda.pcb_PrimitiveComponent.getAll()), "Components");
    if (!rawComponents.length)
      throw apiError("unverified_inventory", "A nonempty component inventory is required for protected PCB clearing.");
    const components: any[] = [];
    let pads = 0;
    // Read-only calls may run in parallel; mutations below remain strictly sequential.
    for (let offset = 0; offset < rawComponents.length; offset += 8) {
      await guard();
      const chunk = await Promise.all(
        rawComponents.slice(offset, offset + 8).map(async (c) => {
          const row = Object.fromEntries(
            [
              "PrimitiveId",
              "Designator",
              "UniqueId",
              "Footprint",
              "Component",
              "Value",
              "X",
              "Y",
              "Rotation",
              "Layer"
            ].map((k) => [k[0].toLowerCase() + k.slice(1), value(c, k)])
          );
          if (
            typeof row.primitiveId !== "string" ||
            !row.primitiveId ||
            row.footprint === undefined ||
            ![row.x, row.y].every(Number.isFinite)
          )
            throw apiError("unverified_inventory", "Component identity/footprint/coordinates unavailable.");
          const rawPads = array(
            await bounded(() => eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(row.primitiveId)),
            "Component pads"
          );
          const pinMap = rawPads
            .map((p) => {
              const pin = {
                primitiveId: value(p, "PrimitiveId"),
                padNumber: value(p, "PadNumber"),
                net: value(p, "Net")
              };
              if (typeof pin.primitiveId !== "string" || !pin.primitiveId || typeof pin.net !== "string")
                throw apiError("unverified_netlinks", "A protected pad lacks native ID/net readback.");
              return pin;
            })
            .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
          return { ...row, pads: pinMap };
        })
      );
      for (const row of chunk) {
        components.push(row);
        pads += row.pads.length;
      }
    }
    await guard();
    return JSON.parse(canonicalJson({ tracks, vias, components: byId(components, "Component"), pads }));
  };
  return { eda, bounded, guard, snapshot, requireApi };
}
function requireSelected(state: Snapshot, chosen: Selection) {
  for (const [kind, ids, list] of [
    ["track", chosen.trackIds, state.tracks],
    ["via", chosen.viaIds, state.vias]
  ] as const) {
    const available = new Set(list.map((p) => p.primitiveId));
    if (ids.some((id) => !available.has(id)))
      throw apiError(
        "missing_selected_primitive",
        `An explicit ${kind} ID is absent; no automatic replacement/clearing is allowed.`
      );
  }
}
function summary(state: Snapshot, chosen: Selection) {
  return {
    components: state.components.length,
    pads: state.pads,
    totalTracks: state.tracks.length,
    totalVias: state.vias.length,
    selectedTracks: chosen.trackIds.length,
    selectedVias: chosen.viaIds.length,
    preservedTracks: state.tracks.length - chosen.trackIds.length,
    preservedVias: state.vias.length - chosen.viaIds.length
  };
}
export async function prepareExplicitUnroute(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  const chosen = selection(params),
    env = environment(api, params.target),
    target = await env.guard();
  if (chosen.trackIds.length) env.requireApi(env.eda.pcb_PrimitiveLine, ["delete"], "Line");
  if (chosen.viaIds.length) env.requireApi(env.eda.pcb_PrimitiveVia, ["delete"], "Via");
  const state = await env.snapshot(chosen);
  requireSelected(state, chosen);
  const key = `unroute-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  for (const [k, v] of snapshots) if (v.expiresAt < Date.now()) snapshots.delete(k);
  if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(key, { expiresAt: Date.now() + 300000, target, state, selection: chosen });
  const before = { ...summary(state, chosen), inventory: state };
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: "unroute",
    target,
    operation: { action: "unroute", ...chosen, target, snapshotKey: key },
    before,
    previewBefore: summary(state, chosen),
    requestedAfter: {
      deletedTracks: chosen.trackIds.length,
      deletedVias: chosen.viaIds.length,
      protectedInventoryUnchanged: true
    },
    changedKeys: ["deletedTrackIds", "deletedViaIds"],
    scope: `pcb:explicit-unroute:${target.documentId}`,
    impact: `DESTRUCTIVE: delete exactly ${chosen.trackIds.length} native Line IDs and ${chosen.viaIds.length} Via IDs in batches≤250. Preserve ${state.components.length} components, ${state.pads} pad netlinks and every unselected track/via. No inferred parent-ID classification or clearRouting call.`,
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: "unroute",
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executeExplicitUnroute(
  api: () => EasyEdaApi,
  op: Record<string, any>
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const chosen = selection(op),
    stored = snapshots.get(String(op.snapshotKey));
  if (!stored || stored.expiresAt < Date.now() || !same(chosen, stored.selection))
    throw apiError(
      "stale_snapshot",
      "Unroute snapshot missing/expired/consumed; inspect current inventory before preparing again."
    );
  const env = environment(api, stored.target);
  let started = false;
  if (chosen.trackIds.length) env.requireApi(env.eda.pcb_PrimitiveLine, ["delete"], "Line");
  if (chosen.viaIds.length) env.requireApi(env.eda.pcb_PrimitiveVia, ["delete"], "Via");
  const fresh = await env.snapshot(chosen);
  requireSelected(fresh, chosen);
  if (!same(fresh, stored.state))
    throw apiError("stale_snapshot", "Protected/native inventory changed after preview; nothing deleted.");
  snapshots.delete(String(op.snapshotKey));
  let deletedTracks = 0,
    deletedVias = 0,
    alreadyAbsentTracks = 0,
    alreadyAbsentVias = 0;
  const dispatchedIds = new Set<string>();
  const batchProgress: Record<string, any>[] = [];
  let phase = "delete";
  let sdkPending = false;
  const publish = () => {
    if (!op.mutationId) return;
    extensionMutations.recordExecutionEvidence(op.mutationId, {
      method: "explicit_native_id_batches_v3",
      phase,
      sdkPending,
      nativeOriginalPromiseSettled: !sdkPending,
      dispatchScope: "recorded",
      batchProgress
    });
  };
  try {
    for (const [kind, ids, native] of [
      ["track", chosen.trackIds, env.eda.pcb_PrimitiveLine],
      ["via", chosen.viaIds, env.eda.pcb_PrimitiveVia]
    ] as const) {
      for (let offset = 0; offset < ids.length; offset += 250) {
        phase = "prebatch_observation";
        await env.guard();
        const observed = await env.snapshot(chosen);
        if (!same(observed.components, stored.state.components) || observed.pads !== stored.state.pads)
          throw apiError(
            "protected_inventory_changed",
            "Protected components/pad-net inventory changed before next batch; no later delete."
          );
        const unexpectedNativeIds: Record<string, string[]> = {};
        for (const [name, baseline, current, selectedIds] of [
          ["track", stored.state.tracks, observed.tracks, chosen.trackIds],
          ["via", stored.state.vias, observed.vias, chosen.viaIds]
        ] as const) {
          const original = new Map(baseline.map((p) => [p.primitiveId, p]));
          const selected = new Set(selectedIds);
          if (
            !same(
              current.filter((p) => original.has(p.primitiveId) && !selected.has(p.primitiveId)),
              baseline.filter((p) => !selected.has(p.primitiveId))
            ) ||
            current.some(
              (p) =>
                original.has(p.primitiveId) &&
                (!same(p, original.get(p.primitiveId)) || dispatchedIds.has(p.primitiveId))
            )
          )
            throw apiError(
              "protected_inventory_changed",
              "Original native geometry changed or dispatched ID reappeared before next batch; no later delete."
            );
          unexpectedNativeIds[name] = current.filter((p) => !original.has(p.primitiveId)).map((p) => p.primitiveId);
        }
        const originalBatch = ids.slice(offset, offset + 250);
        const present = new Set((kind === "track" ? observed.tracks : observed.vias).map((p) => p.primitiveId));
        const batch = originalBatch.filter((id) => present.has(id));
        const skippedBeforeDispatch = originalBatch
          .filter((id) => !present.has(id))
          .map((primitiveId) => ({ primitiveId, reason: "observed_absent_before_dispatch" }));
        if (kind === "track") alreadyAbsentTracks += skippedBeforeDispatch.length;
        else alreadyAbsentVias += skippedBeforeDispatch.length;
        const progress: Record<string, any> = {
          kind,
          index: offset / 250,
          offset,
          selectedCount: originalBatch.length,
          originalSelectedIds: originalBatch,
          skippedBeforeDispatch,
          unexpectedNativeIds,
          dispatchCount: batch.length,
          status: batch.length ? "dispatched" : "observed_absent_before_dispatch",
          ...(batch.length ? { dispatchedAt: new Date().toISOString() } : {}),
          selectedIds: batch
        };
        batchProgress.push(progress);
        if (!batch.length) {
          progress.remainingIds = [];
          progress.remainingCount = 0;
          progress.verifiedAt = new Date().toISOString();
          publish();
          continue;
        }
        // Source-reviewed native deletion aborts atomically for any missing ID;
        // the legacy SDK ignores its payload and can nevertheless return true.
        phase = "delete";
        started = true;
        for (const id of batch) dispatchedIds.add(id);
        sdkPending = true;
        publish();
        let result: unknown;
        try {
          // Await the original non-cancellable write. Lifecycle retains the lock until settle.
          result = await native.delete(batch);
        } finally {
          sdkPending = false;
          publish();
        }
        progress.nativeReturnedTrue = result === true;
        progress.status = "absence_unverified";
        publish();
        if (result !== true)
          throw apiError("delete_unconfirmed", "Native batched delete did not return true; inspect actual state.");
        if (kind === "track") deletedTracks += batch.length;
        else deletedVias += batch.length;
        // Native delete acknowledgment may precede canvas inventory propagation. Never resend it.
        const pollUntil = Date.now() + 3000;
        progress.polls = 0;
        while (true) {
          await env.guard();
          const raw = await env.bounded(() => native.getAll());
          if (!Array.isArray(raw))
            throw apiError("unverified_inventory", "Native post-delete inventory is not an array.");
          const present = new Set(raw.map((p) => value(p, "PrimitiveId")));
          progress.polls++;
          progress.remainingIds = batch.filter((id) => present.has(id));
          progress.remainingCount = progress.remainingIds.length;
          progress.nativeInventoryCount = raw.length;
          publish();
          if (!progress.remainingCount) {
            progress.status = "verified_absent";
            break;
          }
          if (Date.now() >= pollUntil)
            throw apiError(
              "batch_absence_unverified",
              "Selected batch IDs still present after 3s read-only polling; no later delete started."
            );
          await env.bounded(
            () => new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, pollUntil - Date.now())))
          );
        }
        progress.verifiedAt = new Date().toISOString();
        publish();
      }
    }
    phase = "protected_inventory_readback";
    publish();
    const after = await env.snapshot({ trackIds: [], viaIds: [] });
    const trackSet = new Set(chosen.trackIds),
      viaSet = new Set(chosen.viaIds);
    if (after.tracks.some((t) => trackSet.has(t.primitiveId)) || after.vias.some((v) => viaSet.has(v.primitiveId)))
      throw apiError("readback_failed", "A selected primitive remains after native delete.", {
        remainingTrackIds: after.tracks.filter((t) => trackSet.has(t.primitiveId)).map((t) => t.primitiveId),
        remainingViaIds: after.vias.filter((v) => viaSet.has(v.primitiveId)).map((v) => v.primitiveId)
      });
    if (
      !same(after.components, stored.state.components) ||
      after.pads !== stored.state.pads ||
      !same(
        after.tracks,
        stored.state.tracks.filter((t) => !trackSet.has(t.primitiveId))
      ) ||
      !same(
        after.vias,
        stored.state.vias.filter((v) => !viaSet.has(v.primitiveId))
      )
    )
      throw apiError("readback_failed", "Protected components/pad netlinks/unselected tracks or vias changed.", {
        newTrackIds: after.tracks
          .filter((t) => !stored.state.tracks.some((old) => old.primitiveId === t.primitiveId))
          .map((t) => t.primitiveId),
        newViaIds: after.vias
          .filter((v) => !stored.state.vias.some((old) => old.primitiveId === v.primitiveId))
          .map((v) => v.primitiveId),
        componentsUnchanged: same(after.components, stored.state.components),
        padsBefore: stored.state.pads,
        padsAfter: after.pads
      });
    await env.guard();
    return {
      executed: true,
      readback: {
        method: "explicit_native_id_batches",
        verified: true,
        deletedTracks,
        deletedVias,
        alreadyAbsentTracks,
        alreadyAbsentVias,
        batchProgress,
        preservedComponents: after.components.length,
        preservedPads: after.pads,
        preservedTracks: after.tracks.length,
        preservedVias: after.vias.length,
        deletedIdsAbsent: true,
        protectedInventoryUnchanged: true,
        drcVerified: false,
        budgetMs: 40000
      }
    };
  } catch (error) {
    if (!started) throw error;
    const last = batchProgress.at(-1);
    if (last && last.status !== "verified_absent") last.error = String(error);
    publish();
    throw apiError(
      "write_readback_unknown",
      `Explicit unroute outcome unknown: ${String(error)}. No later batch or automatic replay is allowed.`,
      {
        deletedTracksReported: deletedTracks,
        deletedViasReported: deletedVias,
        alreadyAbsentTracks,
        alreadyAbsentVias,
        phase,
        batchProgress,
        causeCode: (error as any)?.code,
        causeDetails: (error as any)?.details,
        causeMessage: String(error)
      }
    );
  }
}

/** Observe settled deletion only; never dispatch a write or infer its historical batches. */
export async function reconcileExplicitUnroute(api: () => EasyEdaApi, params: Record<string, any>) {
  if (extensionMutations.getExecutionState().lockHeld)
    throw apiError("reconciliation_not_ready", "Original native executor is still active; no observation started.");
  let record: any;
  try {
    record = extensionMutations.get(params.mutationId) ?? params.originalRecord;
  } catch {
    record = params.originalRecord;
  }
  if (
    !record ||
    record.mutationId !== params.mutationId ||
    record.domain !== "pcb" ||
    record.action !== "unroute" ||
    record.status !== "unknown" ||
    record.phase !== "settled" ||
    !record.startedAt ||
    !record.settledAt ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isFinite(Date.parse(record.settledAt)) ||
    record.confirmation !== formatMutationConfirmation("pcb", "unroute", params.mutationId) ||
    record.execution?.lockHeld === true ||
    record.executionEvidence?.sdkPending === true
  )
    throw apiError(
      "reconciliation_not_ready",
      "Complete settled unknown unroute receipt with no native pending write is required."
    );
  if (
    params.originalRecord &&
    (!same(record.operation, params.originalRecord.operation) || !same(record.before, params.originalRecord.before))
  )
    throw apiError("reconciliation_invalid", "Original operation differs from the stored mutation.");
  const chosen = selection(record.operation),
    env = environment(api, record.target);
  const after = await env.snapshot({ trackIds: [], viaIds: [] });
  const before: Snapshot | undefined = record.before?.inventory;
  const trackIds = new Set(chosen.trackIds),
    viaIds = new Set(chosen.viaIds);
  const remainingTracks = after.tracks.filter((t) => trackIds.has(t.primitiveId));
  const remainingVias = after.vias.filter((v) => viaIds.has(v.primitiveId));
  // Old receipts retain counts only. New IDs are identifiable only with full before,
  // or when all old IDs of that primitive kind were explicitly selected.
  const oldTracks =
    before?.tracks.map((t) => t.primitiveId) ??
    (record.before?.totalTracks === chosen.trackIds.length ? chosen.trackIds : undefined);
  const oldVias =
    before?.vias.map((v) => v.primitiveId) ??
    (record.before?.totalVias === chosen.viaIds.length ? chosen.viaIds : undefined);
  const newTracks = oldTracks ? after.tracks.filter((t) => !oldTracks.includes(t.primitiveId)) : null;
  const newVias = oldVias ? after.vias.filter((v) => !oldVias.includes(v.primitiveId)) : null;
  const protectedInventoryUnchanged = before
    ? same(after.components, before.components) &&
      after.pads === before.pads &&
      same(
        after.tracks.filter((t) => !trackIds.has(t.primitiveId)),
        before.tracks.filter((t) => !trackIds.has(t.primitiveId))
      ) &&
      same(
        after.vias.filter((v) => !viaIds.has(v.primitiveId)),
        before.vias.filter((v) => !viaIds.has(v.primitiveId))
      )
    : null;
  const complete = !remainingTracks.length && !remainingVias.length && protectedInventoryUnchanged === true;
  const evidence = {
    outcome: complete ? "complete" : remainingTracks.length || remainingVias.length ? "partial" : "inconclusive",
    status: "unknown",
    nativeOriginalPromiseSettled: record.executionEvidence?.nativeOriginalPromiseSettled ?? null,
    dispatchScope: record.executionEvidence?.dispatchScope === "recorded" ? "recorded" : "unknown",
    batchProgress: record.executionEvidence?.batchProgress ?? null,
    preservationProofAvailable: !!before,
    protectedInventoryUnchanged,
    remainingOriginalTrackIds: remainingTracks.map((t) => t.primitiveId),
    remainingOriginalViaIds: remainingVias.map((v) => v.primitiveId),
    remainingOriginalTracks: remainingTracks,
    remainingOriginalVias: remainingVias,
    newTracks,
    newVias,
    currentCounts: {
      tracks: after.tracks.length,
      vias: after.vias.length,
      components: after.components.length,
      pads: after.pads
    },
    noCadWrite: true,
    automaticReplay: false,
    drcVerified: false
  };
  if (extensionMutations.getExecutionState().lockHeld)
    throw apiError("reconciliation_not_ready", "An executor started during observation; no status transition.");
  if (!complete) return evidence;
  return extensionMutations.reconcileSettledUnknown({
    mutationId: params.mutationId,
    domain: "pcb",
    action: "unroute",
    originalRecord: params.originalRecord,
    summarizeBefore: (b: any) => summary(b.inventory, chosen),
    verify: async () => ({ ...evidence, status: "applied", verified: true, deletedIdsAbsent: true })
  });
}
