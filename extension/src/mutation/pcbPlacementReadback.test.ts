import { expect, it, vi } from "vitest";
import { executePcbPlacements } from "./pcbPlacementReadback.js";
function fixture() {
  const states: any = {
    c1: {
      primitiveId: "c1",
      designator: "R1",
      uniqueId: "uid1",
      footprint: { uuid: "fp1" },
      x: 0,
      y: 0,
      rotation: 0,
      layer: 1
    },
    c2: {
      primitiveId: "c2",
      designator: "R2",
      uniqueId: "uid2",
      footprint: { uuid: "fp2" },
      x: 100,
      y: 0,
      rotation: 0,
      layer: 1
    }
  };
  const snapshot = (s: any) =>
    Object.fromEntries(
      Object.entries(s).map(([k, v]) => [`getState_${k[0].toUpperCase() + k.slice(1)}`, () => structuredClone(v)])
    );
  let busy = false,
    dropped = 0;
  const sdk: any = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "pcb", parentProjectUuid: "p", documentType: 3 })
    },
    pcb_PrimitiveComponent: {
      get: vi.fn(async (id: string) => snapshot(states[id])),
      getAll: async () => Object.values(states).map(snapshot),
      getAllPinsByPrimitiveId: vi.fn(async (id: string) => [
        { primitiveId: id + "-1", padNumber: "1", net: "GND", parentComponentPrimitiveId: id }
      ]),
      modify: vi.fn(async (id: string, patch: any) => {
        if (busy) {
          dropped++;
          return;
        }
        busy = true;
        setTimeout(() => {
          Object.assign(states[id], patch);
          busy = false;
        }, 20);
        return { primitiveId: id, x: patch.x, y: patch.y };
      })
    }
  };
  return { states, sdk, api: () => sdk, dropped: () => dropped };
}
it("serializes SDK fire-and-forget persistence and verifies independent getters/pad netlinks, without Y inversion", async () => {
  const f = fixture();
  const result = await executePcbPlacements(
    f.api,
    [
      { primitiveId: "c1", x: 25, y: -50 },
      { primitiveId: "c2", x: 125, y: 50, rotation: 90 }
    ],
    { budgetMs: 1000, readbackMs: 300 }
  );
  expect(result.verified).toBe(true);
  expect(f.dropped()).toBe(0);
  expect(f.sdk.pcb_PrimitiveComponent.modify).toHaveBeenCalledTimes(2);
  expect(f.states.c1).toMatchObject({ x: 25, y: -50, uniqueId: "uid1", footprint: { uuid: "fp1" } });
  expect(f.states.c2.rotation).toBe(90);
  expect(f.sdk.pcb_PrimitiveComponent.get.mock.calls.length).toBeGreaterThan(2);
});
it("never trusts the optimistic SDK modify return when native getters never change", async () => {
  const f = fixture();
  f.sdk.pcb_PrimitiveComponent.modify.mockResolvedValue({ primitiveId: "c1", x: 25, y: 50 });
  await expect(
    executePcbPlacements(
      f.api,
      [
        { primitiveId: "c1", x: 25, y: 50 },
        { primitiveId: "c2", x: 125, y: 50 }
      ],
      { budgetMs: 200, readbackMs: 60 }
    )
  ).rejects.toThrow(/Do not replay|unknown/i);
  expect(f.sdk.pcb_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
});
it("fails closed before placement if pad netlink getters are unavailable", async () => {
  const f = fixture();
  delete f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
  await expect(executePcbPlacements(f.api, [{ primitiveId: "c1", x: 1, y: 2 }])).rejects.toThrow(/pad|netlink/i);
  expect(f.sdk.pcb_PrimitiveComponent.modify).not.toHaveBeenCalled();
});
it("does not continue after a late hanging getter or a target drift", async () => {
  const f = fixture();
  let resolve!: (x: any) => void;
  f.sdk.pcb_PrimitiveComponent.get.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  await expect(executePcbPlacements(f.api, [{ primitiveId: "c1", x: 1, y: 2 }], { budgetMs: 30 })).rejects.toThrow(
    /deadline|budget/i
  );
  resolve({});
  await new Promise((r) => setTimeout(r, 5));
  expect(f.sdk.pcb_PrimitiveComponent.modify).not.toHaveBeenCalled();
});
it("stops before the next write on target drift or changed netlinks", async () => {
  const f = fixture();
  f.sdk.pcb_PrimitiveComponent.modify.mockImplementation(async (id: string, patch: any) => {
    Object.assign(f.states[id], patch);
    f.sdk.dmt_SelectControl.getCurrentDocumentInfo = async () => ({
      uuid: "other",
      parentProjectUuid: "p",
      documentType: 3
    });
  });
  await expect(
    executePcbPlacements(
      f.api,
      [
        { primitiveId: "c1", x: 1, y: 2 },
        { primitiveId: "c2", x: 101, y: 2 }
      ],
      { budgetMs: 500 }
    )
  ).rejects.toThrow(/Do not replay/);
  expect(f.sdk.pcb_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
  const g = fixture();
  g.sdk.pcb_PrimitiveComponent.modify.mockImplementation(async (id: string, patch: any) => {
    Object.assign(g.states[id], patch);
    g.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId.mockResolvedValue([
      { primitiveId: id + "-1", padNumber: "1", net: "BAD" }
    ]);
  });
  await expect(
    executePcbPlacements(
      g.api,
      [
        { primitiveId: "c1", x: 1, y: 2 },
        { primitiveId: "c2", x: 101, y: 2 }
      ],
      { budgetMs: 500 }
    )
  ).rejects.toThrow(/netlinks changed/);
  expect(g.sdk.pcb_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
});
