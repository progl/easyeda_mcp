import { describe, it, expect } from "vitest";
import { pageFixture } from "../mutation/schematicPageFixture.js";
import { auditSchematicConnectivity } from "./schematicConnectivity.js";
import { applyNativeNetlist } from "../../../src/schematic/nativeNetlist.js";
describe("native JSON and interpage connectivity", () => {
  const text = JSON.stringify({
    version: "2.0.0",
    components: {
      uid1: { props: { Designator: "R1" }, pinInfoMap: { "1": { number: "1", net: "GND" } } },
      uid2: { props: { Designator: "R2" }, pinInfoMap: { "1": { number: "1", net: "GND" } } }
    }
  });
  it("reads the documented EasyEDA JSON netlist without geometric inference", () => {
    const r = applyNativeNetlist([{ componentDesignator: "R1", pinNumber: "1", position: {} }], {
      status: "available",
      format: "EasyEDA",
      text
    });
    expect(r.pins[0]).toMatchObject({ net: "GND", netSource: "native_netlist" });
  });
  it("joins native members across pages, namespaces local IDs and restores focus", async () => {
    const f = pageFixture();
    f.components.p2.push({ ...f.components.p1[0], primitiveId: "c1", designator: "R2", uniqueId: "uid2" });
    f.eda.sch_ManufactureData = {
      getNetlistFile: async (_: string, type: string) => ({
        text: async () => (type === "EasyEDA" ? text : "unsupported export")
      })
    };
    const r = await auditSchematicConnectivity(f.api, {});
    expect(r.interpageNets[0]).toMatchObject({ net: "GND", pages: ["p1", "p2"] });
    expect(r.pins.map((p: any) => p.primitiveId)).toEqual(["p1:c1-1", "p2:c1-1"]);
    expect(r.nativeVerifiedPins).toBe(2);
    expect(f.active()).toBe("p1");
  });
  it("keeps absent native membership unknown and never treats it as disconnection", async () => {
    const f = pageFixture();
    const r = await auditSchematicConnectivity(f.api, {});
    expect(r.nativeVerifiedPins).toBe(0);
    expect(r.unknownPins).toBe(1);
    expect(r.interpageNets).toEqual([]);
    expect(f.active()).toBe("p1");
  });
});

import { collectSchematicSnapshot } from "./schematicHandlers.js";
it("does not infer cross-page connections from identical coordinates in a multi-page snapshot", async () => {
  const f = pageFixture();
  f.components.p2.push({ ...f.components.p1[0], primitiveId: "c1", designator: "R2", uniqueId: "uid2" });
  const s = await collectSchematicSnapshot(f.api, { allPages: true, includeRaw: false });
  expect(s.pins).toHaveLength(2);
  expect(s.pins.every((p) => !p.net)).toBe(true);
  expect(new Set(s.pins.map((p) => p.componentPrimitiveId)).size).toBe(2);
  expect(f.active()).toBe("p1");
});
