import { beforeEach, expect, it, vi } from "vitest";
import { prepareSchematicPrune } from "./schematicPrune.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
const reference = { uuid: "d".repeat(32), libraryUuid: "l".repeat(32) };
const component = (id: string) => ({
  primitiveId: id,
  componentType: "part",
  designator: id,
  uniqueId: `bind-${id}`,
  component: reference,
  symbol: reference,
  footprint: reference,
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
  componentIds: ["DROP"],
  wireIds: ["dropWire"]
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
      getAllPinsByPrimitiveId: async (id: string) => [
        { primitiveId: `${id}-pin1`, pinNumber: "1", pinName: "N", x: 10, y: 20 }
      ],
      delete: componentDelete
    },
    sch_PrimitiveWire: { getAll: async () => wires, delete: wireDelete },
    sch_PrimitiveText: { getAll: async () => texts },
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
                    pinInfoMap: { "1": { number: "1", net: c.primitiveId === "KEEP" ? keptNet : "" } }
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
const apply = (f: ReturnType<typeof fixture>, p: any) =>
  createActionHandlers(() => f.eda, {} as any).confirmedAction({
    action: "mutation",
    params: { mutationId: p.mutationId },
    confirmation: p.confirmation
  });
beforeEach(() => extensionMutations.invalidateAll());
it("prepares full native pin/NC evidence without writes, then prunes explicit IDs once preserving kept content and free text", async () => {
  const f = fixture(),
    p: any = await prepareSchematicPrune(() => f.eda, params);
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.wireDelete).not.toHaveBeenCalled();
  const r: any = await apply(f, p);
  expect(r.status).toBe("applied");
  expect(r.after).toMatchObject({
    verified: true,
    deletedComponents: 1,
    deletedWires: 1,
    keptPinNetMap: [{ componentId: "KEEP", pinNumber: "1", net: "GND" }],
    freeTextUnchanged: true
  });
  expect(f.componentDelete).toHaveBeenCalledExactlyOnceWith(["DROP"]);
  expect(f.wireDelete).toHaveBeenCalledExactlyOnceWith(["dropWire"]);
  expect(f.texts).toHaveLength(1);
  expect(f.eda.sch_PrimitiveComponent.getAll.mock.calls.every((args) => args[1] === false)).toBe(true);
});
it("blocks protected/wrong boards and stale snapshots before any delete", async () => {
  const f = fixture();
  await expect(prepareSchematicPrune(() => f.eda, { ...params, expectedBoardName: "Board1" })).rejects.toThrow();
  const p: any = await prepareSchematicPrune(() => f.eda, params);
  f.components[0].x = 99;
  await expect(apply(f, p)).rejects.toThrow(/stale|changed/i);
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.wireDelete).not.toHaveBeenCalled();
});
it("keeps partial failure unknown with a journal and never starts wire deletion after unconfirmed component deletion", async () => {
  const f = fixture(),
    p: any = await prepareSchematicPrune(() => f.eda, params);
  f.componentDelete.mockResolvedValue(false);
  const r: any = await apply(f, p);
  expect(r.status).toBe("unknown");
  expect(r.executionEvidence).toMatchObject({ phase: "unknown", componentDeleteCalls: 1, wireDeleteCalls: 0 });
  expect(f.wireDelete).not.toHaveBeenCalled();
});
it("marks changed kept native net membership unknown instead of accepting geometric contact", async () => {
  const f = fixture(),
    p: any = await prepareSchematicPrune(() => f.eda, params);
  const original = f.wireDelete.getMockImplementation()!;
  f.wireDelete.mockImplementation(async (ids) => {
    const result = await original(ids);
    f.setNet("OTHER");
    return result;
  });
  const r: any = await apply(f, p);
  expect(r.status).toBe("unknown");
  expect(f.wireDelete).toHaveBeenCalledTimes(1);
});
it("holds the lifecycle lock for a late SDK write and never sends the second batch after timeout", async () => {
  const f = fixture(),
    p: any = await prepareSchematicPrune(() => f.eda, params);
  let resolve!: (value: boolean) => void;
  f.componentDelete.mockImplementation(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      })
  );
  vi.useFakeTimers();
  try {
    const pending = apply(f, p);
    await vi.advanceTimersByTimeAsync(45001);
    const unknown: any = await pending;
    expect(unknown.status).toBe("unknown");
    expect(unknown.execution.lockHeld).toBe(true);
    expect(unknown.executionEvidence.sdkPending).toBe(true);
    expect(f.wireDelete).not.toHaveBeenCalled();
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.wireDelete).not.toHaveBeenCalled();
    expect(extensionMutations.get(p.mutationId).execution?.lockHeld).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves explicit native empty-net NC membership for every kept pin", async () => {
  const f = fixture();
  f.setNet("");
  const p: any = await prepareSchematicPrune(() => f.eda, params);
  const r: any = await apply(f, p);
  expect(r.status).toBe("applied");
  expect(r.after.keptPinNetMap).toEqual([{ componentId: "KEEP", pinNumber: "1", net: "" }]);
});
it("rejects missing explicit selected IDs and never replays a consumed unknown prune", async () => {
  const f = fixture();
  await expect(prepareSchematicPrune(() => f.eda, { ...params, wireIds: ["absent"] })).rejects.toThrow(
    /absent|Selected wire/i
  );
  expect(f.componentDelete).not.toHaveBeenCalled();
  const p: any = await prepareSchematicPrune(() => f.eda, params);
  f.componentDelete.mockRejectedValueOnce(new Error("SDK failed after dispatch"));
  const unknown: any = await apply(f, p);
  expect(unknown.status).toBe("unknown");
  try {
    await apply(f, p);
  } catch {
    /* Original consumed mutation cannot be replayed. */
  }
  expect(f.componentDelete).toHaveBeenCalledTimes(1);
  expect(f.wireDelete).not.toHaveBeenCalled();
});

it("waits read-only for component absence before issuing the one wire batch", async () => {
  const f = fixture(),
    p: any = await prepareSchematicPrune(() => f.eda, params);
  vi.useFakeTimers();
  try {
    f.componentDelete.mockImplementation(async (ids) => {
      setTimeout(() => {
        ids.forEach((id) => {
          const at = f.components.findIndex((c) => c.primitiveId === id);
          if (at >= 0) f.components.splice(at, 1);
        });
      }, 500);
      return true;
    });
    const execution = apply(f, p);
    await vi.advanceTimersByTimeAsync(1000);
    const result: any = await execution;
    expect(result.status).toBe("applied");
    expect(result.after.journal.componentReadPolls).toBeGreaterThan(1);
    expect(f.componentDelete).toHaveBeenCalledTimes(1);
    expect(f.wireDelete).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("fails before writing when full native pin assignments or NC evidence are unavailable", async () => {
  const f = fixture();
  f.eda.sch_ManufactureData.getNetlistFile = async () => ({
    text: async () =>
      JSON.stringify({ components: { keep: { props: { Designator: "KEEP" }, pinInfoMap: { "1": { number: "1" } } } } })
  });
  await expect(prepareSchematicPrune(() => f.eda, params)).rejects.toThrow(/native|pin|EasyEDA/i);
  expect(f.componentDelete).not.toHaveBeenCalled();
  expect(f.wireDelete).not.toHaveBeenCalled();
});
