import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareExplicitUnroute, executeExplicitUnroute, reconcileExplicitUnroute } from "./pcbExplicitUnroute.js";
import { extensionMutations } from "./mutationManager.js";
const doc = { uuid: "pcb", parentProjectUuid: "project", documentType: 3 };
function getters(data: any) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [`getState_${k}`, () => v]));
}
function fixture(count = 501) {
  let active: any = doc;
  const tracks = new Map(
    Array.from({ length: count }, (_, i) => [
      `t${i}`,
      getters({
        PrimitiveId: `t${i}`,
        Net: "VM",
        Layer: 1,
        StartX: i,
        StartY: 0,
        EndX: i + 1,
        EndY: 0,
        LineWidth: 10,
        PrimitiveLock: false
      })
    ])
  );
  const vias = new Map([
    ...["free", "preserve", "embedded"].map(
      (id, i) =>
        [
          id,
          getters({ PrimitiveId: id, Net: "GND", X: i, Y: 20, Diameter: 24, HoleDiameter: 12, PrimitiveLock: false })
        ] as const
    )
  ]);
  const components = [
    getters({
      PrimitiveId: "U1",
      Designator: "U1",
      Footprint: { uuid: "footprint" },
      X: 10,
      Y: 20,
      Rotation: 0,
      Layer: 1
    })
  ];
  const pads: any[] = [getters({ PrimitiveId: "pad1", PadNumber: "1", Net: "GND" })];
  const lineDelete = vi.fn(async (ids: string[]) => {
    ids.forEach((id) => tracks.delete(id));
    return true;
  });
  const viaDelete = vi.fn(async (ids: string[]) => {
    ids.forEach((id) => vias.delete(id));
    return true;
  });
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => active },
    pcb_PrimitiveLine: { getAll: async () => [...tracks.values()], delete: lineDelete },
    pcb_PrimitiveVia: { getAll: async () => [...vias.values()], delete: viaDelete },
    pcb_PrimitiveComponent: { getAll: async () => components, getAllPinsByPrimitiveId: async () => pads }
  };
  const ids = () => ({ trackIds: [...tracks.keys()], viaIds: ["free"] });
  return {
    eda,
    tracks,
    vias,
    components,
    pads,
    lineDelete,
    viaDelete,
    ids,
    setActive: (value: any) => {
      active = value;
    }
  };
}
beforeEach(() => extensionMutations.invalidateAll());
afterEach(() => vi.useRealTimers());
it("requires explicit IDs before reading or invoking any delete", async () => {
  const api = vi.fn(() => {
    throw new Error("must not read");
  });
  await expect(prepareExplicitUnroute(api, { nets: ["GND"] })).rejects.toThrow(/explicit/i);
  expect(api).not.toHaveBeenCalled();
});
it("prepares without mutation then deletes batches≤250 and verifies all protected inventory", async () => {
  const f = fixture();
  const p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  expect(f.lineDelete).not.toHaveBeenCalled();
  expect(f.viaDelete).not.toHaveBeenCalled();
  const record: any = extensionMutations.get(p.mutationId);
  const result = await executeExplicitUnroute(() => f.eda, record.operation);
  expect(f.lineDelete.mock.calls.map(([ids]) => ids.length)).toEqual([250, 250, 1]);
  expect(f.viaDelete).toHaveBeenCalledExactlyOnceWith(["free"]);
  expect([...f.vias.keys()]).toEqual(["preserve", "embedded"]);
  expect(result.readback).toMatchObject({
    verified: true,
    deletedTracks: 501,
    deletedVias: 1,
    preservedComponents: 1,
    preservedPads: 1,
    preservedVias: 2
  });
});
it("rejects a selected native via with a non-null parent before any write", async () => {
  const f = fixture(1);
  (f.vias.get("free") as any).getParent = () => ({ id: "component" });
  await expect(prepareExplicitUnroute(() => f.eda, f.ids())).rejects.toThrow(/parent|embedded/i);
  expect(f.lineDelete).not.toHaveBeenCalled();
  expect(f.viaDelete).not.toHaveBeenCalled();
});
it("detects stale protected geometry between preview and execution", async () => {
  const f = fixture(1),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  (f.vias.get("preserve") as any).getState_X = () => 999;
  await expect(
    executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation)
  ).rejects.toThrow(/stale|changed/i);
  expect(f.lineDelete).not.toHaveBeenCalled();
});
it("stops before the next delete batch if the active target changes", async () => {
  const f = fixture(501),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  f.lineDelete.mockImplementation(async (ids) => {
    ids.forEach((id) => f.tracks.delete(id));
    f.setActive({ ...doc, uuid: "other" });
    return true;
  });
  await expect(
    executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation)
  ).rejects.toThrow(/unknown|uncertain/i);
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
  expect(f.viaDelete).not.toHaveBeenCalled();
});
it("reports unknown if pad netlinks changed after deletion", async () => {
  const f = fixture(1),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  f.lineDelete.mockImplementation(async (ids) => {
    ids.forEach((id) => f.tracks.delete(id));
    f.pads[0].getState_Net = () => "BAD";
    return true;
  });
  await expect(
    executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation)
  ).rejects.toThrow(/unknown|uncertain/i);
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
});
it("never starts later delete batches after a 40s deadline, even if an earlier write resolves late", async () => {
  const f = fixture(501),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  vi.useFakeTimers();
  let resolve!: (value: boolean) => void;
  f.lineDelete.mockImplementation(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      })
  );
  const result = executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation);
  const assertion = expect(result).rejects.toThrow(/unknown|uncertain/i);
  await vi.advanceTimersByTimeAsync(40001);
  resolve(true);
  await assertion;
  await vi.advanceTimersByTimeAsync(100000);
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
  expect(f.viaDelete).not.toHaveBeenCalled();
});

