import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extensionMutations } from "./mutationManager.js";
import {
  executePcbTrackViaMutation,
  assertTrackCoverage,
  fetchPcbTracks,
  fetchPcbVias,
  normalizePcbTrack,
  normalizePcbVia,
  preparePcbTrackViaMutation
} from "./pcbTrackViaMutations.js";

describe("pcbTrackViaMutations", () => {
  it("returns full 1200-track/via inventories on explicit limit2000 while preserving default100", async () => {
    const primitives = Array.from({ length: 1200 }, (_, i) => ({
      primitiveId: `p${i}`,
      net: "GND",
      layer: 1,
      startX: i,
      startY: 0,
      endX: i + 1,
      endY: 0,
      lineWidth: 10,
      x: i,
      y: 0,
      diameter: 24,
      holeDiameter: 12
    }));
    const eda = {
      pcb_PrimitiveLine: { getAll: async () => primitives },
      pcb_PrimitiveVia: { getAll: async () => primitives }
    };
    expect((await fetchPcbTracks(eda, { limit: 2000 })).tracks).toHaveLength(1200);
    expect((await fetchPcbVias(eda, { limit: 2000 })).vias).toHaveLength(1200);
    expect((await fetchPcbTracks(eda)).tracks).toHaveLength(100);
    expect((await fetchPcbVias(eda)).vias).toHaveLength(100);
  });
  it("does not report non-copper outline lines as tracks in the SDK line fallback", async () => {
    const result = await fetchPcbTracks({
      pcb_PrimitiveLine: {
        getAll: async () => [
          { primitiveId: "outline", layer: 11, startX: 0, startY: 0, endX: 1000, endY: 0 },
          { primitiveId: "trace", layer: 1, net: "GND", startX: 0, startY: 0, endX: 1000, endY: 0, lineWidth: 10 }
        ]
      }
    });
    expect(result.tracks.map((track) => track.primitiveId)).toEqual(["trace"]);
    expect(result).toMatchObject({ units: "mil" });
  });
  beforeEach(() => {
    extensionMutations.invalidateAll();
  });

  const pcbDocInfo = {
    uuid: "pcb-doc-1",
    documentType: 3,
    parentProjectUuid: "proj-1",
    name: "Board.PcbDoc"
  };

  const mockTrack1 = {
    getState_PrimitiveId: () => "trk-1",
    getState_Net: () => "GND",
    getState_Layer: () => 1,
    getState_LineWidth: () => 0.254,
    getState_StartX: () => 10,
    getState_StartY: () => 10,
    getState_EndX: () => 30,
    getState_EndY: () => 10,
    getState_PrimitiveLock: () => false
  };

  const mockTrack2 = {
    getState_PrimitiveId: () => "trk-2",
    getState_Net: () => "VCC",
    getState_Layer: () => 2,
    getState_LineWidth: () => 0.5,
    getState_StartX: () => 5,
    getState_StartY: () => 5,
    getState_EndX: () => 5,
    getState_EndY: () => 25,
    getState_PrimitiveLock: () => false
  };

  const mockVia1 = {
    getState_PrimitiveId: () => "via-1",
    getState_Net: () => "GND",
    getState_X: () => 20,
    getState_Y: () => 20,
    getState_Diameter: () => 0.6,
    getState_HoleDiameter: () => 0.3,
    getState_StartLayer: () => 1,
    getState_EndLayer: () => 2,
    getState_PrimitiveLock: () => false
  };

  function createMockApi(tracks: any[] = [mockTrack1, mockTrack2], vias: any[] = [mockVia1]) {
    return {
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => pcbDocInfo)
      },
      pcb_PrimitiveTrack: {
        getAll: vi.fn(async () => tracks),
        create: vi.fn(async (params) => ({
          getState_PrimitiveId: () => "trk-created-1",
          ...params
        })),
        modify: vi.fn(async () => true),
        delete: vi.fn(async () => true)
      },
      pcb_PrimitiveVia: {
        getAll: vi.fn(async () => vias),
        create: vi.fn(async (params) => ({
          getState_PrimitiveId: () => "via-created-1",
          ...params
        })),
        modify: vi.fn(async () => true),
        delete: vi.fn(async () => true)
      }
    };
  }

  describe("normalization", () => {
    it("normalizes track and calculates euclidean length", () => {
      const normalized = normalizePcbTrack(mockTrack1);
      expect(normalized).toBeDefined();
      expect(normalized?.primitiveId).toBe("trk-1");
      expect(normalized?.net).toBe("GND");
      expect(normalized?.layer).toBe(1);
      expect(normalized?.lineWidth).toBe(0.254);
      expect(normalized?.length).toBe(20);
    });

    it("normalizes via with coordinates and drill diameter", () => {
      const normalized = normalizePcbVia(mockVia1);
      expect(normalized).toBeDefined();
      expect(normalized?.primitiveId).toBe("via-1");
      expect(normalized?.net).toBe("GND");
      expect(normalized?.x).toBe(20);
      expect(normalized?.y).toBe(20);
      expect(normalized?.diameter).toBe(0.6);
      expect(normalized?.holeDiameter).toBe(0.3);
    });
  });

  describe("fetchPcbTracks & fetchPcbVias", () => {
    it("filters tracks by net and layer", async () => {
      const api = createMockApi();
      const result = await fetchPcbTracks(api, { net: "GND" });
      expect(result.total).toBe(2);
      expect(result.count).toBe(1);
      expect(result.tracks[0].primitiveId).toBe("trk-1");

      const layer2Result = await fetchPcbTracks(api, { layer: 2 });
      expect(layer2Result.count).toBe(1);
      expect(layer2Result.tracks[0].primitiveId).toBe("trk-2");
    });

    it("filters vias by net", async () => {
      const api = createMockApi();
      const result = await fetchPcbVias(api, { net: "GND" });
      expect(result.total).toBe(1);
      expect(result.count).toBe(1);
      expect(result.vias[0].primitiveId).toBe("via-1");
    });
  });

  describe("preparePcbTrackViaMutation", () => {
    it("prepares track creation mutation", async () => {
      const api = createMockApi();
      const result = (await preparePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "create",
        net: "GND",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        lineWidth: 0.3
      })) as any;

      expect(result.mutationId).toBeDefined();
      expect(result.confirmation).toBe(`CONFIRM pcb:createTrack ${result.mutationId}`);
      expect(result.preview.impact).toContain("Creates PCB track on layer 1");
    });

    it("prepares track modification mutation with before snapshot", async () => {
      const api = createMockApi();
      const result = (await preparePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "modify",
        trackId: "trk-1",
        properties: { lineWidth: 0.4 }
      })) as any;

      expect(result.mutationId).toBeDefined();
      expect(result.confirmation).toBe(`CONFIRM pcb:modifyTrack ${result.mutationId}`);
      expect(result.preview.before.lineWidth).toBe(0.254);
    });

    it("prepares track deletion mutation with destructive preview", async () => {
      const api = createMockApi();
      const result = (await preparePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "delete",
        trackId: "trk-1"
      })) as any;

      expect(result.mutationId).toBeDefined();
      expect(result.confirmation).toBe(`CONFIRM pcb:deleteTrack ${result.mutationId}`);
      expect(result.preview.impact).toContain("Destructively deletes PCB track trk-1");
    });

    it("prepares via creation mutation", async () => {
      const api = createMockApi();
      const result = (await preparePcbTrackViaMutation(() => api, {
        entity: "via",
        action: "create",
        net: "VCC",
        x: 50,
        y: 60,
        diameter: 0.8,
        holeDiameter: 0.4
      })) as any;

      expect(result.mutationId).toBeDefined();
      expect(result.confirmation).toBe(`CONFIRM pcb:createVia ${result.mutationId}`);
      expect(result.preview.impact).toContain("Creates PCB via at (50, 60)");
    });

    it("prepares via modification and deletion mutations", async () => {
      const api = createMockApi();
      const modResult = (await preparePcbTrackViaMutation(() => api, {
        entity: "via",
        action: "modify",
        viaId: "via-1",
        properties: { diameter: 0.7 }
      })) as any;
      expect(modResult.confirmation).toBe(`CONFIRM pcb:modifyVia ${modResult.mutationId}`);

      const delResult = (await preparePcbTrackViaMutation(() => api, {
        entity: "via",
        action: "delete",
        viaId: "via-1"
      })) as any;
      expect(delResult.confirmation).toBe(`CONFIRM pcb:deleteVia ${delResult.mutationId}`);
    });

    it("rejects when document is not a PCB", async () => {
      const api = createMockApi();
      api.dmt_SelectControl.getCurrentDocumentInfo = vi.fn(async () => ({ documentType: 1 })); // Schematic
      await expect(
        preparePcbTrackViaMutation(() => api, {
          entity: "track",
          action: "create",
          net: "GND",
          startX: 0,
          startY: 0,
          endX: 1,
          endY: 1
        })
      ).rejects.toThrow("active PCB document");
    });

    it("asserts target match", async () => {
      const api = createMockApi();
      await expect(
        preparePcbTrackViaMutation(() => api, {
          entity: "track",
          action: "create",
          net: "GND",
          startX: 0,
          startY: 0,
          endX: 1,
          endY: 1,
          target: { documentId: "wrong-id" }
        })
      ).rejects.toThrow("Active document");
    });
  });

  describe("executePcbTrackViaMutation", () => {
    it("uses the SDK positional via signature with drill before outer diameter", async () => {
      const vias: any[] = [];
      const create = vi.fn(async (net, x, y, holeDiameter, diameter) => {
        const via = { primitiveId: "sdk-via", net, x, y, holeDiameter, diameter };
        vias.push(via);
        return via;
      });
      const result = await executePcbTrackViaMutation(
        () => ({ pcb_PrimitiveVia: { getAll: async () => vias, create } }),
        {
          entity: "via",
          action: "create",
          net: "GND",
          x: 1000,
          y: -500,
          holeDiameter: 12,
          diameter: 24
        }
      );
      expect(create).toHaveBeenCalledWith("GND", 1000, -500, 12, 24);
      expect(result.readback.primitiveId).toBe("sdk-via");
    });
    it("uses the SDK net-first signature for PCB line fallback creation", async () => {
      const lines: any[] = [];
      const create = vi.fn(async (net, layer, startX, startY, endX, endY, lineWidth) => {
        const line = { primitiveId: "sdk-line", net, layer, startX, startY, endX, endY, lineWidth };
        lines.push(line);
        return line;
      });
      const result = await executePcbTrackViaMutation(
        () => ({ pcb_PrimitiveLine: { getAll: async () => lines, create } }),
        {
          entity: "track",
          action: "create",
          net: "GND",
          layer: 1,
          startX: 10,
          startY: 20,
          endX: 100,
          endY: 20,
          lineWidth: 10
        }
      );
      expect(create).toHaveBeenCalledWith("GND", 1, 10, 20, 100, 20, 10);
      expect(result.readback.primitiveId).toBe("sdk-line");
    });
    it("executes track create and verifies readback", async () => {
      const createdTrack = {
        getState_PrimitiveId: () => "trk-created-1",
        getState_Net: () => "GND",
        getState_Layer: () => 1,
        getState_LineWidth: () => 0.254,
        getState_StartX: () => 0,
        getState_StartY: () => 0,
        getState_EndX: () => 10,
        getState_EndY: () => 0
      };
      const api = createMockApi([mockTrack1, mockTrack2, createdTrack]);

      const res = await executePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "create",
        net: "GND",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        lineWidth: 0.254
      });

      expect(res.executed).toBe(true);
      expect(res.readback.primitiveId).toBe("trk-created-1");
    });

    it("executes track modify and verifies readback", async () => {
      const modifiedTrack = {
        getState_PrimitiveId: () => "trk-1",
        getState_Net: () => "GND",
        getState_Layer: () => 1,
        getState_LineWidth: () => 0.5,
        getState_StartX: () => 10,
        getState_StartY: () => 10,
        getState_EndX: () => 30,
        getState_EndY: () => 10
      };
      const api = createMockApi([modifiedTrack, mockTrack2]);

      const res = await executePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "modify",
        trackId: "trk-1",
        properties: { lineWidth: 0.5 }
      });

      expect(res.executed).toBe(true);
      expect((res.readback.track as any).lineWidth).toBe(0.5);
    });

    it("executes track delete and verifies removal on readback", async () => {
      // api returning only mockTrack2 (mockTrack1 deleted)
      const api = createMockApi([mockTrack2]);

      const res = await executePcbTrackViaMutation(() => api, {
        entity: "track",
        action: "delete",
        trackId: "trk-1"
      });

      expect(res.executed).toBe(true);
      expect(res.readback.deleted).toBe(true);
    });

    it("executes via create, modify and delete with readback", async () => {
      const createdVia = {
        getState_PrimitiveId: () => "via-created-1",
        getState_Net: () => "VCC",
        getState_X: () => 50,
        getState_Y: () => 50,
        getState_Diameter: () => 0.8,
        getState_HoleDiameter: () => 0.4
      };
      const api = createMockApi([], [createdVia]);

      const createRes = await executePcbTrackViaMutation(() => api, {
        entity: "via",
        action: "create",
        net: "VCC",
        x: 50,
        y: 50,
        diameter: 0.8,
        holeDiameter: 0.4
      });
      expect(createRes.executed).toBe(true);
      expect(createRes.readback.primitiveId).toBe("via-created-1");

      // Delete via
      const emptyApi = createMockApi([], []);
      const delRes = await executePcbTrackViaMutation(() => emptyApi, {
        entity: "via",
        action: "delete",
        viaId: "via-created-1"
      });
      expect(delRes.executed).toBe(true);
      expect(delRes.readback.deleted).toBe(true);
    });
  });
});
it("verifies native split segments by continuous collinear coverage rather than segment count", async () => {
  const create = vi.fn(async () => ({ primitiveId: "a" }));
  const segments = [
    { primitiveId: "a", net: "PUMP", layer: 1, startX: 0, startY: 0, endX: 5, endY: 0, lineWidth: 10 },
    { primitiveId: "b", net: "PUMP", layer: 1, startX: 5, startY: 0, endX: 10, endY: 0, lineWidth: 10 }
  ];
  const result = await executePcbTrackViaMutation(
    () => ({ pcb_PrimitiveLine: { create, getAll: async () => segments } }),
    { entity: "track", action: "create", net: "PUMP", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 10 }
  );
  expect(result.executed).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
});
it("rejects a width mismatch on independent track readback without retrying creation", async () => {
  const create = vi.fn(async () => ({ primitiveId: "a" }));
  await expect(
    executePcbTrackViaMutation(
      () => ({
        pcb_PrimitiveLine: {
          create,
          getAll: async () => [
            { primitiveId: "a", net: "PUMP", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 5 }
          ]
        }
      }),
      {
        entity: "track",
        action: "create",
        net: "PUMP",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        lineWidth: 10
      }
    )
  ).rejects.toThrow(/mismatch/);
  expect(create).toHaveBeenCalledTimes(1);
});

