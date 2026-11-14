import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executePcbLayoutMutation,
  executePcbRoutingMutation,
  fetchLayoutSummary,
  fetchRoutingSummary,
  preparePcbLayoutMutation,
  preparePcbRoutingMutation
} from "./pcbRoutingMutations.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";

describe("PCB Native Layout & Routing Mutations", () => {
  beforeEach(() => {
    extensionMutations.invalidateAll();
  });

  describe("fetchRoutingSummary", () => {
    it("does not treat undocumented net metadata as independent connectivity proof", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            name: "Board.PcbDoc",
            documentType: 3
          }))
        },
        pcb_Net: {
          getAllNetsName: vi.fn(async () => ["GND", "VCC", "SDA", "SCL"]),
          getAllNets: vi.fn(async () => [
            { name: "GND", isRouted: true },
            { name: "VCC", isRouted: true },
            { name: "SDA", isRouted: false, unroutedCount: 2 },
            { name: "SCL", isRouted: false, unroutedCount: 1 }
          ])
        }
      });

      const summary = await fetchRoutingSummary(api);
      expect(summary.totalNets).toBe(4);
      expect(summary.routedNets).toBeNull();
      expect(summary.unroutedNets).toBeNull();
      expect(summary.completionPercent).toBeNull();
      expect(summary.unroutedNetNames).toBeNull();
    });
  });

  describe("fetchLayoutSummary", () => {
    it("extracts component coordinates and count", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_PrimitiveComponent: {
          getAll: vi.fn(async () => [
            { primitiveId: "c1", designator: "U1", x: 20, y: 30, layer: 1, locked: false },
            { primitiveId: "c2", designator: "R1", x: 40, y: 50, layer: 1, locked: true }
          ])
        }
      });

      const summary = await fetchLayoutSummary(api);
      expect(summary.totalComponents).toBe(2);
      expect(summary.components).toHaveLength(2);
      expect(summary.components[0]).toMatchObject({
        primitiveId: "c1",
        designator: "U1",
        x: 20,
        y: 30
      });
    });
  });

  describe("preparePcbRoutingMutation", () => {
    const mockPcbApi = (routedCount = 2) => {
      return () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_Net: {
          getAllNetsName: vi.fn(async () => ["GND", "VCC", "SDA", "SCL"]),
          getAllNets: vi.fn(async () => [
            { name: "GND", isRouted: routedCount >= 1 },
            { name: "VCC", isRouted: routedCount >= 2 },
            { name: "SDA", isRouted: routedCount >= 3 },
            { name: "SCL", isRouted: routedCount >= 4 }
          ])
        }
      });
    };

    it("prepares autoroute mutation with confirmation token", async () => {
      const api = mockPcbApi();
      const prepared = (await preparePcbRoutingMutation(api, {
        action: "autoroute",
        nets: ["SDA", "SCL"],
        keepExistingRoutes: true
      })) as Record<string, any>;

      expect(prepared.mutationId).toBeDefined();
      expect(prepared.confirmation).toBe(`CONFIRM pcb:autoroute ${prepared.mutationId}`);
      expect(prepared.action).toBe("autoroute");
      expect(prepared.preview).toMatchObject({
        before: { totalNets: 4, routedNets: null, unroutedNets: null },
        requestedAfter: { action: "autoroute", targetNets: ["SDA", "SCL"], keepExistingRoutes: true },
        changedKeys: ["routing", "routedNets", "completionPercent"]
      });
    });

    it("rejects implicit unroute before dispatch", async () => {
      const api = vi.fn(() => {
        throw new Error("must not invoke native API");
      });
      await expect(preparePcbRoutingMutation(api, { action: "unroute", nets: ["GND"] })).rejects.toThrow(/explicit/i);
      expect(api).not.toHaveBeenCalled();
    });

    it("rejects non-PCB document targets", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-1",
            documentType: 1
          }))
        }
      });

      await expect(preparePcbRoutingMutation(api, { action: "autoroute" })).rejects.toThrow(
        /PCB routing operations require an active PCB document/
      );
    });
  });

  describe("executePcbRoutingMutation", () => {
    it("executes native autorouting and verifies readback", async () => {
      let isRouted = false;
      const autoRoutingMock = vi.fn(async () => {
        isRouted = true;
        return { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 10 };
      });

      const api = () => ({
        pcb_Document: {
          autoRouting: autoRoutingMock
        },
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_Net: {
          getAllNetsName: vi.fn(async () => ["GND", "VCC"]),
          getAllNets: vi.fn(async () => [
            { name: "GND", isRouted: true },
            { name: "VCC", isRouted }
          ])
        }
      });

      const result = await executePcbRoutingMutation(api, {
        action: "autoroute",
        nets: ["VCC"],
        keepExistingRoutes: true
      });

      expect(result.executed).toBe(true);
      expect(autoRoutingMock).toHaveBeenCalledWith(
        expect.objectContaining({
          RoutingNets: ["VCC"],
          existingPrimitiveMode: "keep"
        })
      );
      expect(result.readback).toMatchObject({
        method: "native",
        totalNets: 2,
        routedNets: null,
        completionPercent: null,
        nativeReportedSuccess: true,
        verified: false
      });
    });

    it("rejects direct implicit unroute without a prepared snapshot", async () => {
      const api = vi.fn(() => {
        throw new Error("must not invoke native API");
      });
      await expect(executePcbRoutingMutation(api, { action: "unroute", nets: ["GND"] })).rejects.toThrow(/explicit/i);
      expect(api).not.toHaveBeenCalled();
    });
  });

  describe("preparePcbLayoutMutation & executePcbLayoutMutation", () => {
    it("prepares and executes autolayout with readback verification", async () => {
      const autoLayoutMock = vi.fn(async () => true);

      const api = () => ({
        pcb_Document: {
          autoLayout: autoLayoutMock
        },
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_PrimitiveComponent: {
          getAll: vi.fn(async () => [{ primitiveId: "c1", designator: "U1", x: 10, y: 10, layer: 1 }])
        }
      });

      const prepared = (await preparePcbLayoutMutation(api, {
        action: "autolayout",
        components: ["U1"]
      })) as Record<string, any>;

      expect(prepared.mutationId).toBeDefined();
      expect(prepared.confirmation).toBe(`CONFIRM pcb:autolayout ${prepared.mutationId}`);
      expect(prepared.action).toBe("autolayout");

      const result = await executePcbLayoutMutation(api, {
        action: "autolayout",
        components: ["U1"]
      });

      expect(result.executed).toBe(true);
      expect(autoLayoutMock).toHaveBeenCalledWith({ components: ["U1"] });
      expect(result.readback).toMatchObject({
        method: "native",
        totalComponents: 1,
        arranged: true,
        verified: true
      });
    });
  });

  describe("Integration with actionHandlers", () => {
    it("distinguishes native autoroute from external file import", async () => {
      const importMock = vi.fn(async () => true);
      const nativeRouteMock = vi.fn(async () => true);

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_Document: {
          importAutoRouteJsonFile: importMock,
          autoRouting: nativeRouteMock
        },
        pcb_Net: {
          getAllNetsName: vi.fn(async () => ["GND"])
        }
      });

      const actionHandlers = createActionHandlers(api, new DrcRules(api));

      // 1. External import call with file
      const importResult = (await actionHandlers.confirmedAction({
        action: "autoroute",
        confirmation: "I confirm autoroute",
        params: { file: '{"routes":[]}' }
      })) as Record<string, any>;

      expect(importResult.method).toBe("external_import");
      expect(importMock).toHaveBeenCalledWith('{"routes":[]}');

      // 2. Native autoroute call without file
      await expect(
        actionHandlers.confirmedAction({ action: "nativeAutoRoute", confirmation: "I confirm nativeAutoRoute" })
      ).rejects.toThrow(/prepared|prepare/i);
      expect(nativeRouteMock).not.toHaveBeenCalled();
    });

    it("rejects net-based unroute preparation without explicit IDs", async () => {
      const api = vi.fn(() => {
        throw new Error("must not invoke native API");
      });
      await expect(preparePcbRoutingMutation(api, { action: "unroute", nets: ["GND"] })).rejects.toThrow(/explicit/i);
      expect(api).not.toHaveBeenCalled();
    });
  });
});

