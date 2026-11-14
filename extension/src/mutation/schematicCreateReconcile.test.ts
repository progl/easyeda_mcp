import { extractDocumentIdentity } from "../identity.js";
import { expect, it, vi, beforeEach } from "vitest";
import { extensionMutations } from "./mutationManager.js";
import { reconcileSchematicCreate } from "./schematicCreateReconcile.js";
const target = extractDocumentIdentity({ uuid: "page", parentProjectUuid: "p", documentType: 1 });
const device = { uuid: "d".repeat(32), libraryUuid: "l".repeat(32), name: "S4B" };
const footprint = { uuid: "cached-footprint", libraryUuid: device.libraryUuid, name: "PH-angle" };
async function fixture() {
  const r = extensionMutations.prepare({
    domain: "schematic",
    action: "createComponent",
    target,
    operation: {
      action: "createComponent",
      device,
      x: 100,
      y: 200,
      rotation: 0,
      mirror: false,
      uniqueId: "binding",
      designator: "J1",
      addIntoBom: true,
      addIntoPcb: true
    },
    before: {},
    requestedAfter: {},
    changedKeys: [],
    scope: "s",
    impact: "i"
  });
  await extensionMutations.apply({
    mutationId: r.mutationId,
    confirmation: r.confirmation,
    currentTarget: target,
    currentBefore: {},
    execute: async () => {
      throw Object.assign(new Error("Created component new-id could not be independently verified"), {
        code: "write_readback_unknown"
      });
    },
    readback: async () => ({})
  });
  const writes = vi.fn();
  const raw = {
    primitiveId: "new-id",
    componentType: "part",
    component: { ...device, uuid: "cached-device" },
    footprint,
    designator: "J1",
    uniqueId: "binding",
    x: 100,
    y: 200,
    rotation: 0,
    mirror: false,
    addIntoBom: true,
    addIntoPcb: true
  };
  const eda = {
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "p" }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "page", parentProjectUuid: "p", documentType: 1 })
    },
    dmt_Schematic: { getCurrentSchematicInfo: async () => ({ uuid: "sch", parentProjectUuid: "p" }) },
    dmt_Board: {
      getCurrentBoardInfo: async () => ({
        name: "R2",
        parentProjectUuid: "p",
        schematic: { uuid: "sch", page: [{ uuid: "page", parentSchematicUuid: "sch" }] }
      })
    },
    sch_PrimitiveComponent: {
      getAll: async () => [raw],
      getAllPinsByPrimitiveId: async () => [{ primitiveId: "pin1", pinNumber: "1", x: 90, y: 200 }],
      create: writes,
      modify: writes,
      delete: writes
    },
    sch_ManufactureData: {
      getNetlistFile: async () => ({
        text: async () =>
          JSON.stringify({
            components: { binding: { props: { Designator: "J1" }, pinInfoMap: { "1": { number: "1", net: "" } } } }
          })
      })
    }
  };
  return {
    r,
    eda,
    writes,
    params: {
      mutationId: r.mutationId,
      primitiveId: "new-id",
      expectedFootprint: footprint,
      expectedPins: [{ pinNumber: "1", x: 90, y: 200, net: "" }]
    }
  };
}
beforeEach(() => extensionMutations.invalidateAll());
it("reconciles only settled create through scoped public getters with zero writes", async () => {
  const f = await fixture();
  const r: any = await reconcileSchematicCreate(() => f.eda, f.params);
  expect(r.status).toBe("applied");
  expect(r.after).toMatchObject({
    verified: true,
    reconciledReadOnly: true,
    uniqueId: "binding",
    catalogOriginVerified: false
  });
  expect(f.writes).not.toHaveBeenCalled();
});
it("wrong reviewed pin geometry remains unknown and performs no writes", async () => {
  const f = await fixture();
  await expect(
    reconcileSchematicCreate(() => f.eda, { ...f.params, expectedPins: [{ pinNumber: "1", x: 91, y: 200, net: "" }] })
  ).rejects.toThrow();
  expect(extensionMutations.get(f.r.mutationId).status).toBe("unknown");
  expect(f.writes).not.toHaveBeenCalled();
});