it("verifies a newly appended track beyond 500 existing same-net native tracks", async () => {
  const tracks = Array.from({ length: 679 }, (_, i) => ({
    primitiveId: `old${i}`,
    net: "GND",
    layer: 1,
    startX: i,
    startY: 100,
    endX: i + 1,
    endY: 100,
    lineWidth: 6
  }));
  const create = vi.fn(async (net, layer, startX, startY, endX, endY, lineWidth) => {
    tracks.push({ primitiveId: "new-track", net, layer, startX, startY, endX, endY, lineWidth });
    return "new-track";
  });
  const result = await executePcbTrackViaMutation(
    () => ({ pcb_PrimitiveLine: { getAll: async () => tracks, create } }),
    { entity: "track", action: "create", net: "GND", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 6 }
  );
  expect(result.readback.primitiveId).toBe("new-track");
  expect(create).toHaveBeenCalledTimes(1);
});

it("accepts native merged/split coverage when returned track ID no longer exists", async () => {
  const create = vi.fn(async () => ({ primitiveId: "retired-by-native-merge" }));
  const tracks = [
    { primitiveId: "merged1", net: "GND", layer: 1, startX: -2, startY: 0, endX: 5, endY: 0, lineWidth: 6 },
    { primitiveId: "merged2", net: "GND", layer: 1, startX: 5, startY: 0, endX: 12, endY: 0, lineWidth: 6 }
  ];
  const result = await executePcbTrackViaMutation(
    () => ({ pcb_PrimitiveLine: { create, getAll: async () => tracks } }),
    { entity: "track", action: "create", net: "GND", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 6 }
  );
  expect(result.readback).toMatchObject({
    returnedId: "retired-by-native-merge",
    returnedIdFound: false,
    geometryVerified: true,
    matchedIDs: ["merged1", "merged2"]
  });
  expect(result.readback.primitiveId).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1);
});
it("polls delayed native track inventory without repeating create", async () => {
  vi.useFakeTimers();
  try {
    const tracks: any[] = [];
    const create = vi.fn(async () => {
      setTimeout(
        () =>
          tracks.push({
            primitiveId: "new",
            net: "GND",
            layer: 1,
            startX: 0,
            startY: 0,
            endX: 10,
            endY: 0,
            lineWidth: 6
          }),
        500
      );
      return "new";
    });
    const execution = executePcbTrackViaMutation(
      () => ({ pcb_PrimitiveLine: { create, getAll: async () => tracks } }),
      { entity: "track", action: "create", net: "GND", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 6 }
    );
    const assertion = expect(execution).resolves.toMatchObject({
      readback: { returnedIdFound: true, geometryVerified: true }
    });
    await vi.advanceTimersByTimeAsync(700);
    await assertion;
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("settles post-create lookup failure as unknown with mutationId and native diagnostics", async () => {
  const doc = { uuid: "pcb-id-failure", parentProjectUuid: "project", documentType: 3 };
  const create = vi.fn(async () => "returned-not-observed");
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
    pcb_PrimitiveLine: { create, getAll: async () => [] }
  });
  const prepared: any = await preparePcbTrackViaMutation(api, {
    entity: "track",
    action: "create",
    net: "GND",
    layer: 1,
    startX: 0,
    startY: 0,
    endX: 10,
    endY: 0,
    lineWidth: 6
  });
  const handlers = createActionHandlers(api, new DrcRules(api));
  vi.useFakeTimers();
  try {
    const execution = handlers.confirmedAction({
      action: "mutation",
      confirmation: prepared.confirmation,
      params: { mutationId: prepared.mutationId }
    });
    await vi.advanceTimersByTimeAsync(3100);
    const record: any = await execution;
    expect(record.status).toBe("unknown");
    expect(record.mutationId).toBe(prepared.mutationId);
    expect(record.error).toContain("returned-not-observed");
    expect(record.error).toContain("pollCount");
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("verifies requested copper width covered by wider quantized native segments", () => {
  const m = (x: number) => x / 0.0254;
  const expected = {
    net: "GND",
    layer: 1,
    startX: m(35.39998),
    startY: m(17.6),
    endX: m(35.39998),
    endY: m(16.90116),
    lineWidth: m(0.15)
  };
  const track = (primitiveId: string, x: number, y: number, x2: number, y2: number, w: number) => ({
    primitiveId,
    net: "GND",
    layer: 1,
    startX: m(x),
    startY: m(y),
    endX: m(x2),
    endY: m(y2),
    lineWidth: m(w),
    length: 1
  });
  const actual = [
    track("created", 35.39998, 17.6, 35.39998, 17.2901146, 0.15),
    track("wide", 35.4001292, 16.8999662, 35.4001292, 17.2899654, 0.18)
  ];
  expect(assertTrackCoverage(actual, expected)).toEqual(expect.arrayContaining(["created", "wide"]));
  expect(() =>
    assertTrackCoverage(
      actual.map((t) => ({ ...t, net: "OTHER" })),
      expected
    )
  ).toThrow();
  expect(() =>
    assertTrackCoverage(
      actual.map((t) => ({ ...t, layer: 2 })),
      expected
    )
  ).toThrow();
  expect(() =>
    assertTrackCoverage(
      actual.map((t) => ({ ...t, startX: t.startX + m(0.02), endX: t.endX + m(0.02) })),
      expected
    )
  ).toThrow();
  expect(() =>
    assertTrackCoverage(
      actual.map((t) => ({ ...t, lineWidth: m(0.149) })),
      expected
    )
  ).toThrow();
});
it("verifies exact expected width modification after native ID replacement and splitting", async () => {
  const original = {
    primitiveId: "old",
    net: "USB_VBUS",
    layer: 1,
    startX: 1472.453748,
    startY: 271.420667,
    endX: 1472.453748,
    endY: 345.184274,
    lineWidth: 0.7258 / 0.0254,
    length: 73.7
  };
  let tracks = [original];
  const modify = vi.fn(async () => {
    tracks = [
      { ...original, primitiveId: "split1", endY: 330.719811, lineWidth: 0.65 / 0.0254 },
      { ...original, primitiveId: "split2", startY: 330.719811, lineWidth: 0.65 / 0.0254 }
    ];
    return tracks[0];
  });
  const result = await executePcbTrackViaMutation(
    () => ({ pcb_PrimitiveLine: { getAll: async () => tracks, modify } }),
    { entity: "track", action: "modify", trackId: "old", properties: { lineWidth: 0.65 / 0.0254 } },
    original
  );
  expect(modify).toHaveBeenCalledTimes(1);
  expect(result.readback).toMatchObject({
    originalIdFound: false,
    geometryVerified: true,
    matchedIDs: ["split1", "split2"]
  });
  expect(result.readback.primitiveId).toBeUndefined();
});

it.each(["unchanged-width", "wrong-net", "adjacent"])(
  "keeps modify %s outcome unknown without repeating the write",
  async (kind) => {
    const old = {
      primitiveId: "old",
      net: "GND",
      layer: 1,
      startX: 0,
      startY: 0,
      endX: 10,
      endY: 0,
      lineWidth: 10,
      length: 10
    };
    let tracks = [old];
    const modify = vi.fn(async () => {
      tracks = [
        {
          ...old,
          primitiveId: "replacement",
          lineWidth: kind === "unchanged-width" ? 10 : 6,
          net: kind === "wrong-net" ? "OTHER" : "GND",
          startY: kind === "adjacent" ? 0.1 : 0,
          endY: kind === "adjacent" ? 0.1 : 0
        }
      ];
      return tracks[0];
    });
    vi.useFakeTimers();
    try {
      const execution = executePcbTrackViaMutation(
        () => ({ pcb_PrimitiveLine: { getAll: async () => tracks, modify } }),
        { entity: "track", action: "modify", trackId: "old", properties: { lineWidth: 6 } },
        old
      );
      const assertion = expect(execution).rejects.toMatchObject({ code: "write_readback_unknown" });
      await vi.advanceTimersByTimeAsync(3100);
      await assertion;
      expect(modify).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }
);