it("does not claim all nets routed from names, lengths, or empty net metadata", async () => {
  for (const nets of [undefined, [], [{ net: "GND", length: 400 }]]) {
    const report: any = await fetchRoutingSummary(() => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "p", documentType: 3 }) },
      pcb_Net: { getAllNetsName: async () => ["GND"], ...(nets ? { getAllNets: async () => nets } : {}) }
    }));
    expect(report).toMatchObject({
      totalNets: 1,
      routedNets: null,
      unroutedNets: null,
      completionPercent: null,
      verified: false,
      status: "inconclusive"
    });
  }
});
it("uses the real SDK receiver and maps RoutingNets/remove without unsupported aliases", async () => {
  const doc = {
    autoRouting: vi.fn(async function (this: any, _props: any) {
      expect(this).toBe(doc);
      return { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 1 };
    })
  };
  const r = await executePcbRoutingMutation(() => ({ pcb_Document: doc }), {
    action: "autoroute",
    nets: ["VCC"],
    ignoreNets: ["NC"],
    keepExistingRoutes: false
  });
  expect(doc.autoRouting).toHaveBeenCalledWith({
    RoutingNets: ["VCC"],
    ignoreNets: ["NC"],
    existingPrimitiveMode: "remove"
  });
  expect(r.readback).toMatchObject({ nativeReportedSuccess: true, verified: false, drcVerified: false });
});
it("does not verify native success:false or turn an invalid native result into success", async () => {
  const rejected = await executePcbRoutingMutation(
    () => ({
      pcb_Document: {
        autoRouting: async () => ({
          success: false,
          totalNetsCount: 1,
          successNetsCount: 0,
          failedNets: ["GND"],
          duration: 0
        })
      }
    }),
    { action: "autoroute" }
  );
  expect(rejected).toMatchObject({ executed: false, readback: { verified: false, nativeReportedSuccess: false } });
  await expect(
    executePcbRoutingMutation(() => ({ pcb_Document: { autoRouting: async () => undefined } }), { action: "autoroute" })
  ).rejects.toMatchObject({ code: "write_readback_unknown" });
});
it("rejects undocumented autoRoute-only capability before dispatch", async () => {
  const autoRoute = vi.fn();
  await expect(
    executePcbRoutingMutation(() => ({ pcb_Document: { autoRoute } }), { action: "autoroute" })
  ).rejects.toThrow(/autoRouting/);
  expect(autoRoute).not.toHaveBeenCalled();
});
it("observes a long native task after the unchanged lifecycle deadline, without replaying or claiming native job control", async () => {
  vi.useFakeTimers();
  let settle!: (value: any) => void;
  const pending = new Promise<any>((resolve) => {
    settle = resolve;
  });
  const autoRouting = vi.fn(() => pending);
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "p", documentType: 3 }) },
    pcb_Document: { autoRouting, startAutoRouting: vi.fn(), getAutoJobStatus: vi.fn() },
    pcb_Net: { getAllNetsName: async () => ["GND"] }
  });
  const handlers = createActionHandlers(api, new DrcRules(api));
  let apply: Promise<any> | undefined;
  try {
    const prepared: any = await preparePcbRoutingMutation(api, { action: "autoroute", nets: ["GND"] });
    apply = handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: prepared.mutationId },
      confirmation: prepared.confirmation
    }) as Promise<any>;
    await vi.advanceTimersByTimeAsync(45001);
    const timed = await apply;
    expect(timed.status).toBe("unknown");
    expect(timed.execution.lockHeld).toBe(true);
    const running: any = handlers.getMutationResult({ mutationId: prepared.mutationId });
    expect(running.nativeTask).toMatchObject({ phase: "running", retryable: false, jobControl: "unsupported" });
    await expect(
      handlers.confirmedAction({
        action: "mutation",
        params: { mutationId: prepared.mutationId },
        confirmation: prepared.confirmation
      })
    ).rejects.toThrow();
    expect(autoRouting).toHaveBeenCalledTimes(1);
    settle({ success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 50000 });
    await vi.advanceTimersByTimeAsync(1);
    const finished: any = handlers.getMutationResult({ mutationId: prepared.mutationId });
    expect(finished.status).toBe("applied");
    expect(finished.nativeTask).toMatchObject({ phase: "settled", nativeReportedSuccess: true });
    expect(finished.after).toMatchObject({ verified: false, completionPercent: null });
    expect(autoRouting).toHaveBeenCalledTimes(1);
  } finally {
    settle?.({ success: false });
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
  }
});
it("settles native success:false as a failed mutation with observable non-retryable task evidence", async () => {
  const autoRouting = vi.fn(async () => ({
    success: false,
    totalNetsCount: 2,
    successNetsCount: 0,
    failedNets: ["VCC", "GND"],
    duration: 10
  }));
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "p", documentType: 3 }) },
    pcb_Document: { autoRouting }
  });
  const handlers = createActionHandlers(api, new DrcRules(api));
  const p: any = await preparePcbRoutingMutation(api, { action: "autoroute" });
  await expect(
    handlers.confirmedAction({ action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation })
  ).rejects.toMatchObject({ code: "write_unverified" });
  const result: any = handlers.getMutationResult({ mutationId: p.mutationId });
  expect(result.status).toBe("failed");
  expect(result.nativeTask).toMatchObject({
    phase: "settled",
    nativeReportedSuccess: false,
    completionVerified: false,
    drcVerified: false,
    retryable: false,
    reported: { totalNetsCount: 2, successNetsCount: 0, failedNets: ["VCC", "GND"] }
  });
  expect(autoRouting).toHaveBeenCalledTimes(1);
});

