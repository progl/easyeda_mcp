import { beforeEach, expect, it, vi } from "vitest";
import {
  prepareScopedPcbSync,
  executeScopedPcbSync,
  reconcileSchematicPcbSync,
  expandScopedPcbSyncInventory
} from "./schematicPcbSyncGuards.js";
import { extensionMutations } from "./mutationManager.js";

const params = {
  projectId: "project",
  boardName: "upper",
  schematicUuid: "upper-sch",
  pcbUuid: "upper-pcb",
  protectedBoardName: "original"
};
function fixture() {
  let active = "upper-pcb";
  const boards = ["original", "upper", "lower"].map((name) => ({
    name,
    parentProjectUuid: "project",
    schematic: {
      uuid: name + "-sch",
      name: name + "-sch",
      parentProjectUuid: "project",
      page: [{ uuid: name + "-page", name: "page", parentSchematicUuid: name + "-sch" }]
    },
    pcb: { uuid: name + "-pcb", name: name + "-pcb", parentProjectUuid: "project" }
  }));
  const sch: Record<string, any> = {};
  const pcbs: Record<string, any[]> = {};
  for (const name of ["original", "upper", "lower"]) {
    // The same identifiers in three copies must remain legal across boards.
    sch[name] = {
      version: "1",
      components: {
        uid1: {
          props: {
            Designator: "R1",
            "Unique ID": "uid1",
            "Convert to PCB": "yes",
            Device: "device",
            Footprint: "footprint"
          },
          pinInfoMap: { "1": { number: "1", net: "GND" }, "2": { number: "2", net: "" } }
        }
      }
    };
    pcbs[name] = [
      {
        primitiveId: "r1",
        uniqueId: "uid1",
        designator: "R1",
        footprint: { uuid: "footprint" },
        x: 1,
        y: 2,
        pads: [
          { primitiveId: "pad1", padNumber: "1", net: "GND" },
          { primitiveId: "pad2", padNumber: "2", net: "" }
        ]
      }
    ];
  }
  pcbs.upper = [];
  const board = () => boards.find((b) => active === b.pcb.uuid || b.schematic.page.some((p) => p.uuid === active))!;
  const eda: any = {
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "project" }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({
        uuid: active,
        parentProjectUuid: "project",
        documentType: active.endsWith("-pcb") ? 3 : 1
      })
    },
    dmt_Board: { getAllBoardsInfo: async () => boards, getCurrentBoardInfo: async () => board() },
    dmt_EditorControl: {
      openDocument: vi.fn(async (id: string) => {
        active = id;
        return true;
      })
    },
    dmt_Schematic: { getCurrentSchematicInfo: async () => board().schematic },
    sch_ManufactureData: {
      getNetlistFile: vi.fn(async () => ({ text: async () => JSON.stringify(sch[board().name]) }))
    },
    pcb_PrimitiveComponent: { getAll: vi.fn(async () => pcbs[board().name]) },
    pcb_Document: {
      importChanges: vi.fn(async () => {
        pcbs.upper = structuredClone(pcbs.original);
        return true;
      })
    }
  };
  return { api: () => eda, eda, boards, sch, pcbs, active: () => active };
}
beforeEach(() => {
  extensionMutations.invalidateAll();
  (extensionMutations as any).mutations.clear();
});
const rec = (p: any) => extensionMutations.get(p.mutationId);
async function requestAndReconcile(f: ReturnType<typeof fixture>, p: any): Promise<any> {
  const r = rec(p);
  const pending = await extensionMutations.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: r.target,
    currentBefore: r.before,
    execute: async () => {
      await executeScopedPcbSync(r, f.api);
    },
    readback: async () => ({})
  });
  expect(pending.status).toBe("unknown");
  return reconcileSchematicPcbSync(f.api, { mutationId: p.mutationId });
}
it("previews scoped native manifests with explicit NC, then imports once from explicit schematic", async () => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params);
  expect(f.eda.pcb_Document.importChanges).not.toHaveBeenCalled();
  expect(f.active()).toBe("upper-pcb");
  expect(rec(p).before.manifests.upper.schematic[0].pins[1]).toEqual({
    number: "2",
    net: "",
    membership: "native_unassigned"
  });
  const r = await requestAndReconcile(f, p);
  expect(r.after).toMatchObject({ appliedVerified: true, uniqueIdsVerified: true, pinPadNetsVerified: true });
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledExactlyOnceWith("upper-sch");
});
it("reports only compared preservation manifests when unobserved model and properties change", async () => {
  const f = fixture();
  f.pcbs.original[0].model = { uuid: "before-model" };
  f.pcbs.original[0].otherProperty = { review: "before" };
  const p = await prepareScopedPcbSync(f.api, params);
  f.eda.pcb_Document.importChanges.mockImplementation(async () => {
    f.pcbs.upper = structuredClone(f.pcbs.original);
    f.pcbs.original[0].model = { uuid: "after-model" };
    f.pcbs.original[0].otherProperty = { review: "after" };
    f.sch.original.components.uid1.props.Comment = "unobserved annotation";
    return true;
  });
  const r = await requestAndReconcile(f, p);
  expect(r.status).toBe("applied");
  expect(r.after).toMatchObject({
    appliedVerified: true,
    otherBoardsComponentPadManifestPreserved: true,
    schematicPhysicalPinManifestPreserved: true,
    fullNativePreservation: false,
    otherBoardsUnverifiedGroups: ["tracks", "vias", "copperAreas", "freePrimitives", "models", "OtherProperty"],
    schematicUnverifiedGroups: ["nonPhysicalComponents", "wires", "graphics", "annotations", "OtherProperty"]
  });
  expect(r.after).not.toHaveProperty("otherBoardsPreserved");
  expect(r.after).not.toHaveProperty("schematicPreserved");
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
});
it.each([
  { projectId: undefined },
  { boardName: "original" },
  { schematicUuid: "lower-sch" },
  { pcbUuid: "lower-pcb" },
  { protectedBoardName: undefined },
  { protectedBoardName: "absent" }
])("refuses unsafe identity %j before import", async (delta) => {
  const f = fixture();
  await expect(prepareScopedPcbSync(f.api, { ...params, ...delta })).rejects.toBeDefined();
  expect(f.eda.pcb_Document.importChanges).not.toHaveBeenCalled();
});
it("refuses unknown pin membership and duplicate physical unique IDs", async () => {
  const f = fixture();
  delete f.sch.upper.components.uid1.pinInfoMap["2"].net;
  await expect(prepareScopedPcbSync(f.api, params)).rejects.toBeDefined();
  f.sch.upper.components.uid1.pinInfoMap["2"].net = "";
  f.sch.upper.components.uid2 = structuredClone(f.sch.upper.components.uid1);
  await expect(prepareScopedPcbSync(f.api, params)).rejects.toBeDefined();
  expect(f.eda.pcb_Document.importChanges).not.toHaveBeenCalled();
});
it("stale full pin metadata aborts without import", async () => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params);
  f.sch.upper.components.uid1.pinInfoMap["1"].net = "VCC";
  await expect(executeScopedPcbSync(rec(p), f.api)).rejects.toMatchObject({ code: "stale_snapshot" });
  expect(f.eda.pcb_Document.importChanges).not.toHaveBeenCalled();
});
it.each(["empty", "badnet", "baduid", "extra", "protected"])("true is not proof when %s", async (mode) => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params);
  f.eda.pcb_Document.importChanges.mockImplementation(async () => {
    f.pcbs.upper = structuredClone(f.pcbs.original);
    if (mode === "empty") f.pcbs.upper = [];
    if (mode === "badnet") f.pcbs.upper[0].pads[0].net = "VCC";
    if (mode === "baduid") f.pcbs.upper[0].uniqueId = "wrong";
    if (mode === "extra")
      f.pcbs.upper.push({ ...structuredClone(f.pcbs.upper[0]), primitiveId: "r2", uniqueId: "uid2", designator: "R2" });
    if (mode === "protected") f.pcbs.original[0].pads[0].net = "VCC";
    return true;
  });
  await expect(executeScopedPcbSync(rec(p), f.api)).rejects.toMatchObject({ code: "write_readback_unknown" });
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
});
it("reconciles late apply via lifecycle without import replay", async () => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params);
  const r = rec(p);
  f.eda.pcb_Document.importChanges.mockResolvedValue(true);
  await extensionMutations.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: r.target,
    currentBefore: r.before,
    execute: async () => {
      const result = await executeScopedPcbSync(r, f.api);
      return result.executed;
    },
    readback: async () => ({})
  });
  expect(rec(p).status).toBe("unknown");
  f.pcbs.upper = structuredClone(f.pcbs.original);
  const result = await reconcileSchematicPcbSync(f.api, { mutationId: p.mutationId });
  expect(result.status).toBe("applied");
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
});

