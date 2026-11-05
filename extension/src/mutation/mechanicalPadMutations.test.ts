import { encodePcbPreservationInventory, decodePcbPreservationInventory } from "./pcbPreservationEncoding.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  prepareMechanicalPad,
  readMechanicalPads,
  createPcbPreservationEnvironment
} from "./mechanicalPadMutations.js";
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
  const confirm = async (p: any) =>
    createActionHandlers(() => eda, new DrcRules(() => eda)).confirmedAction({
      action: "mutation",
      confirmation: p.confirmation,
      params: { mutationId: p.mutationId }
    });
  return {
    eda,
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
afterEach(() => vi.useRealTimers());
it("reads only standalone round zero-ring NPTH in mm without writes", async () => {
  const f = fixture();
  const result: any = await readMechanicalPads(() => f.eda, scope);
  expect(result.holes).toEqual([expect.objectContaining({ primitiveId: "hole", x: 2.54, y: 5.08, diameter_mm: 3.2 })]);
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
it("creates one staged hole through exact positional mil contract and independent readback", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
  const result: any = await f.confirm(p);
  expect(result.status).toBe("applied");
  expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledExactlyOnceWith(
    12,
    "",
    32 / 0.0254,
    12 / 0.0254,
    0,
    ["ELLIPSE", 3.2 / 0.0254, 3.2 / 0.0254],
    "",
    ["ROUND", 3.2 / 0.0254],
    0,
    0,
    0,
    false,
    0
  );
  expect(result.after).toMatchObject({
    verified: true,
    primitiveId: "created",
    protectedInventoryUnchanged: true,
    manufactureDrillVerified: false
  });
});
it("moves exact ID using public instance done and never early-returning Pad.modify", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "move",
    primitiveId: "hole",
    x: 61.5,
    y: 74.5
  });
  const result: any = await f.confirm(p);
  expect(result.status).toBe("applied");
  expect(f.pads.get("hole").done).toHaveBeenCalledOnce();
  expect(f.eda.pcb_PrimitivePad.modify).not.toHaveBeenCalled();
  expect(result.after.hole).toMatchObject({ x: 61.5, y: 74.5, diameter_mm: 3.2 });
});
it("deletes only one reviewed standalone ID and preserves component pads", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" });
  const result: any = await f.confirm(p);
  expect(result.status).toBe("applied");
  expect(f.eda.pcb_PrimitivePad.delete).toHaveBeenCalledExactlyOnceWith(["hole"]);
  expect(f.pin.state.Net).toBe("VCC");
});
it.each([
  { action: "move", primitiveId: "pin", x: 1, y: 1 },
  { action: "delete", primitiveId: "missing" },
  { action: "create", x: 1, y: 2, diameter_mm: 0 },
  { action: "create", x: 1, y: 2, diameter_mm: 3.2, holes: [{}] }
])("fails before write on invalid scope or selection %j", async (params) => {
  const f = fixture();
  await expect(prepareMechanicalPad(() => f.eda, { ...scope, ...params })).rejects.toThrow();
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
  expect(f.eda.pcb_PrimitivePad.delete).not.toHaveBeenCalled();
});
it("rejects protected board and active target changes", async () => {
  const f = fixture();
  await expect(
    prepareMechanicalPad(() => f.eda, { ...scope, expectedBoardName: "Board1", action: "delete", primitiveId: "hole" })
  ).rejects.toThrow(/protect/i);
  const p: any = await prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" });
  f.setBoard("Board1", "original");
  await expect(f.confirm(p)).rejects.toThrow(/target|document|changed/i);
  expect(f.eda.pcb_PrimitivePad.delete).not.toHaveBeenCalled();
});
it("rejects component-owned or plated/netted/nonzero-ring pads", async () => {
  for (const patch of [
    { PrimitiveType: "ComponentPad" },
    { Metallization: true },
    { Net: "GND" },
    { Layer: 1 },
    { PadType: 1 },
    { Pad: ["ELLIPSE", 150, 150] },
    { ParentComponentPrimitiveId: "U1" }
  ]) {
    const f = fixture();
    Object.assign(f.pads.get("hole").state, patch);
    if ("ParentComponentPrimitiveId" in patch) f.pads.get("hole").getState_ParentComponentPrimitiveId = () => "U1";
    await expect(
      prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" })
    ).rejects.toThrow();
    expect(f.eda.pcb_PrimitivePad.delete).not.toHaveBeenCalled();
  }
});
it("fails closed when preservation capability is absent", async () => {
  const f = fixture();
  delete f.eda.pcb_PrimitivePour;
  await expect(prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" })).rejects.toThrow(
    /capability|Pour/i
  );
});
it("keeps post-write collateral changes unknown with actual native ID and no replay", async () => {
  const f = fixture();
  const original = f.eda.pcb_PrimitivePad.create.getMockImplementation()!;
  f.eda.pcb_PrimitivePad.create.mockImplementation(async (...a: any[]) => {
    const p = await original(...a);
    f.pin.state.Net = "OTHER";
    return p;
  });
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  const result: any = await f.confirm(p);
  expect(result.status).toBe("unknown");
  expect(result.executionEvidence).toMatchObject({
    primitiveId: "created",
    sdkPending: false,
    nativeOriginalPromiseSettled: true
  });
  expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledOnce();
});
it("refuses stale kept geometry before dispatch", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" });
  f.component.state.X++;
  await expect(f.confirm(p)).rejects.toThrow(/changed|stale/i);
  expect(f.eda.pcb_PrimitivePad.delete).not.toHaveBeenCalled();
});
it("excludes component pad IDs even if backend reports the generic Pad type", async () => {
  const f = fixture();
  f.pin.state.PrimitiveType = "Pad";
  const impostor = f.makePad({ ...f.padState("pin"), X: 20, Y: 30 });
  f.pads.set("pin", impostor);
  await expect(prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "pin" })).rejects.toThrow(
    /standalone/i
  );
});
it("accepts observed native 0.05mil center/pad quantization without relaxing hole diameter", async () => {
  const f = fixture();
  const original = f.eda.pcb_PrimitivePad.create.getMockImplementation()!;
  f.eda.pcb_PrimitivePad.create.mockImplementation(async (...a: any[]) => {
    const p = await original(...a);
    p.state.X = Math.round(p.state.X * 10) / 10;
    p.state.Y = Math.round(p.state.Y * 10) / 10;
    p.state.Pad = ["ELLIPSE", 126, 126];
    return p;
  });
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 3.5,
    y: 3.5,
    diameter_mm: 3.2
  });
  expect(((await f.confirm(p)) as any).status).toBe("applied");
});
it("holds lifecycle lock while public done remains pending and never resubmits move", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "move",
    primitiveId: "hole",
    x: 32,
    y: 12
  });
  let settle!: () => void;
  const pad = f.pads.get("hole");
  pad.done.mockImplementation(
    () =>
      new Promise<void>((r) => {
        settle = r;
      })
  );
  vi.useFakeTimers();
  const pending = f.confirm(p);
  await vi.advanceTimersByTimeAsync(46000);
  const result: any = await pending;
  expect(result.status).toBe("unknown");
  expect(result.executionEvidence).toMatchObject({
    sdkPending: true,
    primitiveId: "hole",
    nativeOriginalPromiseSettled: false
  });
  expect(extensionMutations.getExecutionState().lockHeld).toBe(true);
  settle();
  await vi.advanceTimersByTimeAsync(1);
  expect(extensionMutations.getExecutionState().lockHeld).toBe(false);
  expect(pad.done).toHaveBeenCalledOnce();
  expect(f.eda.pcb_PrimitivePad.modify).not.toHaveBeenCalled();
  expect(f.eda.pcb_PrimitivePad.delete).not.toHaveBeenCalled();
});
it("does not mark a false-positive native delete applied or repeat it", async () => {
  const f = fixture();
  f.eda.pcb_PrimitivePad.delete.mockImplementation(async () => true);
  const p: any = await prepareMechanicalPad(() => f.eda, { ...scope, action: "delete", primitiveId: "hole" });
  vi.useFakeTimers();
  const pending = f.confirm(p);
  await vi.advanceTimersByTimeAsync(3100);
  const result: any = await pending;
  expect(result.status).toBe("unknown");
  expect(f.eda.pcb_PrimitivePad.delete).toHaveBeenCalledOnce();
  await expect(f.confirm(p)).rejects.toThrow();
  expect(f.eda.pcb_PrimitivePad.delete).toHaveBeenCalledOnce();
});
it.each(["Line", "Via", "Pour", "Poured", "Region", "Polyline", "Arc", "Fill"])(
  "preserves %s native geometry after create",
  async (kind) => {
    const f = fixture();
    const geometry = item({
      PrimitiveId: "kept",
      Layer: 11,
      Net: "",
      X: 0,
      Y: 0,
      StartX: 0,
      StartY: 0,
      EndX: 5,
      EndY: 5,
      LineWidth: 1,
      ArcAngle: 90,
      Diameter: 20,
      HoleDiameter: 10,
      ViaType: 0,
      PourPriority: 2,
      RuleType: "keepout",
      FillMode: "solid",
      PourPrimitiveId: "pour",
      PourFills: [[0, 0, 5, 5]],
      ComplexPolygon: [0, 0, "L", 5, 0, 5, 5, 0, 0],
      Polygon: [0, 0, "L", 5, 0, 5, 5, 0, 0]
    });
    f.eda[`pcb_Primitive${kind}`].getAll.mockImplementation(async () => [geometry]);
    const original = f.eda.pcb_PrimitivePad.create.getMockImplementation()!;
    f.eda.pcb_PrimitivePad.create.mockImplementation(async (...a: any[]) => {
      const p = await original(...a);
      geometry.state.Polygon = [0, 0, "L", 9, 0, 9, 9, 0, 0];
      return p;
    });
    const p: any = await prepareMechanicalPad(() => f.eda, {
      ...scope,
      action: "create",
      x: 32,
      y: 12,
      diameter_mm: 3.2
    });
    expect(((await f.confirm(p)) as any).status).toBe("unknown");
    expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledOnce();
  }
);
it("refuses occupied physical pad center before write", async () => {
  const f = fixture();
  await expect(
    prepareMechanicalPad(() => f.eda, { ...scope, action: "create", x: 20 * 0.0254, y: 30 * 0.0254, diameter_mm: 3.2 })
  ).rejects.toThrow(/contains|occupied/i);
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
it("rejects incomplete physical part preservation evidence before any write", async () => {
  const f = fixture();
  delete (f.component as any).getState_X;
  await expect(
    prepareMechanicalPad(() => f.eda, { ...scope, action: "create", x: 32, y: 12, diameter_mm: 3.2 })
  ).rejects.toThrow(/Component|geometry|preservation/i);
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
it("does not accept a wrong drill diameter under the outer-pad rounding allowance", async () => {
  const f = fixture(),
    original = f.eda.pcb_PrimitivePad.create.getMockImplementation()!;
  f.eda.pcb_PrimitivePad.create.mockImplementation(async (...a: any[]) => {
    const p = await original(...a);
    p.state.Hole[1] += 0.02;
    return p;
  });
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  vi.useFakeTimers();
  const pending = f.confirm(p);
  await vi.advanceTimersByTimeAsync(3100);
  const result: any = await pending;
  expect(result.status).toBe("unknown");
  expect(result.executionEvidence.primitiveId).toBe("created");
  expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledOnce();
});
it("polls delayed fresh get only without recreating the native pad", async () => {
  const f = fixture();
  f.eda.pcb_PrimitivePad.get.mockResolvedValueOnce(undefined);
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  vi.useFakeTimers();
  const pending = f.confirm(p);
  await vi.advanceTimersByTimeAsync(200);
  expect(((await pending) as any).status).toBe("applied");
  expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledOnce();
});
it("rechecks active PCB after asynchronous board metadata immediately before dispatch", async () => {
  const f = fixture();
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  const boards = await f.eda.dmt_Board.getAllBoardsInfo();
  let calls = 0;
  f.eda.dmt_Board.getAllBoardsInfo = async () => {
    if (++calls === 3) f.setBoard("Board1", "original");
    return boards;
  };
  await expect(f.confirm(p)).rejects.toThrow(/PCB|target|board/i);
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
it("reports exact bounded native getter and nested nonfinite path without accepting it", async () => {
  const f = fixture();
  f.component.getState_UnsupportedDerived = () => ({ expansion: [0, Number.NaN] });
  await expect(readMechanicalPads(() => f.eda, scope)).rejects.toMatchObject({
    code: "unverified_inventory",
    message: expect.stringContaining("Component[U1].getState_UnsupportedDerived.expansion[1]"),
    details: expect.objectContaining({
      nativeValue: "NaN",
      getter: "getState_UnsupportedDerived",
      primitiveId: "U1",
      group: "Component"
    })
  });
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});

it("tags only no-hole SMD HoleRotation NaN and preserves its raw distinction", async () => {
  const f = fixture();
  const smd = f.makePad({
    ...f.padState("smd"),
    Layer: 1,
    Hole: null,
    HoleRotation: Number.NaN,
    PadNumber: "2",
    Net: "GND",
    Pad: ["RECT", 31.5, 35.4, 0]
  });
  f.pads.set("smd", smd);
  const before = await createPcbPreservationEnvironment(() => f.eda, scope).snapshot();
  expect(before.groups.Pad.find((p) => p.PrimitiveId === "smd")?.HoleRotation).toEqual({
    encoding: "native_not_applicable_v1",
    reason: "pad_without_hole",
    rawNonFinite: "NaN",
    holeDiscriminant: null,
    layer: 1
  });
  expect((await readMechanicalPads(() => f.eda, scope)).holes.map((p: any) => p.primitiveId)).toEqual(["hole"]);
  smd.state.HoleRotation = 0;
  const after = await createPcbPreservationEnvironment(() => f.eda, scope).snapshot();
  expect(after.groups.Pad.find((p) => p.PrimitiveId === "smd")?.HoleRotation).toBe(0);
  expect(before).not.toEqual(after);
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
it.each([
  { Hole: ["ROUND", 125], Layer: 1 },
  { Hole: null, Layer: 12 },
  { Hole: undefined, Layer: 1 }
])("rejects HoleRotation NaN without confirmed no-hole SMD discriminant %j", async (patch) => {
  const f = fixture();
  Object.assign(f.pads.get("hole").state, patch, { HoleRotation: Number.NaN });
  await expect(readMechanicalPads(() => f.eda, scope)).rejects.toThrow(/getState_HoleRotation/);
});
it.each(["X", "Y", "Rotation"])("still rejects actual no-hole SMD nonfinite %s", async (key) => {
  const f = fixture();
  Object.assign(f.pads.get("hole").state, { Layer: 1, Hole: null, HoleRotation: Number.NaN, [key]: Number.NaN });
  await expect(readMechanicalPads(() => f.eda, scope)).rejects.toThrow(new RegExp(`getState_${key}`));
});
it("tags no-hole bottom ComponentPad rotation but rejects Infinity and missing discriminants", async () => {
  const f = fixture();
  Object.assign(f.pin.state, { Hole: null, Layer: 2, HoleRotation: Number.NaN });
  f.pin.getState_HoleRotation = () => f.pin.state.HoleRotation;
  const state = await createPcbPreservationEnvironment(() => f.eda, scope).snapshot();
  expect(state.componentPads[0].HoleRotation).toMatchObject({
    encoding: "native_not_applicable_v1",
    rawNonFinite: "NaN",
    layer: 2
  });
  f.pin.state.HoleRotation = Number.POSITIVE_INFINITY;
  await expect(readMechanicalPads(() => f.eda, scope)).rejects.toThrow(/getState_HoleRotation.*Infinity/);
});

function lower214(f: ReturnType<typeof fixture>) {
  const components: any[] = [],
    physical = new Map<string, any[]>();
  for (let c = 0; c < 214; c++) {
    const id = `component-${String(c).padStart(5, "0")}`;
    components.push(
      item({
        ...f.component.state,
        PrimitiveId: id,
        Designator: `U${c}`,
        UniqueId: `uid-${c}`,
        OtherProperty: {
          Description: "Reviewed native catalog metadata ".repeat(65),
          Manufacturer: "Example",
          SupplierId: `C${c}`
        }
      })
    );
    const pins: any[] = [];
    for (let p = 0; p < 8; p++) {
      const state = {
        ...f.padState(`${id}-pad${p}`, 5000 + c * 100 + p * 5, 5000),
        Layer: 1,
        Hole: null,
        HoleRotation: NaN,
        PadNumber: String(p + 1),
        Net: p % 2 ? "GND" : `SIGNAL${c}`,
        HeatWelding: { connectMode: null, spokeWidth: null, spokeAngle: null, spokeSpace: null },
        SolderMaskAndPasteMaskExpansion: {
          topSolderExpansion: null,
          bottomSolderExpansion: null,
          topPasteExpansion: null,
          bottomPasteExpansion: null
        },
        SpecialPad: []
      };
      f.pads.set(state.PrimitiveId, f.makePad(state));
      pins.push(item({ ...state, PrimitiveType: "ComponentPad", ParentComponentPrimitiveId: id, HoleRotation: 0 }));
    }
    physical.set(id, pins);
  }
  f.eda.pcb_PrimitiveComponent.getAll = async () => components;
  f.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => physical.get(id);
  return { components, physical };
}
it("keeps the complete214-part proof below2MB through lossless encoded before, compact preview and preserved create readback", async () => {
  const f = fixture();
  lower214(f);
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  const record = extensionMutations.get(p.mutationId),
    decoded = decodePcbPreservationInventory(record.before);
  expect(decoded.groups.Component).toHaveLength(214);
  expect(decoded.componentPads).toHaveLength(1712);
  expect(JSON.stringify(decoded).length).toBeGreaterThan(2000000);
  expect(JSON.stringify(record).length).toBeLessThan(2000000);
  expect(JSON.stringify(p).length).toBeLessThan(20000);
  expect(p.preview.beforeReference).toBe("record.before");
  expect(p.preview.before.proofEncoding).toBe("pcb_preservation_dictionary_v1");
  expect(decodePcbPreservationInventory(encodePcbPreservationInventory(decoded))).toEqual(decoded);
  const result: any = await f.confirm(p);
  expect(result.status).toBe("applied");
  expect(JSON.stringify(result).length).toBeLessThan(2000000);
  expect(result.after.protectedInventoryUnchanged).toBe(true);
  expect(f.eda.pcb_PrimitivePad.create).toHaveBeenCalledTimes(1);
});
it.each(["padNet", "unrelatedString"])("rejects214-part encoded proof %s drift before write", async (kind) => {
  const f = fixture(),
    large = lower214(f);
  const strings = [
    item({ PrimitiveId: "legend", PrimitiveType: "String", Layer: 3, X: 1, Y: 2, Text: "Keep", FontSize: 40 })
  ];
  f.eda.pcb_PrimitiveString.getAll = async () => strings;
  const p: any = await prepareMechanicalPad(() => f.eda, {
    ...scope,
    action: "create",
    x: 32,
    y: 12,
    diameter_mm: 3.2
  });
  if (kind === "padNet") large.physical.values().next().value![0].state.Net = "CHANGED";
  else strings[0].state.Text = "CHANGED";
  await expect(f.confirm(p)).rejects.toMatchObject({ code: "stale_snapshot" });
  expect(f.eda.pcb_PrimitivePad.create).not.toHaveBeenCalled();
});
