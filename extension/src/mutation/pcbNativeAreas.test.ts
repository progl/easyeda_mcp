import { expect, it, vi } from "vitest";
import {
  executePcbCopperKeepoutMutation,
  fetchPcbKeepouts,
  fetchPcbCopperZones,
  preparePcbCopperKeepoutMutation,
  readNativePourFillEvidence
} from "./pcbCopperKeepoutMutations.js";
it("uses native Region positional API with ruleTypes and metric geometry readback", async () => {
  const regions: any[] = [];
  const create = vi.fn(async (layer, complexPolygon, ruleType) => {
    const value = {
      getState_PrimitiveId: () => "keep",
      getState_Layer: () => layer,
      getState_ComplexPolygon: () => complexPolygon,
      getState_RuleType: () => ruleType
    };
    regions.push(value);
    return value;
  });
  const eda = {
    pcb_MathPolygon: { createPolygon: (source: any) => ({ getSource: () => source }) },
    pcb_PrimitiveRegion: { create, getAll: async () => regions }
  };
  const result = await executePcbCopperKeepoutMutation(() => eda, {
    entity: "keepout",
    action: "create",
    layer: 1,
    keepoutType: "all",
    points: [
      { x: 173, y: 65 },
      { x: 180, y: 65 },
      { x: 180, y: 85 },
      { x: 173, y: 85 }
    ]
  });
  expect(create).toHaveBeenCalledExactlyOnceWith(1, expect.any(Object), [2, 5, 6, 7, 8], "MCP keepout", 1, false);
  expect(result.readback).toMatchObject({
    keepout: { bounds: { minX: 173, minY: 65, width: 7, height: 20 }, ruleTypes: [2, 5, 6, 7, 8] }
  });
  expect((await fetchPcbKeepouts(eda)).count).toBe(1);
});
it("uses native Pour and does not claim a completed copper pour or per-zone clearance", async () => {
  const pours: any[] = [];
  const create = vi.fn(async (net, layer, complexPolygon, fill) => {
    const value = {
      getState_PrimitiveId: () => "pour",
      getState_Layer: () => layer,
      getState_Net: () => net,
      getState_ComplexPolygon: () => complexPolygon,
      getState_PourFillMethod: () => fill
    };
    pours.push(value);
    return value;
  });
  const eda = {
    pcb_MathPolygon: { createPolygon: (source: any) => ({ getSource: () => source }) },
    pcb_PrimitivePour: { create, getAll: async () => pours }
  };
  const result = await executePcbCopperKeepoutMutation(() => eda, {
    entity: "copperZone",
    action: "create",
    layer: 2,
    net: "GND2",
    points: [
      { x: 140, y: 100 },
      { x: 178, y: 100 },
      { x: 178, y: 128 },
      { x: 140, y: 128 }
    ]
  });
  expect(create).toHaveBeenCalledExactlyOnceWith(
    "GND2",
    2,
    expect.any(Object),
    "solid",
    false,
    "MCP copper",
    0,
    1,
    false
  );
  expect(result.readback).toMatchObject({
    zone: { net: "GND2", layer: 2, bounds: { minX: 140, minY: 100, width: 38, height: 28 } },
    pouredVerified: false
  });
});
it("refuses unsupported native per-zone clearance before any write", async () => {
  const create = vi.fn();
  await expect(
    executePcbCopperKeepoutMutation(() => ({ pcb_PrimitivePour: { create } }), {
      entity: "copperZone",
      action: "create",
      net: "GND",
      layer: 1,
      clearance: 0.254,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ]
    })
  ).rejects.toThrow(/clearance/);
  expect(create).not.toHaveBeenCalled();
});
it("rejects dropped native restrictions on independent readback without a second write", async () => {
  const polygon = { getSource: () => [0, 0, "L", 100, 0, 100, 100, 0, 0] };
  const create = vi.fn(async () => ({ getState_PrimitiveId: () => "k" }));
  const eda = {
    pcb_MathPolygon: { createPolygon: () => polygon },
    pcb_PrimitiveRegion: {
      create,
      getAll: async () => [
        {
          getState_PrimitiveId: () => "k",
          getState_Layer: () => 1,
          getState_ComplexPolygon: () => polygon,
          getState_RuleType: () => [5]
        }
      ]
    }
  };
  await expect(
    executePcbCopperKeepoutMutation(() => eda, {
      entity: "keepout",
      action: "create",
      layer: 1,
      keepoutType: "all",
      points: [
        { x: 0, y: 0 },
        { x: 2.54, y: 0 },
        { x: 2.54, y: 2.54 }
      ]
    })
  ).rejects.toThrow(/restrictions/);
  expect(create).toHaveBeenCalledTimes(1);
});
it("does not treat an undefined rebuild return as failed mutation when independently owned fill exists", async () => {
  const rebuildCopperRegion = vi.fn(async () => undefined);
  const owned = {
    getState_PourPrimitiveId: () => "p",
    getState_PourFills: () => [
      { id: "fill1", path: { getSource: () => [[0, 0, "L", 100, 0, 100, 100, 0, 0]] }, fill: true }
    ]
  };
  const eda = {
    pcb_PrimitivePour: { get: async () => ({ rebuildCopperRegion }) },
    pcb_PrimitivePoured: { getAll: async () => [owned] }
  };
  const result = await executePcbCopperKeepoutMutation(() => eda, {
    entity: "copperZone",
    action: "rebuild",
    zoneId: "p"
  });
  expect(result.readback).toMatchObject({
    rebuildRequested: true,
    pouredVerified: true,
    fillEvidence: { status: "filled", pourPrimitiveId: "p", fillCount: 1 },
    rebuildFreshnessVerified: false
  });
  expect(rebuildCopperRegion).toHaveBeenCalledTimes(1);
});
it("does not accept a returned fill for another pour or an empty native fill inventory as verified copper", async () => {
  const rebuildCopperRegion = vi.fn(async () => ({ getState_PourPrimitiveId: () => "other" }));
  const result = await executePcbCopperKeepoutMutation(
    () => ({
      pcb_PrimitivePour: { get: async () => ({ rebuildCopperRegion }) },
      pcb_PrimitivePoured: { getAll: async () => [] }
    }),
    { entity: "copperZone", action: "rebuild", zoneId: "p" }
  );
  expect(result.readback).toMatchObject({
    rebuildRequested: true,
    pouredVerified: false,
    fillEvidence: { status: "absent" }
  });
  expect(rebuildCopperRegion).toHaveBeenCalledTimes(1);
});
it("exposes owned fill through read-only copper inventory without ever rebuilding", async () => {
  const rebuildCopperRegion = vi.fn();
  const polygon = { getSource: () => [0, 0, "L", 100, 0, 100, 100, 0, 0] };
  const eda = {
    pcb_PrimitivePour: {
      getAll: async () => [
        {
          getState_PrimitiveId: () => "p",
          getState_Net: () => "GND",
          getState_Layer: () => 1,
          getState_ComplexPolygon: () => polygon
        }
      ],
      get: async () => ({ rebuildCopperRegion })
    },
    pcb_PrimitivePoured: {
      getAll: async () => [
        { getState_PourPrimitiveId: () => "p", getState_PourFills: () => [{ id: "f", path: polygon }] }
      ]
    }
  };
  const result = await fetchPcbCopperZones(eda);
  expect(result.zones[0]).toMatchObject({
    primitiveId: "p",
    isPoured: true,
    pouredVerified: true,
    fillEvidence: { status: "filled", pourPrimitiveId: "p", fillCount: 1 }
  });
  expect(rebuildCopperRegion).not.toHaveBeenCalled();
});
it("keeps unreadable or wrong-owner native copper getters unknown", async () => {
  const wrong = await readNativePourFillEvidence(
    {
      pcb_PrimitivePour: {
        get: async () => ({
          getCopperRegion: async () => ({
            getState_PourPrimitiveId: () => "other",
            getState_PourFills: () => []
          })
        })
      }
    },
    "p"
  );
  expect(wrong.status).toBe("unknown");
  const malformed = await readNativePourFillEvidence(
    {
      pcb_PrimitivePoured: {
        getAll: async () => [
          {
            getState_PourPrimitiveId: () => "p",
            getState_PourFills: () => [{ path: { getSource: () => [] } }]
          }
        ]
      }
    },
    "p"
  );
  expect(malformed.status).toBe("unknown");
});
it("forwards integer native priority positions and reads the effective clamped order instead of claiming the argument was stored", async () => {
  const polygon = { getSource: () => [0, 0, "L", 100, 0, 100, 100, 0, 0] };
  let priority = 2;
  const zone = {
    getState_PrimitiveId: () => "p",
    getState_Net: () => "VM",
    getState_Layer: () => 1,
    getState_ComplexPolygon: () => polygon,
    getState_PourFillMethod: () => "solid",
    getState_PourPriority: () => priority
  };
  const create = vi.fn(async () => zone),
    modify = vi.fn(async (_id, _properties) => {
      priority = 3;
      return zone;
    });
  const eda = {
    pcb_MathPolygon: { createPolygon: () => polygon },
    pcb_PrimitivePour: { create, modify, getAll: async () => [zone] }
  };
  const result = await executePcbCopperKeepoutMutation(() => eda, {
    entity: "copperZone",
    action: "create",
    net: "VM",
    layer: 1,
    points: [
      { x: 0, y: 0 },
      { x: 2.54, y: 0 },
      { x: 2.54, y: 2.54 }
    ],
    pourPriority: 10
  } as any);
  expect(create).toHaveBeenCalledExactlyOnceWith("VM", 1, polygon, "solid", false, "MCP copper", 10, 1, false);
  expect(result.readback).toMatchObject({
    zone: { pourPriority: 2 },
    priorityReadback: { requestedPosition: 10, observedOrder: 2, positiveAssignmentVerified: true }
  });
  const change = await executePcbCopperKeepoutMutation(() => eda, {
    entity: "copperZone",
    action: "modify",
    zoneId: "p",
    properties: { pourPriority: 10 }
  } as any);
  expect(modify).toHaveBeenCalledExactlyOnceWith("p", { pourPriority: 10 });
  expect(change.readback).toMatchObject({
    zone: { pourPriority: 3 },
    priorityReadback: { requestedPosition: 10, observedOrder: 3 }
  });
});
it("rejects unknown native modify properties and unverifiable zero priority before any write", async () => {
  const modify = vi.fn(),
    create = vi.fn();
  const eda = { pcb_PrimitivePour: { modify, create } };
  await expect(
    executePcbCopperKeepoutMutation(() => eda, {
      entity: "copperZone",
      action: "modify",
      zoneId: "p",
      properties: { notARealProperty: 1 }
    } as any)
  ).rejects.toThrow(/unknown|unsupported/i);
  await expect(
    executePcbCopperKeepoutMutation(() => eda, {
      entity: "copperZone",
      action: "create",
      net: "VM",
      layer: 1,
      points: [],
      pourPriority: 0
    } as any)
  ).rejects.toThrow(/priority|positive/i);
  expect(modify).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it("prepares native priority without writing and rejects typo properties during preview", async () => {
  const create = vi.fn(),
    modify = vi.fn();
  const polygon = { getSource: () => [0, 0, "L", 100, 0, 100, 100, 0, 0] };
  const eda = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "pcb", parentProjectUuid: "project", documentType: 3 })
    },
    pcb_PrimitivePour: {
      create,
      modify,
      getAll: async () => [
        {
          getState_PrimitiveId: () => "gnd",
          getState_Net: () => "GND",
          getState_Layer: () => 1,
          getState_PourPriority: () => 2,
          getState_ComplexPolygon: () => polygon
        }
      ]
    }
  };
  const preview: any = await preparePcbCopperKeepoutMutation(() => eda, {
    entity: "copperZone",
    action: "modify",
    zoneId: "gnd",
    properties: { pourPriority: 10 }
  });
  expect(preview.preview.requestedAfter).toMatchObject({ requestedPriorityPosition: 10 });
  expect(preview.preview.requestedAfter.pourPriority).toBeUndefined();
  await expect(
    preparePcbCopperKeepoutMutation(() => eda, {
      entity: "copperZone",
      action: "modify",
      zoneId: "gnd",
      properties: { priorityTypo: 10 }
    })
  ).rejects.toThrow(/Unknown/);
  expect(create).not.toHaveBeenCalled();
  expect(modify).not.toHaveBeenCalled();
});