it("applies staged explicit unroute through confirmed_action without replay", async () => {
  const f = fixture(2),
    api = () => f.eda,
    p: any = await prepareExplicitUnroute(api, f.ids());
  const handlers = createActionHandlers(api, new DrcRules(api));
  const params = { action: "mutation", confirmation: p.confirmation, params: { mutationId: p.mutationId } };
  const result: any = await handlers.confirmedAction(params);
  expect(result.status).toBe("applied");
  expect(result.after).toMatchObject({ verified: true, deletedTracks: 2, deletedVias: 1 });
  await expect(handlers.confirmedAction(params)).rejects.toThrow();
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
});

it("refuses missing explicit IDs before deleting any existing primitive", async () => {
  const f = fixture(1);
  await expect(prepareExplicitUnroute(() => f.eda, { trackIds: ["missing"] })).rejects.toThrow(/absent/i);
  expect(f.lineDelete).not.toHaveBeenCalled();
});
it("treats false-positive native delete as unknown and consumes the snapshot", async () => {
  const f = fixture(1),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  const op = (extensionMutations.get(p.mutationId) as any).operation;
  f.lineDelete.mockImplementation(async () => true);
  await expect(executeExplicitUnroute(() => f.eda, op)).rejects.toThrow(/unknown/i);
  await expect(executeExplicitUnroute(() => f.eda, op)).rejects.toThrow(/consumed/i);
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
});

it("polls delayed native deletion read-only and records each batch", async () => {
  const f = fixture(251),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  vi.useFakeTimers();
  f.lineDelete.mockImplementation(async (ids) => {
    setTimeout(() => ids.forEach((id) => f.tracks.delete(id)), 500);
    return true;
  });
  const execution = executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation);
  await vi.advanceTimersByTimeAsync(1500);
  const result = await execution;
  expect(f.lineDelete).toHaveBeenCalledTimes(2);
  expect(result.readback.batchProgress).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "track", index: 0, status: "verified_absent", selectedCount: 250 })
    ])
  );
});
it("stops after a 3s read-only poll with exact remaining IDs and no later writes", async () => {
  const f = fixture(251),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  vi.useFakeTimers();
  f.lineDelete.mockImplementation(async () => true);
  const execution = executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation);
  const assertion = expect(execution).rejects.toMatchObject({
    code: "write_readback_unknown",
    details: {
      batchProgress: [
        expect.objectContaining({ kind: "track", index: 0, status: "absence_unverified", remainingCount: 250 })
      ]
    }
  });
  await vi.advanceTimersByTimeAsync(3100);
  await assertion;
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
  expect(f.viaDelete).not.toHaveBeenCalled();
});

it("persists exact dispatched scope in lifecycle evidence when a later batch remains", async () => {
  const f = fixture(251),
    api = () => f.eda;
  const p: any = await prepareExplicitUnroute(api, f.ids());
  f.lineDelete.mockImplementation(async (ids) => {
    if (ids.length === 250) ids.forEach((id) => f.tracks.delete(id));
    return true;
  });
  vi.useFakeTimers();
  const handlers = createActionHandlers(api, new DrcRules(api));
  const pending = handlers.confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  await vi.advanceTimersByTimeAsync(3100);
  const result: any = await pending;
  expect(result.status).toBe("unknown");
  expect(result.executionEvidence).toMatchObject({
    sdkPending: false,
    nativeOriginalPromiseSettled: true,
    batchProgress: [
      { kind: "track", index: 0, status: "verified_absent", selectedCount: 250 },
      { kind: "track", index: 1, status: "absence_unverified", selectedIds: ["t250"], remainingIds: ["t250"] }
    ]
  });
  expect(f.lineDelete).toHaveBeenCalledTimes(2);
  expect(f.viaDelete).not.toHaveBeenCalled();
});

