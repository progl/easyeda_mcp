import { createActionHandlers } from "../handlers/actionHandlers.js";
import { beforeEach, expect, it, vi } from "vitest";
import {
  prepareLegacyDeviceRecreate,
  executeLegacyDeviceRecreate,
  reconcileLegacyDeviceStage
} from "./schematicLegacyRecreate.js";
import { extensionMutations } from "./mutationManager.js";

const reference = { uuid: "d".repeat(32), libraryUuid: "l".repeat(32) };
const component = (id: string) => ({
  primitiveId: id,
  componentType: "part",
  designator: id,
  uniqueId: `bind-${id}`,
  component: reference,
  symbol: reference,
  footprint: { ...reference, name: "Vertical-PH" },
  x: 10,
  y: 20,
  rotation: 0,
  mirror: false,
  subPartName: "",
  addIntoBom: true,
  addIntoPcb: true
});
const page = (name: string, id: string, sch: string) => ({
  name,
  parentProjectUuid: "project",
  schematic: { uuid: sch, page: [{ uuid: id, parentSchematicUuid: sch }] },
  pcb: { uuid: `pcb-${sch}` }
});
const params = {
  projectId: "project",
  documentId: "lower-page",
  expectedBoardName: "LOWER",
  protectedBoardName: "Board1",
  primitiveId: "DROP",
  device: { ...reference, name: "S2B", association: { footprint: reference } },
  stagingX: 1000,
  stagingY: 1000,
  temporaryDesignator: "TMP1",
  temporaryUniqueId: "tmp-binding"
};
function fixture() {
  let activeBoard = "LOWER",
    keptNet = "GND";
  const components = [component("KEEP"), component("DROP")],
    wires = [
      { primitiveId: "keepWire", net: "GND", line: [0, 0, 10, 0] },
      { primitiveId: "dropWire", net: "GND", line: [10, 0, 20, 0] }
    ],
    texts = [{ primitiveId: "free-title", content: "HEADERS", x: 5, y: 5 }];
  const boards = [page("Board1", "original-page", "original-sch"), page("LOWER", "lower-page", "lower-sch")];
  const componentDelete = vi.fn(async (ids: string[]) => {
    ids.forEach((id) => {
      const i = components.findIndex((c) => c.primitiveId === id);
      if (i >= 0) components.splice(i, 1);
    });
    return true;
  });
  const wireDelete = vi.fn(async (ids: string[]) => {
    ids.forEach((id) => {
      const i = wires.findIndex((c) => c.primitiveId === id);
      if (i >= 0) wires.splice(i, 1);
    });
    return true;
  });
  const eda = {
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "project" }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "lower-page", parentProjectUuid: "project", documentType: 1 })
    },
    dmt_Schematic: { getCurrentSchematicInfo: async () => ({ uuid: "lower-sch", parentProjectUuid: "project" }) },
    dmt_Board: {
      getAllBoardsInfo: async () => boards,
      getCurrentBoardInfo: async () => boards.find((b) => b.name === activeBoard)
    },
    sch_PrimitiveComponent: {
      getAll: vi.fn(async (_type?: unknown, _allPages?: boolean) => components),
      getAllPinsByPrimitiveId: async (id: string) => {
        const c = components.find((c) => c.primitiveId === id)!;
        return [
          { primitiveId: `${id}-pin1`, pinNumber: "1", pinName: "N", x: c.x, y: c.y },
          { primitiveId: `${id}-pin2`, pinNumber: "2", pinName: "NC", x: c.x, y: c.y + 10 }
        ];
      },
      create: vi.fn(async (_device, x, y, _sub, rotation, mirror, bom, pcb) => {
        components.push({
          ...component("NEW"),
          component: { ...params.device, uuid: "cached-device" },
          footprint: { ...reference, uuid: "cached-footprint", name: "Angle-PH" },
          designator: "",
          uniqueId: "",
          x,
          y,
          rotation,
          mirror,
          addIntoBom: bom,
          addIntoPcb: pcb
        });
        return { primitiveId: "NEW" };
      }),
      modify: vi.fn(async (id, patch) => {
        Object.assign(
          components.find((c) => c.primitiveId === id)!,
          patch
        );
      }),
      delete: componentDelete
    },
    sch_PrimitiveWire: { getAll: async () => wires, delete: wireDelete },
    sch_PrimitiveText: { getAll: async () => texts },
    lib_Device: { get: async () => params.device },
    lib_Footprint: { get: async () => ({ ...reference, name: "Angle-PH" }) },
    sch_ManufactureData: {
      getNetlistFile: async (_file: string, format: string) => {
        if (format !== "EasyEDA") throw new Error("prune must request full JSON");
        return {
          text: async () =>
            JSON.stringify({
              components: Object.fromEntries(
                components.map((c) => [
                  c.uniqueId,
                  {
                    props: { Designator: c.designator },
                    pinInfoMap: {
                      "1": {
                        number: "1",
                        net: c.primitiveId === "KEEP" ? keptNet : c.designator === "DROP" ? "VCC" : ""
                      },
                      "2": { number: "2", net: "" }
                    }
                  }
                ])
              )
            })
        };
      }
    }
  };
  return {
    eda,
    components,
    wires,
    texts,
    componentDelete,
    wireDelete,
    setBoard: (value: string) => {
      activeBoard = value;
    },
    setNet: (value: string) => {
      keptNet = value;
    }
  };
}

