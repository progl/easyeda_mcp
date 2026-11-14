import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { preparePcb3dTransform, readPcb3dTransform } from "./pcb3dTransformMutations.js";
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
  Object.assign(component.state, {
    PrimitiveType: "Component",
    AddIntoBom: true,
    PrimitiveLock: false,
    Name: "Header",
    Manufacturer: "",
    ManufacturerId: "",
    Supplier: "",
    SupplierId: "",
    Model3D: { uuid: "model", libraryUuid: "models", name: "Header" },
    Footprint: { uuid: "fp", libraryUuid: "footprints", name: "HDR" },
    OtherProperty: {
      "3D Model Transform": "1000,200,0,0,0,0,0,0,-118.11",
      "3D Model": "model",
      "3D Model Title": "Header",
      Custom: "keep",
      Numeric: 0,
      Disabled: false
    },
    Component: { uuid: "device", libraryUuid: "devices" }
  });
  for (const key of Object.keys(component.state))
    if (!component[`getState_${key}`]) component[`getState_${key}`] = () => component.state[key];
  let patch: any;
  (component as any).toAsync = vi.fn(() => component);
  (component as any).setState_OtherProperty = vi.fn((value: any) => {
    patch = value;
    return component;
  });
  (component as any).done = vi.fn(async () => {
    Object.assign(component.state.OtherProperty, patch);
    return component;
  });
  eda.pcb_PrimitiveComponent.get = vi.fn(async (id: string) => (id === "U1" ? component : undefined));
  eda.pcb_PrimitiveComponent.modify = vi.fn();
  eda.pcb_PrimitiveAttribute = { getAll: vi.fn(async () => []) };
  const confirm = async (p: any) =>
    createActionHandlers(() => eda, new DrcRules(() => eda)).confirmedAction({
      action: "mutation",
      confirmation: p.confirmation,
      params: { mutationId: p.mutationId }
    });
  return {
    eda,
    pads,
    component: component as any,
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
const argumentsFor = (f: ReturnType<typeof fixture>) => ({
  ...scope,
  primitiveId: "U1",
  expectedOldTuple: f.component.state.OtherProperty["3D Model Transform"],
  expectedModelRef: structuredClone(f.component.state.Model3D),
  expectedFootprintRef: structuredClone(f.component.state.Footprint),
  newTuple: [1000, 200, 0, 0, 0, 0, 0.2, 56, -274]
});
async function apply(f: ReturnType<typeof fixture>, p: any) {
  const r: any = await f.confirm(p);
  if (r.status !== "applied") throw Object.assign(new Error(r.error), { code: "write_readback_unknown" });
  return { readback: r.after };
}
it("reads actual native component override/refs without authoring from a library tuple", async () => {
  const f = fixture();
  const result = await readPcb3dTransform(() => f.eda, { ...scope, primitiveId: "U1" });
  expect(result).toMatchObject({
    readOnly: true,
    currentTupleRaw: "1000,200,0,0,0,0,0,0,-118.11",
    modelRef: f.component.state.Model3D,
    footprintRef: f.component.state.Footprint
  });
  expect(f.component.done).not.toHaveBeenCalled();
});
it("sets exactly one property through public instance awaitdone and preserves all other fields", async () => {
  const f = fixture(),
    args = argumentsFor(f),
    p = await preparePcb3dTransform(() => f.eda, args);
  expect(f.component.done).not.toHaveBeenCalled();
  const r = await apply(f, p);
  expect(f.component.setState_OtherProperty).toHaveBeenCalledExactlyOnceWith({
    "3D Model Transform": args.newTuple.join(",")
  });
  expect(f.component.done).toHaveBeenCalledTimes(1);
  expect(f.eda.pcb_PrimitiveComponent.modify).not.toHaveBeenCalled();
  expect(f.component.state.OtherProperty).toMatchObject({ Custom: "keep", Numeric: 0, Disabled: false });
  expect(r.readback).toMatchObject({
    verified: true,
    onlyOnePropertyChanged: true,
    saved: false,
    native3dExportVerified: false,
    modelPoseVerified: false
  });
});
it.each(["dropOtherProps", "footprint", "padNet", "modelRef", "pose", "otherComponentField"])(
  "rejects postwrite %s collateral change as unknown without replay",
  async (kind) => {
    const f = fixture(),
      p = await preparePcb3dTransform(() => f.eda, argumentsFor(f)),
      done = f.component.done.getMockImplementation();
    f.component.done.mockImplementation(async () => {
      await done();
      if (kind === "dropOtherProps")
        f.component.state.OtherProperty = { "3D Model Transform": argumentsFor(f).newTuple.join(",") };
      if (kind === "footprint") f.component.state.Footprint.uuid = "DIFFERENT";
      if (kind === "padNet") f.pin.state.Net = "BAD";
      if (kind === "modelRef") f.component.state.Model3D.uuid = "DIFFERENT";
      if (kind === "pose") f.component.state.Rotation = 90;
      if (kind === "otherComponentField") f.component.state.AddIntoBom = false;
      return f.component;
    });
    await expect(apply(f, p)).rejects.toMatchObject({
      code: "write_readback_unknown"
    });
    expect(f.component.done).toHaveBeenCalledTimes(1);
  }
);
it.each(["tuple", "modelRef", "footprint", "padNet", "attribute"])(
  "refuses prewrite %s drift from full staged proof",
  async (kind) => {
    const f = fixture(),
      p = await preparePcb3dTransform(() => f.eda, argumentsFor(f));
    if (kind === "tuple") f.component.state.OtherProperty["3D Model Transform"] = "1,2,3,4,5,6,7,8,9";
    if (kind === "modelRef") f.component.state.Model3D.uuid = "DIFFERENT";
    if (kind === "footprint") f.component.state.Footprint.uuid = "DIFFERENT";
    if (kind === "padNet") f.pin.state.Net = "BAD";
    if (kind === "attribute")
      f.eda.pcb_PrimitiveAttribute.getAll.mockResolvedValue([
        item({
          PrimitiveId: "attr",
          PrimitiveType: "Attribute",
          ParentPrimitiveId: "U1",
          Key: "Custom",
          Value: "Changed"
        })
      ]);
    await expect(apply(f, p)).rejects.toMatchObject({
      code: "stale_snapshot"
    });
    expect(f.component.done).not.toHaveBeenCalled();
  }
);
it.each([
  "nonfinite",
  "tupleLength",
  "oldTupleLength",
  "wrongRef",
  "protected",
  "alias",
  "drawnAttribute",
  "unsupportedProperty"
])("refuses invalid3D contract %s", async (kind) => {
  const f = fixture(),
    args: any = argumentsFor(f);
  if (kind === "nonfinite") args.newTuple[8] = NaN;
  if (kind === "tupleLength") args.newTuple.pop();
  if (kind === "oldTupleLength") args.expectedOldTuple = "1,2,3";
  if (kind === "wrongRef") args.expectedModelRef.uuid = "wrong";
  if (kind === "protected") args.expectedBoardName = "Board1";
  if (kind === "alias") f.component.state.OtherProperty["3dmodeltransform"] = "1,2,3,4,5,6,7,8,9";
  if (kind === "drawnAttribute")
    f.eda.pcb_PrimitiveAttribute.getAll.mockResolvedValue([
      item({
        PrimitiveId: "attr",
        PrimitiveType: "Attribute",
        ParentPrimitiveId: "U1",
        Key: "3D Model Transform",
        Value: args.expectedOldTuple
      })
    ]);
  if (kind === "unsupportedProperty") args.otherProperty = { Footprint: "fake" };
  await expect(preparePcb3dTransform(() => f.eda, args)).rejects.toThrow();
  expect(f.component.done).not.toHaveBeenCalled();
});
it("awaits the original native done promise before any after readback", async () => {
  const f = fixture(),
    p = await preparePcb3dTransform(() => f.eda, argumentsFor(f));
  const done = f.component.done.getMockImplementation();
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
  f.component.done.mockImplementation(async () => {
    started();
    await pending;
    return done();
  });
  const run = apply(f, p);
  await dispatched;
  expect(f.component.state.OtherProperty["3D Model Transform"]).toBe(argumentsFor(f).expectedOldTuple);
  expect(extensionMutations.get(p.mutationId).executionEvidence).toMatchObject({ sdkPending: true });
  release();
  await run;
  expect(f.component.done).toHaveBeenCalledTimes(1);
});
it("retains lifecycle lock past its deadline until the original done settles and never replays", async () => {
  const f = fixture(),
    p = await preparePcb3dTransform(() => f.eda, argumentsFor(f));
  const done = f.component.done.getMockImplementation();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.component.done.mockImplementation(async () => {
    await pending;
    return done();
  });
  vi.useFakeTimers();
  try {
    const run = f.confirm(p);
    await vi.advanceTimersByTimeAsync(45001);
    const unknown: any = await run;
    expect(unknown.status).toBe("unknown");
    expect(unknown.execution.lockHeld).toBe(true);
    expect(unknown.executionEvidence.sdkPending).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionMutations.getExecutionState().lockHeld).toBe(false);
    expect(extensionMutations.get(p.mutationId).executionEvidence).toMatchObject({
      sdkPending: false,
      nativeOriginalPromiseSettled: true
    });
    await expect(f.confirm(p)).rejects.toThrow();
    expect(f.component.done).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await vi.advanceTimersByTimeAsync(0);
  }
});
it("refuses incomplete done core fields before setting any property", async () => {
  const f = fixture();
  delete f.component.getState_AddIntoBom;
  await expect(preparePcb3dTransform(() => f.eda, argumentsFor(f))).rejects.toThrow();
  expect(f.component.setState_OtherProperty).not.toHaveBeenCalled();
});
