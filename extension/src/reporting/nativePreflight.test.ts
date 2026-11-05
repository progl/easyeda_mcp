import { beforeEach, expect, it, vi } from "vitest";
import { getNativePreflight } from "./nativePreflight.js";
import { extensionMutations } from "../mutation/mutationManager.js";
const doc = { uuid: "sch-1", documentType: 1, parentProjectUuid: "project-1" };
beforeEach(() => extensionMutations.invalidateAll());
it("does not execute native mutations or ERC by default and does not claim native queue drained", async () => {
  const modify = vi.fn(),
    check = vi.fn();
  const report: any = await getNativePreflight(
    () => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
      sch_PrimitiveWire: { modify },
      sch_SourceDrc: { check }
    }),
    {}
  );
  expect(modify).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  expect(report.pendingWrites.nativeQueue).toBe("unobservable");
  expect(report.methods.find((m: any) => m.api === "sch_PrimitiveWire")).toMatchObject({
    modify: true,
    referenceSemantics: "fire_and_forget_done",
    runtimeSemantics: "unverified"
  });
  expect(report.units.referenceClient.padHoleTupleToMil).toBe(10);
  expect(report.units.runtimePadHoleTuple).toBe("requires_verification");
});
it("returns actual source ERC warning elements through the public SDK identity contract", async () => {
  const identity = { projectId: "project-1", schematicName: "Main", pageName: "Sheet1" };
  const check = vi.fn(async () => ({
    ok: true,
    value: {
      passed: true,
      violations: [
        {
          rule: "UNCONNECTED_PIN",
          severity: "warning",
          message: "Floating",
          elements: [{ primitiveId: "C1", pinId: "2" }]
        }
      ]
    }
  }));
  const r: any = await getNativePreflight(
    () => ({ dmt_SelectControl: { getCurrentDocumentInfo: async () => doc }, sch_SourceDrc: { check } }),
    { includeSourceErc: true, sourceIdentity: identity }
  );
  expect(check).toHaveBeenCalledWith(identity);
  expect(r.sourceErc).toMatchObject({
    available: true,
    passed: true,
    warningsCount: 1,
    errorsCount: 0,
    violations: [{ elements: [{ primitiveId: "C1", pinId: "2" }] }]
  });
});
it("keeps unsupported ERC and malformed native results inconclusive", async () => {
  const r: any = await getNativePreflight(() => ({ dmt_SelectControl: { getCurrentDocumentInfo: async () => doc } }), {
    includeSourceErc: true,
    sourceIdentity: { projectId: "project-1", schematicName: "Main", pageName: "Sheet1" }
  });
  expect(r.sourceErc).toMatchObject({ available: false, status: "unavailable" });
  const bad: any = await getNativePreflight(
    () => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
      sch_SourceDrc: { check: async () => ({ ok: true, value: { passed: true } }) }
    }),
    { includeSourceErc: true, sourceIdentity: { projectId: "project-1", schematicName: "Main", pageName: "Sheet1" } }
  );
  expect(bad.sourceErc).toMatchObject({ status: "inconclusive", passed: null });
});
it("requires explicit source identity and rejects a mismatched target without checks", async () => {
  const check = vi.fn();
  const api = () => ({ dmt_SelectControl: { getCurrentDocumentInfo: async () => doc }, sch_SourceDrc: { check } });
  await expect(getNativePreflight(api, { includeSourceErc: true })).rejects.toThrow(/identity/i);
  await expect(getNativePreflight(api, { target: { documentId: "other" } })).rejects.toThrow();
  expect(check).not.toHaveBeenCalled();
});

it("reports optional replacement/library capabilities by presence without invoking any method", async () => {
  const replace = vi.fn(() => {
    throw new Error("must not replace");
  });
  const deviceGet = vi.fn(),
    footprintGet = vi.fn(),
    getDocumentSource = vi.fn();
  const result: any = await getNativePreflight(() => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
    sch_SourcePrimitiveComponent: { replace },
    lib_Device: { get: deviceGet },
    lib_Footprint: { get: footprintGet, getDocumentSource }
  }));
  expect(result.optionalCapabilities).toEqual({
    "sch_SourcePrimitiveComponent.replace": true,
    "lib_Device.get": true,
    "lib_Footprint.get": true,
    "lib_Footprint.getDocumentSource": true
  });
  for (const fn of [replace, deviceGet, footprintGet, getDocumentSource]) expect(fn).not.toHaveBeenCalled();
});
it("marks absent or non-function optional SDK members unavailable", async () => {
  const result: any = await getNativePreflight(() => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
    sch_SourcePrimitiveComponent: { replace: "unsupported" },
    lib_Device: {},
    lib_Footprint: { get: null }
  }));
  expect(Object.values(result.optionalCapabilities)).toEqual([false, false, false, false]);
  expect(result.readOnly).toBe(true);
});