it("proves removal only from the target copy", async () => {
  const f = fixture();
  const obsolete = structuredClone(f.pcbs.original[0]);
  Object.assign(obsolete, {
    primitiveId: "obsolete",
    uniqueId: "uid-old",
    designator: "R_OLD",
    pads: obsolete.pads.map((p: any) => ({ ...p, primitiveId: "old-" + p.primitiveId }))
  });
  f.pcbs.upper = [obsolete];
  const p = await prepareScopedPcbSync(f.api, params);
  expect(p.delta.remove).toEqual(["R_OLD"]);
  expect(p.delta.add).toEqual(["R1"]);
  const result = await requestAndReconcile(f, p);
  expect(result.after.appliedVerified).toBe(true);
  expect(f.pcbs.original).toHaveLength(1);
  expect(f.pcbs.lower).toHaveLength(1);
});
it("does not race or release a hung native import; late completion runs once", async () => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params);
  const r = rec(p);
  let finish!: (value: boolean) => void;
  f.eda.pcb_Document.importChanges.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
  );
  vi.useFakeTimers();
  try {
    const pending = extensionMutations.apply({
      mutationId: p.mutationId,
      confirmation: p.confirmation,
      currentTarget: r.target,
      currentBefore: r.before,
      execute: async () => {
        const result = await executeScopedPcbSync(r, f.api);
        return result.executed;
      },
      readback: async () => ({ verified: true })
    });
    for (let i = 0; i < 1000 && !finish; i++) await Promise.resolve();
    expect(finish).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(45001);
    const unknown = await pending;
    expect(unknown.status).toBe("unknown");
    expect(extensionMutations.get(p.mutationId).execution?.lockHeld).toBe(true);
    await expect(reconcileSchematicPcbSync(f.api, { mutationId: p.mutationId })).rejects.toBeDefined();
    f.pcbs.upper = structuredClone(f.pcbs.original);
    finish(true);
    for (let i = 0; i < 1000 && extensionMutations.get(p.mutationId).execution?.lockHeld; i++) await Promise.resolve();
    expect(extensionMutations.get(p.mutationId).execution?.lockHeld).toBe(false);
    expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("recognizes native pad getter undefined as unassigned but refuses missing net capability", async () => {
  const f = fixture();
  for (const name of ["original", "lower"]) {
    const pad = f.pcbs[name][0].pads[1];
    delete pad.net;
    pad.getState_Net = () => undefined;
  }
  await expect(prepareScopedPcbSync(f.api, params)).resolves.toBeDefined();
  delete f.pcbs.original[0].pads[1].getState_Net;
  await expect(prepareScopedPcbSync(f.api, params)).rejects.toMatchObject({ code: "unverified_manifest" });
});

it("keeps full three-board proof once, returns compact preview, and losslessly journals large after inventory", async () => {
  const f = fixture();
  for (const name of ["original", "upper", "lower"]) {
    const c = structuredClone(f.pcbs.original[0]);
    c.pads = [
      { primitiveId: "pad1", padNumber: "1", net: "GND" },
      { primitiveId: "pad2", padNumber: "2", net: "" },
      ...Array.from({ length: 1100 }, (_, i) => ({
        primitiveId: `mechanical-${String(i).padStart(16, "0")}`,
        padNumber: "",
        net: "",
        x: 1234.567890123 + i,
        y: 8765.432109876 + i,
        pad: ["RECT", 12.345678901, 32.109876543],
        hole: ["ROUND", 6.123456789],
        layer: 12,
        rotation: 0,
        primitiveLock: false
      }))
    ];
    f.pcbs[name] = [c];
  }
  const p: any = await prepareScopedPcbSync(f.api, params);
  const r = rec(p);
  expect(JSON.stringify(r.before).length).toBeGreaterThan(1000000);
  expect(JSON.stringify(p).length).toBeLessThan(20000);
  expect(p.preview.beforeReference).toBe("record.before");
  expect(r.before.manifests.lower.pcb[0].pads).toHaveLength(1102);
  const result = await requestAndReconcile(f, p);
  expect(result.after.appliedVerified).toBe(true);
  const expanded = expandScopedPcbSyncInventory(r.before, result.after.inventory);
  expect(expanded.manifests.lower).toEqual(r.before.manifests.lower);
  expect(expanded.manifests.upper.pcb).toHaveLength(1);
  expect(expanded.manifests.upper.pcb[0].pads).toHaveLength(1102);
  expect(JSON.stringify(result).length).toBeLessThan(2000000);
});

it("never navigates after native UI request or during pending-target reconcile", async () => {
  const f = fixture();
  const p = await prepareScopedPcbSync(f.api, params),
    r = rec(p);
  let requested = false;
  const afterRequestNavigation: string[] = [];
  const open = f.eda.dmt_EditorControl.openDocument.getMockImplementation();
  f.eda.dmt_EditorControl.openDocument.mockImplementation(async (id: string) => {
    if (requested) afterRequestNavigation.push(id);
    return open(id);
  });
  f.eda.pcb_Document.importChanges.mockImplementation(async () => {
    requested = true;
    return true;
  });
  await extensionMutations.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: r.target,
    currentBefore: r.before,
    execute: async () => {
      await executeScopedPcbSync(r, f.api);
    },
    readback: async () => ({})
  });
  expect(afterRequestNavigation).toEqual([]);
  expect(rec(p).status).toBe("unknown");
  expect(rec(p).executionEvidence).toMatchObject({
    awaitingNativeApply: true,
    sdkPending: false,
    nativeImportCalls: 1
  });
  await expect(reconcileSchematicPcbSync(f.api, { mutationId: p.mutationId })).rejects.toMatchObject({
    code: "native_apply_pending"
  });
  expect(afterRequestNavigation).toEqual([]);
  await expect(prepareScopedPcbSync(f.api, params)).rejects.toMatchObject({ code: "native_apply_pending" });
  expect(afterRequestNavigation).toEqual([]);
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
});

it("full reconcile still rejects other-board changes even after local target matches", async () => {
  const f = fixture(),
    p = await prepareScopedPcbSync(f.api, params),
    r = rec(p);
  await extensionMutations.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: r.target,
    currentBefore: r.before,
    execute: async () => {
      await executeScopedPcbSync(r, f.api);
    },
    readback: async () => ({})
  });
  f.pcbs.original[0].pads[0].net = "UNEXPECTED";
  await expect(reconcileSchematicPcbSync(f.api, { mutationId: p.mutationId })).rejects.toMatchObject({
    code: "sync_readback_unconfirmed"
  });
  expect(rec(p).status).toBe("unknown");
  expect(f.eda.pcb_Document.importChanges).toHaveBeenCalledTimes(1);
});
