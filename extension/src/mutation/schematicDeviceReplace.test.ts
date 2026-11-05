import { beforeEach, expect, it, vi } from "vitest";
import { prepareSchematicDeviceReplace, executeSchematicDeviceReplace } from "./schematicDeviceReplace.js";
import { extensionMutations } from "./mutationManager.js";
const identity = { projectId: "project", schematicName: "Main", pageName: "CONTROL" };
const params = { sourceIdentity: identity, primitiveId: "old", libraryUuid: "1".repeat(32), name: "S3B-PH-K-S" };
function fixture() {
  let active = "page",
    device = "old-device",
    net = "GND",
    uniqueId = "binding";
  const ref = { libraryUuid: params.libraryUuid, uuid: "2".repeat(32) };
  const footprint = { libraryUuid: params.libraryUuid, uuid: "3".repeat(32) };
  const catalog = {
    ...ref,
    name: params.name,
    footprint,
    model3D: { libraryUuid: params.libraryUuid, uuid: "4".repeat(32) }
  };
  const replace = vi.fn(async () => {
    device = ref.uuid;
    return { ok: true, value: { primitiveId: "old", designator: "J1" } };
  });
  const eda = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: active, parentProjectUuid: "project", documentType: 1 })
    },
    dmt_Schematic: {
      getCurrentSchematicInfo: async () => ({ uuid: "sch", name: "Main" }),
      getSchematicPageInfo: async () => ({ uuid: active, parentSchematicUuid: "sch", name: "CONTROL" })
    },
    lib_Device: { search: vi.fn(async () => [catalog]), get: vi.fn(async () => catalog) },
    sch_SourcePrimitiveComponent: {
      replace,
      get: vi.fn(async () => ({
        ok: true,
        value: {
          primitiveId: "old",
          designator: "J1",
          x: 10,
          y: 20,
          rotation: 0,
          mirror: false,
          subPartName: "",
          properties: { Device: device },
          pins: [{ pinId: "pin1", pinNumber: "1", pinName: "P1", x: 10, y: 20 }]
        }
      }))
    },
    sch_SourceNet: { getConnections: vi.fn(async () => ({ ok: true, value: { net, connections: [] } })) },
    sch_PrimitiveComponent: {
      get: vi.fn(async () => ({
        getState_PrimitiveId: () => "old",
        getState_UniqueId: () => uniqueId,
        getState_Component: () => ({ libraryUuid: params.libraryUuid, uuid: device }),
        getState_Footprint: () =>
          device === ref.uuid ? footprint : { libraryUuid: params.libraryUuid, uuid: "old-footprint" }
      }))
    }
  };
  return {
    eda,
    replace,
    setNet: (v: string) => {
      net = v;
    },
    setUnique: (v: string) => {
      uniqueId = v;
    },
    setActive: (v: string) => {
      active = v;
    }
  };
}
beforeEach(() => extensionMutations.invalidateAll());
it("prepares without invoking replace and executes only the exact official argument object", async () => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  expect(f.replace).not.toHaveBeenCalled();
  const result = await executeSchematicDeviceReplace(() => f.eda, extensionMutations.get(p.mutationId));
  expect(f.replace).toHaveBeenCalledExactlyOnceWith({
    ...identity,
    primitiveId: "old",
    libraryUuid: params.libraryUuid,
    name: params.name
  });
  expect(result.readback).toMatchObject({
    schematicVerified: true,
    verified: false,
    pcbUpdated: false,
    modelGeometryVerified: false,
    pinNetMap: [{ pinNumber: "1", net: "GND" }]
  });
});
it("rejects wrong project and missing independent net getter before any replace", async () => {
  const f = fixture();
  await expect(
    prepareSchematicDeviceReplace(() => f.eda, { ...params, sourceIdentity: { ...identity, projectId: "other" } })
  ).rejects.toThrow();
  delete (f.eda as any).sch_SourceNet;
  await expect(prepareSchematicDeviceReplace(() => f.eda, params)).rejects.toThrow(/capability|net/i);
  expect(f.replace).not.toHaveBeenCalled();
});
it("reports native tolerance rejection without verified success or another replace", async () => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  f.replace.mockImplementation(
    async () => ({ ok: false, error: { code: "REPLACE_REJECTED", message: "pin tolerance" } }) as any
  );
  await expect(executeSchematicDeviceReplace(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
    code: "native_replace_rejected"
  });
  expect(f.replace).toHaveBeenCalledTimes(1);
});
it.each(["net", "uniqueId"])("marks changed %s unknown after one native replace", async (kind) => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  const original = f.replace.getMockImplementation()!;
  f.replace.mockImplementation(async () => {
    const result = await original();
    if (kind === "net") f.setNet("OTHER");
    else f.setUnique("broken");
    return result;
  });
  await expect(executeSchematicDeviceReplace(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
    code: "write_readback_unknown"
  });
  expect(f.replace).toHaveBeenCalledTimes(1);
});
it("blocks changed target and stale pin net snapshot before dispatch", async () => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  f.setNet("changed");
  await expect(executeSchematicDeviceReplace(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(
    /stale|changed/i
  );
  expect(f.replace).not.toHaveBeenCalled();
  f.setActive("other");
  await expect(executeSchematicDeviceReplace(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow();
  expect(f.replace).not.toHaveBeenCalled();
});

it("uses lifecycle exact confirmation and never repeats a native void/unknown replacement", async () => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const handlers = createActionHandlers(() => f.eda, {} as any);
  await expect(
    handlers.confirmedAction({ action: "mutation", confirmation: "CONFIRM", params: { mutationId: p.mutationId } })
  ).rejects.toThrow();
  expect(f.replace).not.toHaveBeenCalled();
  f.replace.mockImplementation(async () => undefined as any);
  const apply = { action: "mutation", confirmation: p.confirmation, params: { mutationId: p.mutationId } };
  const result: any = await handlers.confirmedAction(apply);
  expect(result.status).toBe("unknown");
  expect(result.mutationId).toBe(p.mutationId);
  try {
    await handlers.confirmedAction(apply);
  } catch {
    /* Unknown is consumed, never replayed. */
  }
  expect(f.replace).toHaveBeenCalledTimes(1);
});
it("keeps documented tolerance rejection failed rather than applied in the lifecycle", async () => {
  const f = fixture(),
    p: any = await prepareSchematicDeviceReplace(() => f.eda, params);
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const handlers = createActionHandlers(() => f.eda, {} as any);
  f.replace.mockImplementation(
    async () => ({ ok: false, error: { code: "REPLACE_REJECTED", message: "pin tolerance" } }) as any
  );
  await expect(
    handlers.confirmedAction({ action: "mutation", confirmation: p.confirmation, params: { mutationId: p.mutationId } })
  ).rejects.toMatchObject({ code: "native_replace_rejected" });
  expect(extensionMutations.get(p.mutationId).status).toBe("failed");
  expect(f.replace).toHaveBeenCalledTimes(1);
});
it("requires exact active source page and unambiguous catalog name", async () => {
  const f = fixture();
  await expect(
    prepareSchematicDeviceReplace(() => f.eda, { ...params, sourceIdentity: { ...identity, pageName: "POWER" } })
  ).rejects.toThrow(/source|page/i);
  const matches = await f.eda.lib_Device.search();
  f.eda.lib_Device.search.mockResolvedValue([...matches, ...matches]);
  await expect(prepareSchematicDeviceReplace(() => f.eda, params)).rejects.toThrow(/one catalog|resolve/i);
  expect(f.replace).not.toHaveBeenCalled();
});

it("names a stalled prepare source getter, bounds it to 5s and starts no later calls even after late resolution", async () => {
  const f = fixture();
  let resolve!: (value: any) => void;
  f.eda.sch_SourcePrimitiveComponent.get.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  vi.useFakeTimers();
  try {
    const execution = prepareSchematicDeviceReplace(() => f.eda, params);
    const assertion = expect(execution).rejects.toMatchObject({
      code: "native_observation_timeout",
      details: {
        phase: "prepare",
        step: "sch_SourcePrimitiveComponent.get",
        callBudgetMs: 5000,
        writeDispatched: false,
        retryAllowed: false
      }
    });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveComponent.get).not.toHaveBeenCalled();
    expect(f.eda.lib_Device.search).not.toHaveBeenCalled();
    resolve({ ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(40000);
    expect(f.eda.sch_PrimitiveComponent.get).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("names failed native pin getters before any replace rather than hiding the API behind a generic error", async () => {
  const f = fixture();
  f.eda.sch_SourceNet.getConnections.mockRejectedValueOnce(new Error("unsupported backend"));
  await expect(prepareSchematicDeviceReplace(() => f.eda, params)).rejects.toMatchObject({
    code: "native_observation_failed",
    details: { phase: "prepare", step: "sch_SourceNet.getConnections pinNumber=1 pinId=pin1", writeDispatched: false }
  });
  expect(f.replace).not.toHaveBeenCalled();
});