it("observes a legacy partial receipt without inventing dispatch or replaying delete", async () => {
  const f = fixture(2),
    api = () => f.eda;
  const p: any = await prepareExplicitUnroute(api, f.ids());
  const record: any = extensionMutations.get(p.mutationId);
  record.before = record.preview.before;
  record.status = "unknown";
  record.phase = "settled";
  record.startedAt = new Date().toISOString();
  record.settledAt = record.startedAt;
  record.execution = { lockHeld: false };
  extensionMutations.invalidateAll();
  f.tracks.delete("t0");
  vi.spyOn(extensionMutations, "get").mockImplementationOnce(() => {
    throw new Error("runtime restarted");
  });
  const result: any = await reconcileExplicitUnroute(api, { mutationId: p.mutationId, originalRecord: record });
  expect(result).toMatchObject({
    outcome: "partial",
    status: "unknown",
    dispatchScope: "unknown",
    preservationProofAvailable: false,
    remainingOriginalTrackIds: ["t1"]
  });
  expect(f.lineDelete).not.toHaveBeenCalled();
  expect(f.viaDelete).not.toHaveBeenCalled();
});

it("reconciles only complete deletion with full protected native inventory", async () => {
  const f = fixture(1),
    api = () => f.eda;
  const p: any = await prepareExplicitUnroute(api, f.ids());
  vi.useFakeTimers();
  f.lineDelete.mockImplementation(async () => true);
  const pending = createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  await vi.advanceTimersByTimeAsync(3100);
  const receipt: any = await pending;
  f.tracks.clear();
  f.vias.delete("free");
  const result: any = await reconcileExplicitUnroute(api, { mutationId: p.mutationId, originalRecord: receipt });
  expect(result.status).toBe("applied");
  expect(result.after).toMatchObject({ verified: true, protectedInventoryUnchanged: true, noCadWrite: true });
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
  expect(f.viaDelete).not.toHaveBeenCalled();
});
it("reports replacement geometry as new and keeps partial unknown", async () => {
  const f = fixture(1),
    api = () => f.eda;
  const p: any = await prepareExplicitUnroute(api, f.ids());
  vi.useFakeTimers();
  f.lineDelete.mockImplementation(async () => true);
  const pending = createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  await vi.advanceTimersByTimeAsync(3100);
  await pending;
  const track = f.tracks.get("t0")!;
  f.tracks.delete("t0");
  f.tracks.set("replacement", { ...track, getState_PrimitiveId: () => "replacement" });
  const result: any = await reconcileExplicitUnroute(api, { mutationId: p.mutationId });
  expect(result.status).toBe("unknown");
  expect(result.newTracks).toEqual([
    expect.objectContaining({ primitiveId: "replacement", net: "VM", startX: 0, lineWidth: 10 })
  ]);
  expect(result.protectedInventoryUnchanged).toBe(false);
  expect(extensionMutations.get(p.mutationId)?.status).toBe("unknown");
});