const apply = async (f: ReturnType<typeof fixture>, p: any) => {
  const record = extensionMutations.get(p.mutationId);
  let after: any;
  return extensionMutations.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: record.target,
    currentBefore: record.before,
    execute: async () => {
      const r = await executeLegacyDeviceRecreate(() => f.eda, record);
      after = r.readback;
      return r.executed;
    },
    readback: async () => after,
    readbackTarget: record.target
  });
};
beforeEach(() => extensionMutations.invalidateAll());
it("stages independently, then replaces with exact legacy identity/pin NC and kept wires", async () => {
  const f = fixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
  const staged: any = await apply(f, stage);
  expect(staged.status).toBe("applied");
  expect(f.componentDelete).not.toHaveBeenCalled();
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
  });
  const result: any = await apply(f, commit);
  expect(result.status).toBe("applied");
  expect(result.after.pinNetMap).toEqual([
    { number: "1", net: "VCC" },
    { number: "2", net: "" }
  ]);
  expect(f.componentDelete).toHaveBeenCalledExactlyOnceWith(["DROP"]);
  expect(f.components.find((c) => c.primitiveId === "NEW")).toMatchObject({
    designator: "DROP",
    uniqueId: "bind-DROP",
    x: 10,
    y: 20
  });
  expect(f.wireDelete).not.toHaveBeenCalled();
});
it("rejects protected original without writes", async () => {
  const f = fixture();
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage", expectedBoardName: "Board1" })
  ).rejects.toThrow();
  expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
});
it("rejects changed pin geometry before deletion and retains staged new part", async () => {
  const f = fixture();
  const p: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, p);
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => [
    {
      primitiveId: `${id}-pin1`,
      pinNumber: "1",
      pinName: "N",
      x: id === "NEW" ? 1001 : 10,
      y: id === "NEW" ? 1000 : 20
    }
  ];
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "commit",
      stageMutationId: p.mutationId,
      expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
    })
  ).rejects.toThrow();
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.components).toHaveLength(3);
});

