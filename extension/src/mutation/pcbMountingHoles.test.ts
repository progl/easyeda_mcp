import { beforeEach, expect, it, vi } from "vitest";
import { prepareMountingHoles, executeMountingHoles } from "./pcbMountingHoles.js";
import { extensionMutations } from "./mutationManager.js";
beforeEach(() => extensionMutations.invalidateAll());
function fixture() {
  const pads = new Map<string, any>();
  const create = vi.fn(async (layer, number, x, y, rotation, pad, net, hole, ox, oy, hr, plating) => {
    const id = `hole${pads.size}`;
    const value = Object.fromEntries(
      Object.entries({
        PrimitiveId: id,
        Layer: layer,
        X: x,
        Y: y,
        Pad: pad,
        Net: net,
        Hole: hole,
        HoleOffsetX: ox,
        HoleOffsetY: oy,
        Metallization: plating
      }).map(([key, v]) => [`getState_${key}`, () => v])
    );
    pads.set(id, value);
    return value;
  });
  const eda = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "pcb", parentProjectUuid: "project", documentType: 3 })
    },
    pcb_PrimitivePad: { create, get: async (id: string) => pads.get(id), getAll: async () => [...pads.values()] }
  };
  return { eda, create, pads };
}
it("prepares metric NPTH without writing and confirms real pad/hole/plating readback", async () => {
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { units: "mm", holes: [{ x: 25.4, y: 12.7, diameter: 3.2 }] });
  expect(f.create).not.toHaveBeenCalled();
  const record: any = extensionMutations.get(p.mutationId);
  const result = await executeMountingHoles(() => f.eda, record);
  const d = 3.2 / 0.0254;
  expect(f.create).toHaveBeenCalledExactlyOnceWith(
    12,
    "",
    1000,
    500,
    0,
    ["ELLIPSE", d, d],
    "",
    ["ROUND", d],
    0,
    0,
    0,
    false,
    0
  );
  expect(result.readback).toMatchObject({ verified: true, nonPlated: true });
});
it("rejects changed targets before any hole write", async () => {
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { holes: [{ x: 1, y: 2, diameter: 100 }] });
  f.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({
    uuid: "other",
    parentProjectUuid: "project",
    documentType: 3
  });
  await expect(executeMountingHoles(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(
    /target|document/i
  );
  expect(f.create).not.toHaveBeenCalled();
});
it("accepts native 0.1mil XY/pad rounding while keeping exact drill and non-plating checks", async () => {
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { units: "mm", holes: [{ x: 3.5, y: 3.5, diameter: 3.2 }] });
  f.eda.pcb_PrimitivePad.get = async (id: string) => ({
    ...f.pads.get(id),
    getState_X: () => 137.8,
    getState_Y: () => 137.8,
    getState_Pad: () => ["ELLIPSE", 126, 126]
  });
  expect(await executeMountingHoles(() => f.eda, extensionMutations.get(p.mutationId))).toMatchObject({
    executed: true,
    readback: { verified: true }
  });
  await expect(
    prepareMountingHoles(
      () => ({
        ...f.eda,
        pcb_PrimitivePad: {
          ...f.eda.pcb_PrimitivePad,
          getAll: async () => [{ getState_X: () => 137.8, getState_Y: () => 137.8 }]
        }
      }),
      { units: "mm", holes: [{ x: 3.5, y: 3.5, diameter: 3.2 }] }
    )
  ).rejects.toThrow(/occupied/);
});
it("refuses an occupied center after preview and does not repeat uncertain writes", async () => {
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { holes: [{ x: 1, y: 2, diameter: 100 }] });
  f.pads.set("old", { getState_X: () => 1, getState_Y: () => 2 });
  await expect(executeMountingHoles(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(/occupied/i);
  expect(f.create).not.toHaveBeenCalled();
});
it("never accepts plated or mismatched independent readback and never creates a replacement", async () => {
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { holes: [{ x: 1, y: 2, diameter: 100 }] });
  f.eda.pcb_PrimitivePad.get = async (id: string) => ({ ...f.pads.get(id), getState_Metallization: () => true });
  await expect(executeMountingHoles(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(
    /unknown|uncertain/i
  );
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("integrates exact confirmation and never replays a consumed uncertain hole mutation", async () => {
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const f = fixture();
  const p: any = await prepareMountingHoles(() => f.eda, { holes: [{ x: 1, y: 2, diameter: 100 }] });
  const handlers = createActionHandlers(() => f.eda, {} as any);
  const params = { action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation };
  f.eda.pcb_PrimitivePad.get = async () => undefined;
  expect(await handlers.confirmedAction(params)).toMatchObject({ status: "unknown" });
  expect(extensionMutations.get(p.mutationId).status).toBe("unknown");
  await expect(handlers.confirmedAction(params)).rejects.toThrow();
  expect(f.create).toHaveBeenCalledTimes(1);
});