it("retains lifecycle lock and pending evidence until the original delete settles", async () => {
  const f = fixture(251),
    api = () => f.eda;
  const p: any = await prepareExplicitUnroute(api, f.ids());
  vi.useFakeTimers();
  let settle!: (value: boolean) => void;
  f.lineDelete.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      })
  );
  const pending = createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  await vi.advanceTimersByTimeAsync(46000);
  const receipt: any = await pending;
  expect(receipt.status).toBe("unknown");
  expect(receipt.executionEvidence).toMatchObject({ sdkPending: true, nativeOriginalPromiseSettled: false });
  expect(extensionMutations.getExecutionState().lockHeld).toBe(true);
  await expect(reconcileExplicitUnroute(api, { mutationId: p.mutationId })).rejects.toMatchObject({
    code: "reconciliation_not_ready"
  });
  settle(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(extensionMutations.getExecutionState().lockHeld).toBe(false);
  expect(extensionMutations.get(p.mutationId).executionEvidence).toMatchObject({
    sdkPending: false,
    nativeOriginalPromiseSettled: true
  });
  expect(f.lineDelete).toHaveBeenCalledTimes(1);
  expect(f.viaDelete).not.toHaveBeenCalled();
});
it("rereads each original batch and omits a future ID already removed by native topology updates before atomic SDK delete", async () => {
  const f = fixture(501),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  f.lineDelete.mockImplementation(async (ids: string[]) => {
    // Bundled native handler aborts the entire batch for one missing ID; SDK still returns true.
    if (ids.some((id) => !f.tracks.has(id))) return true;
    ids.forEach((id) => f.tracks.delete(id));
    if (ids.includes("t0")) f.tracks.delete("t250");
    return true;
  });
  const r: any = await executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation);
  expect(f.lineDelete.mock.calls.map(([ids]) => ids.length)).toEqual([250, 249, 1]);
  expect(f.lineDelete.mock.calls[1][0]).not.toContain("t250");
  expect(r.readback.batchProgress[1]).toMatchObject({
    originalSelectedIds: expect.arrayContaining(["t250"]),
    skippedBeforeDispatch: [{ primitiveId: "t250", reason: "observed_absent_before_dispatch" }],
    status: "verified_absent"
  });
  expect(r.readback.deletedTracks).toBe(500);
  expect(r.readback.alreadyAbsentTracks).toBe(1);
});
it("does not expand original scope to new native geometry and reports unknown after exact selected IDs disappear", async () => {
  const f = fixture(501),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  const approved = new Set(f.ids().trackIds);
  f.lineDelete.mockImplementation(async (ids: string[]) => {
    expect(ids.every((id) => approved.has(id) && f.tracks.has(id))).toBe(true);
    ids.forEach((id) => f.tracks.delete(id));
    if (ids.includes("t0")) {
      f.tracks.delete("t250");
      f.tracks.set(
        "native-new",
        getters({
          PrimitiveId: "native-new",
          Net: "VM",
          Layer: 1,
          StartX: 1,
          StartY: 1,
          EndX: 2,
          EndY: 1,
          LineWidth: 10,
          PrimitiveLock: false
        })
      );
    }
    return true;
  });
  await expect(
    executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation)
  ).rejects.toMatchObject({ code: "write_readback_unknown" });
  expect(f.lineDelete.mock.calls.map(([ids]) => ids.length)).toEqual([250, 249, 1]);
  expect(f.tracks.has("native-new")).toBe(true);
});
it.each(["protectedTrack", "padNet", "malformedRead"])(
  "stops before a later batch on %s drift even with missing selected IDs",
  async (kind) => {
    const f = fixture(502),
      chosen = { trackIds: [...f.tracks.keys()].filter((id) => id !== "t501"), viaIds: ["free"] },
      p: any = await prepareExplicitUnroute(() => f.eda, chosen);
    f.lineDelete.mockImplementation(async (ids: string[]) => {
      ids.forEach((id) => f.tracks.delete(id));
      f.tracks.delete("t250");
      if (kind === "protectedTrack") f.tracks.get("t501")!.getState_LineWidth = () => 99;
      if (kind === "padNet") f.pads[0].getState_Net = () => "BAD";
      if (kind === "malformedRead") f.tracks.get("t501")!.getState_PrimitiveId = () => undefined;
      return true;
    });
    await expect(
      executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation)
    ).rejects.toMatchObject({ code: "write_readback_unknown" });
    expect(f.lineDelete).toHaveBeenCalledTimes(1);
    expect(f.viaDelete).not.toHaveBeenCalled();
  }
);
it("journals a whole original batch and selected via already absent without empty native calls", async () => {
  const f = fixture(501),
    p: any = await prepareExplicitUnroute(() => f.eda, f.ids());
  f.lineDelete.mockImplementation(async (ids: string[]) => {
    ids.forEach((id) => f.tracks.delete(id));
    if (ids.includes("t0")) {
      for (let i = 250; i < 500; i++) f.tracks.delete(`t${i}`);
      f.vias.delete("free");
    }
    return true;
  });
  const r: any = await executeExplicitUnroute(() => f.eda, (extensionMutations.get(p.mutationId) as any).operation);
  expect(f.lineDelete.mock.calls.map(([ids]) => ids.length)).toEqual([250, 1]);
  expect(f.viaDelete).not.toHaveBeenCalled();
  expect(r.readback).toMatchObject({
    deletedTracks: 251,
    alreadyAbsentTracks: 250,
    deletedVias: 0,
    alreadyAbsentVias: 1,
    deletedIdsAbsent: true
  });
  expect(r.readback.batchProgress[1]).toMatchObject({
    status: "observed_absent_before_dispatch",
    dispatchCount: 0,
    selectedIds: []
  });
  expect(r.readback.batchProgress[3]).toMatchObject({
    kind: "via",
    status: "observed_absent_before_dispatch",
    skippedBeforeDispatch: [{ primitiveId: "free", reason: "observed_absent_before_dispatch" }]
  });
});