describe("default autoroute exclusions retain complete net metadata", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  function nativeFixture() {
    const names = ["GND", "SIGNAL"];
    const pads = [
      { primitiveId: "p1", net: "PAD_ONLY" },
      { primitiveId: "p2", net: "GND2" },
      { primitiveId: "p3", net: "SIGNAL" }
    ];
    const tracks = [{ primitiveId: "line1", net: "TRACK_ONLY" }];
    const vias = [{ primitiveId: "via1", net: "VIA_ONLY" }];
    const eda: any = {
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ uuid: "pcb", parentProjectUuid: "project", documentType: 3 })
      },
      pcb_Net: { getAllNetsName: async () => names },
      pcb_PrimitiveComponent: {
        getAll: async () => [{ primitiveId: "c1" }],
        getAllPinsByPrimitiveId: async () => pads
      },
      pcb_PrimitiveLine: { getAll: async () => tracks },
      pcb_PrimitiveVia: { getAll: async () => vias },
      pcb_Document: { autoRouting: vi.fn(async () => ({ success: true })) }
    };
    return { api: () => eda, eda, names, pads, tracks, vias };
  }
  const excluded = { action: "autoroute", ignoreNets: ["GND", "GND2"], keepExistingRoutes: true };
  const allNames = ["GND", "GND2", "PAD_ONLY", "SIGNAL", "TRACK_ONLY", "VIA_ONLY"];
  it("materializes the native union while previewing the effective routing selection separately", async () => {
    const f = nativeFixture();
    const p: any = await preparePcbRoutingMutation(f.api, excluded);
    const record: any = extensionMutations.get(p.mutationId);
    expect(record.operation.nets).toEqual(allNames);
    expect(record.before.routingNetContext).toMatchObject({
      scope: "net_membership_only",
      allNetNames: allNames,
      counts: { components: 1, pads: 3, tracks: 1, vias: 1 }
    });
    expect(p.preview.requestedAfter).toMatchObject({
      targetNets: ["PAD_ONLY", "SIGNAL", "TRACK_ONLY", "VIA_ONLY"],
      sdkRoutingNets: allNames,
      routingContext: { mode: "materialized_default", geometryVerified: false }
    });
    await executePcbRoutingMutation(f.api, { ...record.operation, target: record.target }, record.before);
    expect(f.eda.pcb_Document.autoRouting).toHaveBeenCalledExactlyOnceWith({
      RoutingNets: allNames,
      ignoreNets: ["GND", "GND2"],
      existingPrimitiveMode: "keep"
    });
  });
  it.each(["names", "pads", "tracks", "vias"] as const)(
    "refuses changed %s membership before the one native write, even when counts are unchanged",
    async (kind) => {
      const f = nativeFixture();
      const p: any = await preparePcbRoutingMutation(f.api, excluded);
      const record: any = extensionMutations.get(p.mutationId);
      if (kind === "names") f.names[0] = "RENAMED";
      else f[kind][0].net = "RENAMED";
      await expect(
        executePcbRoutingMutation(f.api, { ...record.operation, target: record.target }, record.before)
      ).rejects.toMatchObject({ code: "stale_routing_context" });
      expect(f.eda.pcb_Document.autoRouting).not.toHaveBeenCalled();
    }
  );
  it("refuses incomplete native component-pad enumeration before preparing an unsafe fallback", async () => {
    const f = nativeFixture();
    delete f.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
    await expect(preparePcbRoutingMutation(f.api, excluded)).rejects.toMatchObject({
      code: "routing_context_unavailable"
    });
    expect(f.eda.pcb_Document.autoRouting).not.toHaveBeenCalled();
  });
  it("does not reinterpret an explicit subset and warns that native metadata completeness is unverified", async () => {
    const f = nativeFixture();
    const p: any = await preparePcbRoutingMutation(f.api, { ...excluded, nets: ["SIGNAL"] });
    expect(extensionMutations.get(p.mutationId).operation.nets).toEqual(["SIGNAL"]);
    expect(p.preview.requestedAfter.routingContext).toMatchObject({
      mode: "caller_explicit_selection",
      metadataCompleteness: "not_verified"
    });
    expect(p.preview.requestedAfter.routingContext.warnings.join(" ")).toMatch(/metadata/i);
  });
  it("refuses an excluded default without its prepared membership proof", async () => {
    const f = nativeFixture();
    await expect(executePcbRoutingMutation(f.api, excluded)).rejects.toMatchObject({
      code: "prepared_routing_context_required"
    });
    expect(f.eda.pcb_Document.autoRouting).not.toHaveBeenCalled();
  });
  it("never dispatches after a timed-out native context read eventually resolves", async () => {
    const f = nativeFixture();
    const p: any = await preparePcbRoutingMutation(f.api, excluded);
    const record: any = extensionMutations.get(p.mutationId);
    vi.useFakeTimers();
    try {
      let finish!: (value: any) => void;
      f.eda.pcb_PrimitiveComponent.getAll = () => new Promise((resolve) => (finish = resolve));
      const execute = executePcbRoutingMutation(f.api, { ...record.operation, target: record.target }, record.before);
      const check = expect(execute).rejects.toMatchObject({ code: "routing_context_unavailable" });
      await vi.advanceTimersByTimeAsync(10001);
      await check;
      finish([{ primitiveId: "c1" }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.eda.pcb_Document.autoRouting).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a rejected native call unknown and never replays the materialized default", async () => {
    const f = nativeFixture();
    f.eda.pcb_Document.autoRouting.mockRejectedValue(new Error("RPC Call autoRouting Timed Out"));
    const p: any = await preparePcbRoutingMutation(f.api, excluded);
    const handlers = createActionHandlers(f.api, new DrcRules(f.api));
    const request = { action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation };
    const result = await handlers.confirmedAction(request);
    expect(result).toMatchObject({ status: "unknown" });
    await expect(handlers.confirmedAction(request)).rejects.toThrow();
    expect(f.eda.pcb_Document.autoRouting).toHaveBeenCalledTimes(1);
  });
});
