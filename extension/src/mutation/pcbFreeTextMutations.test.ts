import { beforeEach, expect, it, vi } from "vitest";
import { preparePcbFreeTextDelete, readPcbFreeTexts, executePcbFreeTextDelete } from "./pcbFreeTextMutations.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";
const scope = { projectId: "project", pcbUuid: "pcb", expectedBoardName: "UPPER", protectedBoardName: "Board1" };
function item(state: Record<string, any>) {
  return Object.assign(Object.fromEntries(Object.keys(state).map((k) => [`getState_${k}`, () => state[k]])), { state });
}
function fixture() {
  const padState = (id: string, x = 100, y = 200) => ({
    PrimitiveId: id,
    PrimitiveType: "Pad",
    Layer: 12,
    PadNumber: "",
    X: x,
    Y: y,
    Rotation: 0,
    Pad: ["ELLIPSE", 126, 126],
    Net: "",
    Hole: ["ROUND", 3.2 / 0.0254],
    HoleOffsetX: 0,
    HoleOffsetY: 0,
    HoleRotation: 0,
    Metallization: false,
    PadType: 0,
    PrimitiveLock: false
  });
  const pads = new Map<string, any>();
  const makePad = (state: Record<string, any>) => {
    const p: any = item(state);
    let changes: Record<string, any> = {};
    p.toAsync = vi.fn(() => p);
    p.setState_X = vi.fn((x: number) => {
      changes.X = x;
      return p;
    });
    p.setState_Y = vi.fn((y: number) => {
      changes.Y = y;
      return p;
    });
    p.done = vi.fn(async () => {
      Object.assign(state, changes);
      changes = {};
      return p;
    });
    return p;
  };
  pads.set("hole", makePad(padState("hole")));
  const component = item({
    PrimitiveId: "U1",
    Designator: "U1",
    UniqueId: "uid",
    Footprint: { uuid: "fp" },
    X: 20,
    Y: 30,
    Rotation: 0,
    Layer: 1
  });
  const pin = item({
    PrimitiveId: "pin",
    PrimitiveType: "ComponentPad",
    Pad: ["ELLIPSE", 60, 60],
    Hole: null,
    PadNumber: "1",
    X: 20,
    Y: 30,
    Net: "VCC",
    Layer: 1
  });
  let board = "UPPER",
    doc = "pcb";
  const eda: any = {
    sys_Environment: { getEditorCurrentVersion: vi.fn(async () => "3.2.209") },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "project" }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: doc, parentProjectUuid: "project", documentType: 3 })
    },
    dmt_Board: {
      getCurrentBoardInfo: async () => ({
        name: board,
        parentProjectUuid: "project",
        pcb: { uuid: doc, parentProjectUuid: "project" }
      }),
      getAllBoardsInfo: async () => [
        { name: "Board1", parentProjectUuid: "project", pcb: { uuid: "original", parentProjectUuid: "project" } },
        { name: "UPPER", parentProjectUuid: "project", pcb: { uuid: "pcb", parentProjectUuid: "project" } }
      ]
    },
    pcb_PrimitivePad: {
      getAll: vi.fn(async () => [...pads.values()]),
      get: vi.fn(async (id: string) => pads.get(id)),
      create: vi.fn(async (...args: any[]) => {
        const p = makePad({ ...padState("created", args[2], args[3]), Pad: args[5], Hole: args[7] });
        pads.set("created", p);
        return p;
      }),
      delete: vi.fn(async (ids: string[]) => {
        ids.forEach((id) => pads.delete(id));
        return true;
      }),
      modify: vi.fn()
    },
    pcb_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => [pin] }
  };
  for (const name of ["Line", "Via", "Pour", "Poured", "Region", "Polyline", "Arc", "String", "Fill"])
    eda[`pcb_Primitive${name}`] = { getAll: vi.fn(async () => []) };
  const texts = new Map(
    ["old", "keep"].map((id) => [
      id,
      item({
        PrimitiveId: id,
        PrimitiveType: "String",
        Layer: 3,
        X: 10,
        Y: 20,
        Text: id,
        FontFamily: "default",
        FontSize: 40,
        LineWidth: 4,
        AlignMode: 3,
        Rotation: 0,
        Reverse: false,
        Expansion: 0,
        Mirror: false,
        PrimitiveLock: false
      })
    ])
  );
  eda.pcb_PrimitiveString = {
    getAll: vi.fn(async () => [...texts.values()]),
    get: vi.fn(async (id: string) => texts.get(id)),
    delete: vi.fn(async (ids: string[]) => {
      ids.forEach((id) => texts.delete(id));
      return true;
    })
  };
  eda.pcb_PrimitiveAttribute = { getAll: vi.fn(async () => []) };
  const confirm = async (p: any) =>
    createActionHandlers(() => eda, new DrcRules(() => eda)).confirmedAction({
      action: "mutation",
      confirmation: p.confirmation,
      params: { mutationId: p.mutationId }
    });
  return {
    eda,
    texts,
    pads,
    component,
    pin,
    padState,
    makePad,
    confirm,
    setBoard: (b: string, d = "pcb") => {
      board = b;
      doc = d;
    }
  };
}

