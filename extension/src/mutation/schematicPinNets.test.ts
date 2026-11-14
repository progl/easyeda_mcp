import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSchematicComponentMutation, executeSchematicComponentMutation } from "./schematicComponentMutations.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";

function fixture() {
  const pins = [
    { pinNumber: "1", x: 100, y: 100, rotation: 180 },
    { pinNumber: "2", x: 140, y: 100, rotation: 0 }
  ];
  const wires: any[] = [];
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: vi.fn(async () => ({ uuid: "sch1", documentType: 1 })) },
    sch_PrimitiveComponent: {
      getAll: vi.fn(async () => [{ primitiveId: "r1", designator: "R1", x: 120, y: 100 }]),
      getAllPinsByPrimitiveId: vi.fn(async () => pins),
      modify: vi.fn()
    },
    sch_PrimitiveWire: {
      getAll: vi.fn(async () => wires),
      create: vi.fn(async (line: number[], net: string) => {
        const w = { primitiveId: `w${wires.length}`, line, net };
        wires.push(w);
        return w;
      })
    }
  };
  return { eda, pins, wires, api: () => eda };
}

describe("component pin-net batch", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  const params = {
    action: "update",
    component: "R1",
    properties: { pinNets: { "1": "VCC", "2": "GND" }, wireStubLength: 2 }
  };

  it("previews without writing, then connects both pins under one confirmed mutation", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    expect(p.action).toBe("assignPinNets");
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
    const result = await executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api);
    expect(result.readback.verified).toBe(true);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
    expect(f.wires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: [100, 100, 98, 100], net: "VCC" }),
        expect.objectContaining({ line: [140, 100, 142, 100], net: "GND" })
      ])
    );
  });

  it("keeps mixed numeric and composite USB pin plans stable across mutation serialization", async () => {
    const f = fixture();
    const numbers = [
      "A1B12",
      "A4B9",
      "B8",
      "A5",
      "B7",
      "A6",
      "A7",
      "B6",
      "A8",
      "B5",
      "B4A9",
      "B1A12",
      "4",
      "3",
      "2",
      "1"
    ];
    f.pins.splice(
      0,
      f.pins.length,
      ...numbers.map((pinNumber, index) => ({ pinNumber, x: 100, y: index * 20, rotation: 180 }))
    );
    f.eda.sch_PrimitiveComponent.getAll.mockResolvedValue([
      { primitiveId: "usb", designator: "J_USB", x: 120, y: 100 }
    ]);
    const p = await prepareSchematicComponentMutation(f.api, {
      action: "update",
      component: "J_USB",
      properties: {
        wireStubLength: 2,
        pinNets: {
          A1B12: "GND",
          B1A12: "GND",
          "1": "GND",
          "2": "GND",
          "3": "GND",
          "4": "GND",
          A4B9: "USB_VBUS",
          B4A9: "USB_VBUS",
          A5: "USB_CC1",
          B5: "USB_CC2"
        }
      }
    });
    const handlers = createActionHandlers(f.api, {} as any, extensionMutations);
    const result = (await handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    })) as any;
    expect(result.status).toBe("applied");
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(10);
    expect(f.wires.filter((wire) => wire.net === "GND")).toHaveLength(6);
    expect(f.wires.filter((wire) => wire.net === "USB_VBUS")).toHaveLength(2);
  });

  it("stops a partial write without replaying earlier pins", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    f.eda.sch_PrimitiveWire.create
      .mockImplementationOnce(async (line, net) => {
        const item = { primitiveId: "first", line, net };
        f.wires.push(item);
        return item;
      })
      .mockRejectedValueOnce(new Error("native error"));
    await expect(
      executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api)
    ).rejects.toThrow(/Do not replay/);
    expect(f.wires).toHaveLength(1);
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(2);
  });

  it("waits for deferred wire publication without creating duplicate wires", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    let pendingReads = 2;
    f.eda.sch_PrimitiveWire.getAll.mockImplementation(async () =>
      f.wires.length && pendingReads-- > 0 ? [] : f.wires
    );
    const result = await executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api);
    expect(result.readback.verified).toBe(true);
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(2);
  });

  it("accepts exact native pin membership while wire publication is still stale", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    f.eda.sch_PrimitiveWire.getAll.mockResolvedValue([]);
    const exportNetlist = vi.fn(async () => ({ text: async () => "(\nVCC\nR1-1\n)\n(\nGND\nR1-2\n)" }));
    const api = () => ({ ...f.eda, sch_ManufactureData: { getNetlistFile: exportNetlist } });
    const result = await executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), api);
    expect(result.readback.verified).toBe(true);
    expect(result.readback.verificationSource).toBe("native_netlist");
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(2);
    expect(exportNetlist).toHaveBeenCalledTimes(1);
  });

  it("stops after the bounded readback window without replaying missing wires", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    f.eda.sch_PrimitiveWire.getAll.mockResolvedValue([]);
    await expect(
      executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api)
    ).rejects.toThrow(/Do not replay/);
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(2);
    expect(f.eda.sch_PrimitiveWire.getAll.mock.calls.length).toBeLessThan(40);
  });

  it("does not confirm geometric wires when native pin membership conflicts", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    const api = () => ({
      ...f.eda,
      sch_ManufactureData: {
        getNetlistFile: vi.fn(async () => ({ text: async () => "(\nOTHER\nR1-1\n)\n(\nGND\nR1-2\n)" }))
      }
    });
    await expect(executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), api)).rejects.toThrow(
      /native.*conflict/i
    );
    expect(f.eda.sch_PrimitiveWire.create).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown pin numbers before any write", async () => {
    const f = fixture();
    await expect(
      prepareSchematicComponentMutation(f.api, {
        ...params,
        properties: { pinNets: { "99": "VCC" } }
      })
    ).rejects.toThrow(/pin.*99/i);
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
  });

  it("rejects a stub crossing the interior of another net", async () => {
    const f = fixture();
    f.wires.push({ primitiveId: "existing", net: "OTHER", line: [99, 90, 99, 110] });
    await expect(prepareSchematicComponentMutation(f.api, params)).rejects.toThrow(/intersect|collision/i);
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
  });

  it("does not silently rename a wire already connected to another net", async () => {
    const f = fixture();
    f.wires.push({ primitiveId: "existing", net: "OTHER", line: [95, 100, 100, 100] });
    await expect(prepareSchematicComponentMutation(f.api, params)).rejects.toThrow(/already|conflict/i);
  });

  it("rejects component movement after preview", async () => {
    const f = fixture();
    const p = await prepareSchematicComponentMutation(f.api, params);
    f.pins[0].x++;
    await expect(
      executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api)
    ).rejects.toThrow(/stale|changed/i);
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
  });

  it("treats existing correct connections as a no-op", async () => {
    const f = fixture();
    f.wires.push({ primitiveId: "a", net: "VCC", line: [98, 100, 100, 100] });
    f.wires.push({ primitiveId: "b", net: "GND", line: [140, 100, 142, 100] });
    const p = await prepareSchematicComponentMutation(f.api, params);
    await executeSchematicComponentMutation(extensionMutations.get(String(p.mutationId)), f.api);
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
  });
});

describe("save dispatch", () => {
  it("uses the schematic save API when PCB save also exists", async () => {
    const f = fixture();
    const schSave = vi.fn(async () => true),
      pcbSave = vi.fn(async () => true);
    const handlers = createActionHandlers(
      () => ({ ...f.eda, sch_Document: { save: schSave }, pcb_Document: { save: pcbSave } }),
      {} as any
    );
    await handlers.confirmedAction({ action: "save", confirmation: "CONFIRM save" });
    expect(schSave).toHaveBeenCalledWith("sch1");
    expect(pcbSave).not.toHaveBeenCalled();
  });
});
