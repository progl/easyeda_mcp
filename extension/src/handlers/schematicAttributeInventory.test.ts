import { expect, it, vi } from "vitest";
import { getSchematicAttributeInventory } from "./schematicAttributeInventory.js";
const doc = { uuid: "page-1", documentType: 1, parentProjectUuid: "project-1" };
function attr(id: string, parent: string, key = "Name", x = 5) {
  const fields = {
    PrimitiveId: id,
    ParentPrimitiveId: parent,
    Key: key,
    Value: "GND",
    X: x,
    Y: 10,
    FontSize: 12,
    ValueVisible: true,
    KeyVisible: false
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [`getState_${k}`, () => v]));
}
function fixture() {
  const a = attr("a1", "w1");
  const getAll = vi.fn(async (parent?: string) => (parent === "w1" ? [a] : ([] as any[])));
  const eda: any = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
    sch_PrimitiveComponent: { getAll: vi.fn(async () => [{ getState_PrimitiveId: () => "c1" }]) },
    sch_PrimitiveWire: { getAll: vi.fn(async () => [{ getState_PrimitiveId: () => "w1" }]) },
    sch_PrimitiveAttribute: { getAll }
  };
  return { eda, getAll, a };
}
it("enumerates current component/wire parents and reports the empty global inventory discrepancy", async () => {
  const f = fixture();
  const r: any = await getSchematicAttributeInventory(() => f.eda, {});
  expect(f.eda.sch_PrimitiveComponent.getAll).toHaveBeenCalledWith(undefined, false);
  expect(r.attributes).toEqual([
    expect.objectContaining({ primitiveId: "a1", parentPrimitiveId: "w1", x: 5, fontSize: 12, valueVisible: true })
  ]);
  expect(r.counts).toMatchObject({ parents: 2, global: 0, fromParents: 1, unique: 1 });
  expect(r.warnings.join(" ")).toMatch(/global/i);
});
it("uses get(ids) only for proven empty/incomplete parent reads and records fallback provenance", async () => {
  const f = fixture();
  f.eda.sch_PrimitiveAttribute.getAll = async () => [];
  f.eda.sch_PrimitiveAttribute.getAllPrimitiveId = vi.fn(async () => ["a1"]);
  f.eda.sch_PrimitiveAttribute.get = vi.fn(async () => [f.a]);
  const r: any = await getSchematicAttributeInventory(() => f.eda, { parentIds: ["w1"] });
  expect(r.attributes).toHaveLength(1);
  expect(r.parents[0]).toMatchObject({ parentId: "w1", fallbackReason: "empty", fallbackUsed: true });
  expect(f.eda.sch_PrimitiveAttribute.get).toHaveBeenCalledWith(["a1"]);
  expect(f.eda.sch_PrimitiveComponent.getAll).not.toHaveBeenCalled();
});
it("does not invoke fallback for a nonempty parent list consistent with global enumeration", async () => {
  const f = fixture();
  f.eda.sch_PrimitiveAttribute.getAll = async () => [f.a];
  f.eda.sch_PrimitiveAttribute.getAllPrimitiveId = vi.fn();
  const r: any = await getSchematicAttributeInventory(() => f.eda, { parentIds: ["w1", "w1"] });
  expect(r.attributes).toHaveLength(1);
  expect(f.eda.sch_PrimitiveAttribute.getAllPrimitiveId).not.toHaveBeenCalled();
  expect(r.attributes[0].sources).toEqual(["global", "parent:w1"]);
});
it("uses actual getters, warns for wrong-parent results and blocks wrong targets", async () => {
  const f = fixture();
  (f.a as any).x = 999;
  const r: any = await getSchematicAttributeInventory(() => f.eda, { parentIds: ["c1"] });
  expect(r.attributes).toHaveLength(0);
  await expect(getSchematicAttributeInventory(() => f.eda, { target: { documentId: "other" } })).rejects.toThrow();
  await expect(getSchematicAttributeInventory(() => f.eda, { parentIds: [] })).rejects.toThrow();
});
it("recovers a parent list proven incomplete by global getter IDs", async () => {
  const f = fixture(),
    a2 = attr("a2", "w1");
  f.eda.sch_PrimitiveAttribute.getAll = async (parent?: string) => (parent ? [f.a] : [f.a, a2]);
  f.eda.sch_PrimitiveAttribute.getAllPrimitiveId = vi.fn(async () => ["a1", "a2"]);
  f.eda.sch_PrimitiveAttribute.get = vi.fn(async () => [a2]);
  const r: any = await getSchematicAttributeInventory(() => f.eda, { parentIds: ["w1"] });
  expect(f.eda.sch_PrimitiveAttribute.get).toHaveBeenCalledWith(["a2"]);
  expect(r.parents[0]).toMatchObject({ fallbackReason: "incomplete_vs_global", observedCount: 2, missingCount: 0 });
  expect(r.attributes).toHaveLength(2);
});
it("reports parent-mismatched native responses instead of accepting them as scoped attributes", async () => {
  const f = fixture();
  f.eda.sch_PrimitiveAttribute.getAll = async (parent?: string) => (parent ? [f.a] : []);
  const r: any = await getSchematicAttributeInventory(() => f.eda, { parentIds: ["c1"] });
  expect(r.attributes).toEqual([]);
  expect(r.warnings.join(" ")).toMatch(/another parent/);
});
it("preserves globally observed independent labels without inventing a parent", async () => {
  const f = fixture();
  const independent = { ...attr("free", ""), getState_ParentPrimitiveId: () => null };
  f.eda.sch_PrimitiveAttribute.getAll = async (parent?: string) => (parent ? [] : [independent]);
  const r: any = await getSchematicAttributeInventory(() => f.eda, {});
  expect(r.attributes).toEqual([expect.objectContaining({ primitiveId: "free", parentPrimitiveId: null })]);
});