it("stale commit snapshots never delete original", async () => {
  const f = fixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, stage);
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
  });
  f.wires[0].net = "OTHER";
  await expect(apply(f, commit)).rejects.toThrow();
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it("post-delete modify failure is unknown, retains evidence and never replays", async () => {
  const f = fixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, stage);
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
  });
  f.eda.sch_PrimitiveComponent.modify.mockRejectedValueOnce(new Error("transport lost"));
  const r: any = await apply(f, commit);
  expect(r.status).toBe("unknown");
  expect(r.executionEvidence).toMatchObject({ deleteCalls: 1, modifyCalls: 1, sdkPending: false });
  await expect(apply(f, commit)).rejects.toThrow();
  expect(f.componentDelete).toHaveBeenCalledTimes(1);
});
it("wrong catalog footprint is never accepted as verified stage", async () => {
  const f = fixture();
  f.eda.sch_PrimitiveComponent.create.mockImplementationOnce(async (_d, x, y, _s, r, m, b, p) => {
    f.components.push({
      ...component("NEW"),
      footprint: { ...reference, uuid: "f".repeat(32), name: "Wrong-Footprint" },
      x,
      y,
      rotation: r,
      mirror: m,
      addIntoBom: b,
      addIntoPcb: p
    });
    return { primitiveId: "NEW" };
  });
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  const result: any = await apply(f, stage);
  expect(result.status).toBe("unknown");
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.components.some((c) => c.primitiveId === "DROP")).toBe(true);
});
it("holds lock for pending native create; late settlement never starts modify/delete", async () => {
  const f = fixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  let resolve!: (v: { primitiveId: string }) => void;
  f.eda.sch_PrimitiveComponent.create.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  vi.useFakeTimers();
  try {
    const pending = apply(f, stage);
    await vi.advanceTimersByTimeAsync(45001);
    const unknown: any = await pending;
    expect(unknown.status).toBe("unknown");
    expect(unknown.execution.lockHeld).toBe(true);
    expect(unknown.executionEvidence.sdkPending).toBe(true);
    resolve({ primitiveId: "NEW" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
    expect(f.componentDelete).not.toHaveBeenCalled();
    expect(extensionMutations.get(stage.mutationId).execution?.lockHeld).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects occupied staging pins and never deletes the original", async () => {
  const f = fixture();
  const get = f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const pins = await get(id);
    return id === "NEW" ? pins.map((p) => ({ ...p, x: 10, y: 20 })) : pins;
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  expect((await apply(f, stage)).status).toBe("unknown");
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it("requires exact separately reviewed cached footprint before original deletion", async () => {
  const f = fixture();
  const s: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, s);
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "commit",
      stageMutationId: s.mutationId,
      expectedFootprint: { uuid: "other", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
    })
  ).rejects.toThrow(/reviewed|footprint/i);
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it("requires real public footprint metadata before any create", async () => {
  const f = fixture();
  f.eda.lib_Footprint.get = async () => undefined as any;
  await expect(prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" })).rejects.toThrow(/footprint/i);
  expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
});
it("waits read-only for original deletion and never reissues it", async () => {
  const f = fixture();
  const s: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, s);
  const c: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: s.mutationId,
    expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
  });
  f.componentDelete.mockImplementationOnce(async (ids) => {
    setTimeout(() => {
      for (const id of ids) {
        const i = f.components.findIndex((c) => c.primitiveId === id);
        if (i >= 0) f.components.splice(i, 1);
      }
    }, 500);
    return true;
  });
  vi.useFakeTimers();
  try {
    const pending = apply(f, c);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe("applied");
    expect(f.componentDelete).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("checks full active-schematic native membership beyond the rendered page", async () => {
  const f = fixture();
  let remoteNet = "";
  const get = f.eda.sch_ManufactureData.getNetlistFile;
  f.eda.sch_ManufactureData.getNetlistFile = async (...args) => {
    const file = await get(...args);
    return {
      text: async () => {
        const data = JSON.parse(await file.text());
        data.components.remote = {
          props: { Designator: "REMOTE" },
          pinInfoMap: { "1": { number: "1", net: remoteNet } }
        };
        return JSON.stringify(data);
      }
    };
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, stage);
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    expectedFootprint: { uuid: "cached-footprint", libraryUuid: reference.libraryUuid, name: "Angle-PH" }
  });
  const modify = f.eda.sch_PrimitiveComponent.modify.getMockImplementation()!;
  f.eda.sch_PrimitiveComponent.modify.mockImplementationOnce(async (...args) => {
    await modify(...args);
    remoteNet = "UNEXPECTED";
  });
  expect((await apply(f, commit)).status).toBe("unknown");
  expect(f.componentDelete).toHaveBeenCalledTimes(1);
});

it("confirmed action dispatches registered legacy phases without Source calls", async () => {
  const f = fixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  const handlers = createActionHandlers(() => f.eda, {} as any);
  const result: any = await handlers.confirmedAction({
    action: "mutation",
    confirmation: stage.confirmation,
    params: { mutationId: stage.mutationId }
  });
  expect(result.status).toBe("applied");
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it("refuses original when public pins omit a pin present in full native membership", async () => {
  const f = fixture();
  const get = f.eda.sch_ManufactureData.getNetlistFile;
  f.eda.sch_ManufactureData.getNetlistFile = async (...args) => {
    const file = await get(...args);
    return {
      text: async () => {
        const data = JSON.parse(await file.text());
        data.components["bind-DROP"].pinInfoMap["3"] = { number: "3", net: "" };
        return JSON.stringify(data);
      }
    };
  };
  await expect(prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" })).rejects.toThrow();
  expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
});

it("read-only reconciles a known staged creation with incompatible pitch, never permitting preserve commit", async () => {
  const f = fixture();
  const get = f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const pins = await get(id);
    return id === "NEW" ? pins.map((p, i) => ({ ...p, y: p.y + i * 10 })) : pins;
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  expect((await apply(f, stage)).status).toBe("unknown");
  const counts = [
    f.eda.sch_PrimitiveComponent.create.mock.calls.length,
    f.eda.sch_PrimitiveComponent.modify.mock.calls.length
  ];
  const r: any = await reconcileLegacyDeviceStage(() => f.eda, { mutationId: stage.mutationId });
  expect(r.status).toBe("applied");
  expect(r.after).toMatchObject({
    geometryCompatible: false,
    reconciledReadOnly: true,
    originalRetained: true,
    stagedPrimitiveId: "NEW"
  });
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect([
    f.eda.sch_PrimitiveComponent.create.mock.calls.length,
    f.eda.sch_PrimitiveComponent.modify.mock.calls.length
  ]).toEqual(counts);
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "commit",
      stageMutationId: stage.mutationId,
      expectedFootprint: r.after.cachedFootprint
    })
  ).rejects.toThrow(/geometry/i);
});
it("does not reconcile an incompatible stage if kept contents changed", async () => {
  const f = fixture();
  const get = f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const pins = await get(id);
    return id === "NEW" ? pins.map((p, i) => ({ ...p, y: p.y + i * 10 })) : pins;
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, stage);
  f.wires[0].net = "OTHER";
  await expect(reconcileLegacyDeviceStage(() => f.eda, { mutationId: stage.mutationId })).rejects.toThrow();
  expect(extensionMutations.get(stage.mutationId).status).toBe("unknown");
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it("reconciles only exact derived sheet autosave time changes with audited diffs", async () => {
  const f = fixture(),
    frame: any = {
      ...component("FRAME"),
      componentType: "sheet",
      otherProperty: { "@Update Date": "2026-11-05", "@Update Time": "02:42:07", Title: "Original" }
    };
  f.components.push(frame);
  const get = f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const pins = await get(id);
    return id === "NEW" ? pins.map((p, i) => ({ ...p, y: p.y + i * 10 })) : pins;
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...params, phase: "stage" });
  await apply(f, stage);
  frame.otherProperty["@Update Time"] = "03:18:17";
  const r: any = await reconcileLegacyDeviceStage(() => f.eda, { mutationId: stage.mutationId });
  expect(r.status).toBe("applied");
  expect(r.after.geometryCompatible).toBe(false);
  expect(r.after.derivedMetadataDiffs).toEqual([
    {
      documentId: "lower-page",
      primitiveId: "FRAME",
      componentType: "sheet",
      property: "OtherProperty.@Update Time",
      before: "02:42:07",
      after: "03:18:17"
    }
  ]);
  expect(f.componentDelete).not.toHaveBeenCalled();
});
function namedFixture() {
  const f = fixture();
  Object.assign(
    f.components.find((c) => c.primitiveId === "DROP")!,
    { x: 100, y: 100 }
  );
  Object.assign(
    f.components.find((c) => c.primitiveId === "KEEP")!,
    { x: 300, y: 300 }
  );
  f.wires.splice(
    0,
    f.wires.length,
    ...Array.from({ length: 4 }, (_, i) => ({
      primitiveId: `stub${i + 1}`,
      net: `N${i + 1}`,
      line: [125, 130 - i * 20, 150, 130 - i * 20]
    })),
    { primitiveId: "kept-wire", net: "GND", line: [300, 300, 325, 300] }
  );
  const newNets: Record<string, string> = {};
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const c = f.components.find((c) => c.primitiveId === id)!;
    if (id === "KEEP")
      return [
        { primitiveId: "keep-pin1", pinNumber: "1", pinName: "N", x: 300, y: 300, rotation: 0 },
        { primitiveId: "keep-pin2", pinNumber: "2", pinName: "NC", x: 300, y: 310, rotation: 0 }
      ];
    return Array.from({ length: 4 }, (_, i) => ({
      primitiveId: `${id}-pin${i + 1}`,
      pinNumber: String(i + 1),
      pinName: String(i + 1),
      x: c.x + (id === "DROP" ? 25 : -20),
      y: c.y + (id === "DROP" ? 30 - i * 20 : 15 - i * 10),
      rotation: id === "DROP" ? 0 : 180
    }));
  };
  f.eda.sch_ManufactureData.getNetlistFile = async () => ({
    text: async () =>
      JSON.stringify({
        components: Object.fromEntries(
          f.components.map((c) => [
            c.uniqueId,
            {
              props: { Designator: c.designator },
              pinInfoMap: Object.fromEntries(
                Array.from({ length: c.primitiveId === "KEEP" ? 2 : 4 }, (_, i) => [
                  String(i + 1),
                  {
                    number: String(i + 1),
                    net:
                      c.primitiveId === "KEEP"
                        ? i
                          ? ""
                          : "GND"
                        : c.primitiveId === "DROP"
                          ? `N${i + 1}`
                          : (newNets[String(i + 1)] ?? "")
                  }
                ])
              )
            }
          ])
        )
      })
  });
  const wireCreate = vi.fn(async (line: number[], net: string, color: any, width: any, lineType: any) => {
    const id = `created-stub-${wireCreate.mock.calls.length}`;
    f.wires.push({ primitiveId: id, line, net, color, lineWidth: width, lineType } as any);
    for (let i = 0; i < 4; i++) if (line[0] === 80 && line[1] === 115 - i * 10) newNets[String(i + 1)] = net;
    return { primitiveId: id };
  });
  (f.eda.sch_PrimitiveWire as any).create = wireCreate;
  return {
    ...f,
    wireCreate,
    stubWires: Array.from({ length: 4 }, (_, i) => ({ pinNumber: String(i + 1), wireId: `stub${i + 1}` }))
  };
}
it("explicit named-stub strategy stages incompatible geometry, previews selected scope, and replaces only reviewed stubs", async () => {
  const f = namedFixture(),
    stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "stage",
      wireStrategy: "recreateNamedStubs"
    });
  const staged: any = await apply(f, stage);
  expect(staged.status).toBe("applied");
  expect(staged.after.geometryCompatible).toBe(false);
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    wireStrategy: "recreateNamedStubs",
    stubWires: f.stubWires,
    expectedFootprint: staged.after.cachedFootprint
  });
  expect(commit.preview.requestedAfter.wirePlan.oldWireIds).toEqual(["stub1", "stub2", "stub3", "stub4"]);
  expect(commit.preview.requestedAfter.wirePlan.stubs[0].newLine).toEqual([80, 115, 55, 115]);
  expect(f.componentDelete).not.toHaveBeenCalled();
  const result: any = await apply(f, commit);
  expect(result.status).toBe("applied");
  expect(f.componentDelete).toHaveBeenCalledExactlyOnceWith(["DROP"]);
  expect(f.wireDelete).toHaveBeenCalledExactlyOnceWith(["stub1", "stub2", "stub3", "stub4"]);
  expect(f.wireCreate).toHaveBeenCalledTimes(4);
  expect(f.wireCreate).toHaveBeenNthCalledWith(1, [80, 115, 55, 115], "N1", undefined, undefined, undefined);
  expect(result.after.pinNetMap).toEqual([1, 2, 3, 4].map((i) => ({ number: String(i), net: `N${i}` })));
  expect(f.wires.find((w) => w.primitiveId === "kept-wire")).toMatchObject({ net: "GND", line: [300, 300, 325, 300] });
});
async function namedCommitFixture() {
  const f = namedFixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "stage",
    wireStrategy: "recreateNamedStubs"
  });
  const result: any = await apply(f, stage);
  expect(result.status).toBe("applied");
  const commit: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    wireStrategy: "recreateNamedStubs",
    stubWires: f.stubWires,
    expectedFootprint: result.after.cachedFootprint
  });
  return { f, stage, commit };
}
it("rejects branch/shared old stubs before deleting original", async () => {
  const f = namedFixture();
  f.wires.push({ primitiveId: "branch", net: "N1", line: [150, 130, 175, 130] });
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "stage",
    wireStrategy: "recreateNamedStubs"
  });
  const result: any = await apply(f, stage);
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "commit",
      stageMutationId: stage.mutationId,
      wireStrategy: "recreateNamedStubs",
      stubWires: f.stubWires,
      expectedFootprint: result.after.cachedFootprint
    })
  ).rejects.toThrow(/branched|another wire/);
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.wireDelete).not.toHaveBeenCalled();
  expect(f.wireCreate).not.toHaveBeenCalled();
});
it("false old wire batch delete stops before final modify/new wire creation", async () => {
  const { f, commit } = await namedCommitFixture();
  f.wireDelete.mockResolvedValueOnce(false);
  const result: any = await apply(f, commit);
  expect(result.status).toBe("unknown");
  expect(f.eda.sch_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
  expect(f.wireCreate).not.toHaveBeenCalled();
  expect(f.wireDelete).toHaveBeenCalledTimes(1);
});
it("partial native wire creation failure is unknown and never replayed", async () => {
  const { f, commit } = await namedCommitFixture();
  const normal = f.wireCreate.getMockImplementation()!;
  f.wireCreate.mockImplementationOnce(normal).mockRejectedValueOnce(new Error("native transport lost"));
  const r: any = await apply(f, commit);
  expect(r.status).toBe("unknown");
  expect(r.executionEvidence).toMatchObject({
    wireCreateCalls: 2,
    wireDeleteCalls: 1,
    deleteCalls: 1,
    createdWireIds: ["created-stub-1"]
  });
  await expect(apply(f, commit)).rejects.toThrow();
  expect(f.wireCreate).toHaveBeenCalledTimes(2);
  expect(f.componentDelete).toHaveBeenCalledTimes(1);
  expect(f.wireDelete).toHaveBeenCalledTimes(1);
});
it("pending native wire create holds lock and late completion never sends remaining stubs", async () => {
  const { f, commit } = await namedCommitFixture();
  let resolve!: (v: { primitiveId: string }) => void;
  f.wireCreate.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  vi.useFakeTimers();
  try {
    const pending = apply(f, commit);
    await vi.advanceTimersByTimeAsync(45001);
    const r: any = await pending;
    expect(r.status).toBe("unknown");
    expect(r.execution.lockHeld).toBe(true);
    expect(r.executionEvidence.sdkPending).toBe(true);
    resolve({ primitiveId: "late-stub" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.wireCreate).toHaveBeenCalledTimes(1);
    expect(extensionMutations.get(commit.mutationId).execution?.lockHeld).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
const mechanicalContract = {
  mapping: [
    { oldPinNumber: "1", newPinNumber: "1" },
    { oldPinNumber: "2", newPinNumber: "2" }
  ],
  extraNCpins: [
    {
      pinNumber: "0",
      reviewedRole: "mechanical",
      evidence: "PJ-063AH page2 MS tabs correspond to source pads0; explicit NC decision, no physical isolation claim."
    }
  ]
};
async function mechanicalCommitFixture() {
  const f = namedFixture();
  f.wires.splice(
    f.wires.findIndex((w) => w.primitiveId === "stub3"),
    2
  );
  const get = f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const rows: any[] = (await get(id)).filter((p) => ["1", "2"].includes(p.pinNumber));
    if (!["DROP", "KEEP"].includes(id)) {
      const c = f.components.find((c) => c.primitiveId === id)!;
      rows.push({ primitiveId: `${id}-pin0`, pinNumber: "0", pinName: "0", x: c.x - 20, y: c.y + 50, rotation: 180 });
    }
    return rows;
  };
  const exportFile = f.eda.sch_ManufactureData.getNetlistFile;
  f.eda.sch_ManufactureData.getNetlistFile = async () => {
    const original = await exportFile("test", "EasyEDA"),
      data = JSON.parse(await original.text());
    for (const c of Object.values(data.components) as any[]) {
      delete c.pinInfoMap["3"];
      delete c.pinInfoMap["4"];
      if (!["DROP", "KEEP"].includes(f.components.find((v) => v.designator === c.props.Designator)!.primitiveId))
        c.pinInfoMap["0"] = { number: "0", net: "" };
    }
    return { text: async () => JSON.stringify(data) };
  };
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "stage",
    wireStrategy: "recreateNamedStubs"
  });
  const staged: any = await apply(f, stage);
  expect(staged.status).toBe("applied");
  const commitParams = {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    wireStrategy: "recreateNamedStubs",
    stubWires: f.stubWires.slice(0, 2),
    expectedFootprint: staged.after.cachedFootprint,
    reviewedPinContract: mechanicalContract
  };
  return { f, stage, staged, commitParams };
}
it("separately confirms exact2to3 mapping and preserves extra mechanical pin as native NC", async () => {
  const { f, commitParams } = await mechanicalCommitFixture();
  const p: any = await prepareLegacyDeviceRecreate(() => f.eda, commitParams);
  expect(p.preview.requestedAfter.wirePlan.extraNCpins).toEqual([
    expect.objectContaining({ pinNumber: "0", net: "", X: 80, Y: 150 })
  ]);
  expect(f.componentDelete).not.toHaveBeenCalled();
  const r: any = await apply(f, p);
  expect(r.status).toBe("applied");
  expect(f.wireCreate).toHaveBeenCalledTimes(2);
  expect(r.after).toMatchObject({
    extraNativeNcVerified: true,
    expectedPinNets: [
      { number: "0", net: "" },
      { number: "1", net: "N1" },
      { number: "2", net: "N2" }
    ],
    observedPinNets: [
      { number: "0", net: "" },
      { number: "1", net: "N1" },
      { number: "2", net: "N2" }
    ]
  });
});
it.each(["missingContract", "preserve", "missingEvidence", "incompleteMapping"])(
  "refuses2to3 %s before original delete",
  async (kind) => {
    const { f, commitParams } = await mechanicalCommitFixture();
    const args: any = structuredClone(commitParams);
    if (kind === "missingContract") delete args.reviewedPinContract;
    if (kind === "preserve") {
      args.wireStrategy = "preserve";
      delete args.stubWires;
    }
    if (kind === "missingEvidence") args.reviewedPinContract.extraNCpins[0].evidence = "";
    if (kind === "incompleteMapping") args.reviewedPinContract.mapping.pop();
    await expect(prepareLegacyDeviceRecreate(() => f.eda, args)).rejects.toThrow();
    expect(f.componentDelete).not.toHaveBeenCalled();
    expect(f.wireDelete).not.toHaveBeenCalled();
  }
);
it("refuses extra mechanical pin native net appearing after replacement and never replays", async () => {
  const { f, commitParams } = await mechanicalCommitFixture();
  const p: any = await prepareLegacyDeviceRecreate(() => f.eda, commitParams);
  const exportFile = f.eda.sch_ManufactureData.getNetlistFile;
  f.eda.sch_ManufactureData.getNetlistFile = async () => {
    const file = await exportFile("test", "EasyEDA"),
      data = JSON.parse(await file.text());
    if (f.wireCreate.mock.calls.length)
      for (const c of Object.values(data.components) as any[]) if (c.pinInfoMap["0"]) c.pinInfoMap["0"].net = "BAD";
    return { text: async () => JSON.stringify(data) };
  };
  const r: any = await apply(f, p);
  expect(r.status).toBe("unknown");
  await expect(apply(f, p)).rejects.toThrow();
  expect(f.componentDelete).toHaveBeenCalledTimes(1);
});
it("honors explicitly swapped electrical mapping rather than numeric identity", async () => {
  const { f, commitParams } = await mechanicalCommitFixture();
  const contract = structuredClone(mechanicalContract);
  contract.mapping = [
    { oldPinNumber: "1", newPinNumber: "2" },
    { oldPinNumber: "2", newPinNumber: "1" }
  ];
  const p: any = await prepareLegacyDeviceRecreate(() => f.eda, { ...commitParams, reviewedPinContract: contract });
  const r: any = await apply(f, p);
  expect(r.status).toBe("applied");
  expect(r.after.observedPinNets).toEqual([
    { number: "0", net: "" },
    { number: "1", net: "N2" },
    { number: "2", net: "N1" }
  ]);
});
it("rejects reviewed contract on stage without creating any native part", async () => {
  const f = namedFixture();
  await expect(
    prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "stage",
      wireStrategy: "recreateNamedStubs",
      reviewedPinContract: mechanicalContract
    })
  ).rejects.toMatchObject({ code: "invalid_pin_contract" });
  expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
});
it("read-only restores a full APPLIED stage receipt after registry loss and permits fresh commit preparation", async () => {
  const f = namedFixture();
  const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "stage",
    wireStrategy: "recreateNamedStubs"
  });
  const receipt: any = await apply(f, stage);
  expect(receipt.status).toBe("applied");
  (extensionMutations as any).mutations.delete(stage.mutationId);
  const restored: any = await reconcileLegacyDeviceStage(() => f.eda, {
    mutationId: stage.mutationId,
    originalRecord: receipt
  });
  expect(restored.status).toBe("applied");
  expect(restored.reconciliation).toMatchObject({
    mode: "read_only",
    previousStatus: "applied",
    recoveredReceipt: true
  });
  expect(extensionMutations.get(stage.mutationId).after).toMatchObject({
    stagedPrimitiveId: receipt.after.stagedPrimitiveId,
    reconciledReadOnly: true
  });
  await prepareLegacyDeviceRecreate(() => f.eda, {
    ...params,
    phase: "commit",
    stageMutationId: stage.mutationId,
    wireStrategy: "recreateNamedStubs",
    stubWires: f.stubWires,
    expectedFootprint: restored.after.cachedFootprint
  });
  expect(f.eda.sch_PrimitiveComponent.create).toHaveBeenCalledTimes(1);
  expect(f.eda.sch_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
  expect(f.componentDelete).not.toHaveBeenCalled();
});
it.each(["nativeDrift", "afterSnapshot", "cachedFootprint", "pending", "wrongId"])(
  "refuses applied stage restore %s without inserting or writing",
  async (kind) => {
    const f = namedFixture();
    const stage: any = await prepareLegacyDeviceRecreate(() => f.eda, {
      ...params,
      phase: "stage",
      wireStrategy: "recreateNamedStubs"
    });
    const receipt: any = await apply(f, stage);
    (extensionMutations as any).mutations.delete(stage.mutationId);
    if (kind === "nativeDrift") f.wires[0].net = "DRIFT";
    if (kind === "afterSnapshot") delete receipt.after.snapshot;
    if (kind === "cachedFootprint") receipt.after.cachedFootprint.uuid = "tampered";
    if (kind === "pending") receipt.executionEvidence.sdkPending = true;
    if (kind === "wrongId") receipt.after.stagedPrimitiveId = "wrong";
    await expect(
      reconcileLegacyDeviceStage(() => f.eda, { mutationId: stage.mutationId, originalRecord: receipt })
    ).rejects.toThrow();
    expect(() => extensionMutations.get(stage.mutationId)).toThrow();
    expect(f.componentDelete).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveComponent.create).toHaveBeenCalledTimes(1);
  }
);