beforeEach(() => extensionMutations.invalidateAll());
async function prepare(f: ReturnType<typeof fixture>) {
  const inventory = await readPcbFreeTexts(() => f.eda, scope);
  return preparePcbFreeTextDelete(() => f.eda, {
    ...scope,
    primitiveIds: ["old"],
    expectedTexts: inventory.texts.filter((p: any) => p.PrimitiveId === "old"),
    keepTextIds: ["keep"]
  });
}
it("reads full preservation inventory but returns only typed free texts without writes", async () => {
  const f = fixture();
  const r = await readPcbFreeTexts(() => f.eda, scope);
  expect(r.texts.map((p: any) => p.PrimitiveId)).toEqual(["keep", "old"]);
  expect(r.readOnly).toBe(true);
  expect(f.eda.pcb_PrimitiveString.delete).not.toHaveBeenCalled();
});
it("stages exact unowned free text delete and preserves keep IDs/full native state", async () => {
  const f = fixture(),
    p = await prepare(f);
  expect(f.eda.pcb_PrimitiveString.delete).not.toHaveBeenCalled();
  const r = await executePcbFreeTextDelete(() => f.eda, extensionMutations.get(p.mutationId));
  expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledExactlyOnceWith(["old"]);
  expect([...f.texts.keys()]).toEqual(["keep"]);
  expect(r.readback).toMatchObject({
    verified: true,
    saved: false,
    persistenceVerified: false,
    journal: [{ primitiveId: "old", verified: true }]
  });
});
it.each([
  "wrongVersion",
  "protectedBoard",
  "missingGroup",
  "attributeCollision",
  "wrongType",
  "copperLayer",
  "independentMismatch",
  "missingStyle"
])("refuses %s before delete", async (kind) => {
  const f = fixture();
  if (kind === "wrongVersion") f.eda.sys_Environment.getEditorCurrentVersion.mockResolvedValue("3.2.210");
  if (kind === "protectedBoard") f.setBoard("Board1", "original");
  if (kind === "missingGroup") delete f.eda.pcb_PrimitiveFill;
  if (kind === "attributeCollision")
    f.eda.pcb_PrimitiveAttribute.getAll.mockResolvedValue([
      item({ PrimitiveId: "old", PrimitiveType: "Attribute", ParentPrimitiveId: "U1" })
    ]);
  if (kind === "wrongType") f.texts.get("old")!.state.PrimitiveType = "Attribute";
  if (kind === "copperLayer") f.texts.get("old")!.state.Layer = 1;
  if (kind === "independentMismatch") f.eda.pcb_PrimitiveString.get.mockImplementation(async () => f.texts.get("keep"));
  if (kind === "missingStyle") delete f.texts.get("old")!.getState_LineWidth;
  await expect(prepare(f)).rejects.toBeDefined();
  expect(f.eda.pcb_PrimitiveString.delete).not.toHaveBeenCalled();
});
it.each(["padNet", "keepText", "attribute", "board"])("rejects stale %s preservation baseline", async (kind) => {
  const f = fixture(),
    p = await prepare(f);
  if (kind === "padNet") f.pin.state.Net = "OTHER";
  if (kind === "keepText") f.texts.get("keep")!.state.Text = "Changed";
  if (kind === "attribute")
    f.eda.pcb_PrimitiveAttribute.getAll.mockResolvedValue([
      item({ PrimitiveId: "attr", PrimitiveType: "Attribute", ParentPrimitiveId: "U1" })
    ]);
  if (kind === "board") {
    const get = f.eda.dmt_Board.getAllBoardsInfo;
    f.eda.dmt_Board.getAllBoardsInfo = async () => [...(await get()), { name: "new" }];
  }
  await expect(executePcbFreeTextDelete(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
    code: "stale_snapshot"
  });
  expect(f.eda.pcb_PrimitiveString.delete).not.toHaveBeenCalled();
});
it.each(["false", "stillPresent", "keepChanged"])(
  "retains partial journal and never replays after %s",
  async (kind) => {
    const f = fixture(),
      p = await prepare(f);
    f.eda.pcb_PrimitiveString.delete.mockImplementation(async () => {
      if (kind !== "stillPresent") f.texts.delete("old");
      if (kind === "keepChanged") f.texts.get("keep")!.state.Text = "Changed";
      return kind !== "false";
    });
    await expect(executePcbFreeTextDelete(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
      code: "write_readback_unknown",
      message: expect.stringContaining('"primitiveId":"old"')
    });
    expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledTimes(1);
  }
);
it.each(["missingKeep", "overlap", "wrongExpected", "duplicateIds"])(
  "refuses invalid reviewed selection %s",
  async (kind) => {
    const f = fixture(),
      inventory = await readPcbFreeTexts(() => f.eda, scope);
    const params: any = {
      ...scope,
      primitiveIds: ["old"],
      expectedTexts: inventory.texts.filter((p: any) => p.PrimitiveId === "old"),
      keepTextIds: ["keep"]
    };
    if (kind === "missingKeep") delete params.keepTextIds;
    if (kind === "overlap") params.keepTextIds = ["old"];
    if (kind === "wrongExpected") params.expectedTexts[0].Text = "Other";
    if (kind === "duplicateIds") params.primitiveIds = ["old", "old"];
    await expect(preparePcbFreeTextDelete(() => f.eda, params)).rejects.toBeDefined();
    expect(f.eda.pcb_PrimitiveString.delete).not.toHaveBeenCalled();
  }
);
it("awaits native write settlement and does not start next delete while pending", async () => {
  const f = fixture();
  f.texts.set("second", item({ ...f.texts.get("old")!.state, PrimitiveId: "second", Text: "second" }));
  const inventory = await readPcbFreeTexts(() => f.eda, scope);
  const p = await preparePcbFreeTextDelete(() => f.eda, {
    ...scope,
    primitiveIds: ["old", "second"],
    expectedTexts: inventory.texts.filter((p: any) => p.PrimitiveId !== "keep"),
    keepTextIds: ["keep"]
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.eda.pcb_PrimitiveString.delete.mockImplementation(async (ids: string[]) => {
    started();
    if (ids[0] === "old") await pending;
    ids.forEach((id) => f.texts.delete(id));
    return true;
  });
  const run = executePcbFreeTextDelete(() => f.eda, extensionMutations.get(p.mutationId));
  await dispatched;
  expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledTimes(1);
  expect(f.texts.has("second")).toBe(true);
  release();
  const result = await run;
  expect(result.readback.journal).toHaveLength(2);
  expect(f.eda.pcb_PrimitiveString.delete.mock.calls).toEqual([[["old"]], [["second"]]]);
});
it("stops batch after first partial write without touching later reviewed IDs", async () => {
  const f = fixture();
  f.texts.set("second", item({ ...f.texts.get("old")!.state, PrimitiveId: "second", Text: "second" }));
  const inventory = await readPcbFreeTexts(() => f.eda, scope);
  const p = await preparePcbFreeTextDelete(() => f.eda, {
    ...scope,
    primitiveIds: ["old", "second"],
    expectedTexts: inventory.texts.filter((p: any) => p.PrimitiveId !== "keep"),
    keepTextIds: ["keep"]
  });
  f.eda.pcb_PrimitiveString.delete.mockImplementation(async (ids: string[]) => {
    ids.forEach((id) => f.texts.delete(id));
    f.pin.state.Net = "OTHER";
    return true;
  });
  await expect(executePcbFreeTextDelete(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
    code: "write_readback_unknown"
  });
  expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledTimes(1);
  expect(f.texts.has("second")).toBe(true);
});
it("routes exact confirmation through lifecycle and retains applied proof", async () => {
  const f = fixture(),
    p = await prepare(f);
  const result: any = await f.confirm(p);
  expect(result.status).toBe("applied");
  expect(result.after).toMatchObject({
    verified: true,
    persistenceVerified: false,
    journal: [{ primitiveId: "old", verified: true }]
  });
  expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledTimes(1);
});
it("lifecycle marks uncertain deletion unknown and refuses a second write", async () => {
  const f = fixture(),
    p = await prepare(f);
  f.eda.pcb_PrimitiveString.delete.mockResolvedValue(false);
  const result: any = await f.confirm(p);
  expect(result.status).toBe("unknown");
  try {
    await f.confirm(p);
  } catch {
    /* lifecycle may reject already-settled unknown explicitly */
  }
  expect(f.eda.pcb_PrimitiveString.delete).toHaveBeenCalledTimes(1);
});
