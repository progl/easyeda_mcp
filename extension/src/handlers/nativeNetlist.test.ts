import { collectSchematicSnapshot } from "./schematicHandlers.js";
import { describe, expect, it, vi } from "vitest";
import { collectNativeNetlist } from "./nativeNetlist.js";

describe("native netlist collection", () => {
  it("allows an explicitly longer read window without changing the 3-second default", async () => {
    vi.useFakeTimers();
    try {
      const eda = {
        sch_ManufactureData: {
          getNetlistFile: async () => {
            await new Promise((resolve) => setTimeout(resolve, 4000));
            return { text: async () => "(\nGND\nU1-1\n)" };
          }
        },
        sch_PrimitiveComponent: { getAll: async () => [{ componentType: "part", designator: "U1" }] }
      };
      const ordinary = collectNativeNetlist(eda, false);
      const extended = collectNativeNetlist(eda, true, 8000);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await ordinary).toMatchObject({ status: "error", read: { timeoutMs: 3000, timedOut: true } });
      expect(await extended).toMatchObject({
        status: "available",
        read: { timeoutMs: 8000, timedOut: false, attemptedFormats: ["Protel2"] }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unbounded native read timeout before calling the SDK", async () => {
    const getNetlistFile = vi.fn();
    await expect(collectNativeNetlist({ sch_ManufactureData: { getNetlistFile } }, false, 20001)).rejects.toThrow(
      /nativeNetlistTimeoutMs/
    );
    expect(getNetlistFile).not.toHaveBeenCalled();
  });

  it("reads the File in memory and detects duplicate references within the native export", async () => {
    const getNetlistFile = vi.fn(async () => ({
      size: 40,
      text: async () => "[\nU1\nDIP\n]\n[\nU1\nDIP\n]\n(\nGND\nU1-1\n)"
    }));
    const result = await collectNativeNetlist(
      {
        sch_ManufactureData: { getNetlistFile },
        sch_PrimitiveComponent: {
          getAll: async () => [
            { componentType: "part", designator: "U1" },
            { componentType: "part", designator: "U1" }
          ]
        }
      },
      false
    );
    expect(getNetlistFile).toHaveBeenCalledWith("mcp-native-connectivity", "Protel2");
    expect(result).toMatchObject({ status: "available", ambiguousDesignators: ["U1"] });
  });
  it("does not claim support when the API or returned File is unavailable", async () => {
    expect((await collectNativeNetlist({}, false)).status).toBe("unavailable");
    const getNetlistFile = vi.fn();
    expect((await collectNativeNetlist({ sch_ManufactureData: { getNetlistFile } }, true)).status).toBe("error");
    expect(getNetlistFile).toHaveBeenCalled();
  });
  it("reports a read failure without changing the editor", async () => {
    const result = await collectNativeNetlist(
      {
        sch_ManufactureData: {
          getNetlistFile: async () => {
            throw new Error("export failed");
          }
        }
      },
      false
    );
    expect(result).toMatchObject({ status: "error", reason: "export failed" });
  });
  it("integrates native membership into the current-page snapshot", async () => {
    const component = { primitiveId: "u", componentType: "part", designator: "U15" };
    const api = () => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "sheet", documentType: 1 }) },
      sch_PrimitiveComponent: {
        getAll: async () => [component],
        getAllPinsByPrimitiveId: async () => [{ pinNumber: "5", pinName: "V+" }]
      },
      sch_ManufactureData: { getNetlistFile: async () => ({ text: async () => "(\n3V3_LAB\nU15-5\n)" }) }
    });
    const snapshot = await collectSchematicSnapshot(api, { allPages: false, includeRaw: false });
    expect(snapshot.pins[0]).toMatchObject({ net: "3V3_LAB", netSource: "native_netlist" });
    expect(snapshot.nativeNetlist).toMatchObject({ status: "available", matchedPins: 1 });
  });

  it("bounds a hung native read and observes late rejection", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (error: Error) => void;
      const pending = collectNativeNetlist(
        {
          sch_ManufactureData: {
            getNetlistFile: () =>
              new Promise((_, fail) => {
                reject = fail;
              })
          }
        },
        false
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect((await pending).status).toBe("error");
      reject(new Error("late SDK rejection"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("uses only the active schematic native export when two boards reuse U4 with different nets", async () => {
  let selected = "lower";
  const exports = {
    lower: {
      components: { lowerU4: { props: { Designator: "U4" }, pinInfoMap: { "1": { number: "1", net: "LOWER_GND" } } } }
    },
    upper: {
      components: {
        upperU4: { props: { Designator: "U4" }, pinInfoMap: { "1": { number: "1", net: "UPPER_SENSOR" } } }
      }
    }
  };
  const getAll = vi.fn(async () => [
    { componentType: "part", designator: "U4" },
    { componentType: "part", designator: "U4" }
  ]);
  const eda = {
    dmt_Schematic: {
      getCurrentSchematicInfo: async () => ({ uuid: selected, name: selected, parentProjectUuid: "p" })
    },
    dmt_Board: {
      getCurrentBoardInfo: async () => ({
        name: selected.toUpperCase(),
        parentProjectUuid: "p",
        schematic: { uuid: selected }
      })
    },
    sch_PrimitiveComponent: { getAll },
    sch_ManufactureData: {
      getNetlistFile: async (_file: string, format: string) => {
        if (format === "Protel2") throw new Error("use exact native JSON");
        return { text: async () => JSON.stringify(exports[selected as keyof typeof exports]) };
      }
    }
  };
  const { applyNativeNetlist } = await import("../../../src/schematic/nativeNetlist.js");
  for (const key of ["lower", "upper"] as const) {
    selected = key;
    const data: any = await collectNativeNetlist(eda, false);
    expect(data.scope).toMatchObject({
      kind: "active_schematic",
      schematicUuid: key,
      boardName: key.toUpperCase(),
      verified: true
    });
    expect(data.ambiguousDesignators).toEqual([]);
    const mapped = applyNativeNetlist([{ componentDesignator: "U4", pinNumber: "1", position: {} }], data);
    expect(mapped.pins[0].net).toBe(key === "lower" ? "LOWER_GND" : "UPPER_SENSOR");
    expect(mapped.report.matchedPins).toBe(1);
  }
  expect(getAll).not.toHaveBeenCalled();
});
it("fails closed if the active schematic changes while the native export is being read", async () => {
  let selected = "lower";
  const result = await collectNativeNetlist(
    {
      dmt_Schematic: { getCurrentSchematicInfo: async () => ({ uuid: selected }) },
      sch_ManufactureData: {
        getNetlistFile: async () => ({
          text: async () => {
            selected = "upper";
            return "(\nGND\nU4-1\n)";
          }
        })
      }
    },
    false
  );
  expect(result.status).toBe("error");
  expect(result.reason).toMatch(/scope|schematic/i);
});

it("fails closed for allPages snapshots when no scoped page iterator exists instead of consuming project-global getAll(true)", async () => {
  const getAll = vi.fn(async () => [
    { primitiveId: "lowerU4", componentType: "part", designator: "U4" },
    { primitiveId: "upperU4", componentType: "part", designator: "U4" }
  ]);
  const eda = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "lower-page", parentProjectUuid: "p", documentType: 1 })
    },
    dmt_Board: { getAllBoardsInfo: async () => [{ name: "LOWER" }, { name: "UPPER" }] },
    sch_PrimitiveComponent: { getAll },
    sch_ManufactureData: { getNetlistFile: vi.fn() }
  };
  await expect(collectSchematicSnapshot(() => eda, { allPages: true, includeRaw: false })).rejects.toMatchObject({
    code: "scope_unsupported"
  });
  expect(getAll).not.toHaveBeenCalled();
  expect(eda.sch_ManufactureData.getNetlistFile).not.toHaveBeenCalled();
});
