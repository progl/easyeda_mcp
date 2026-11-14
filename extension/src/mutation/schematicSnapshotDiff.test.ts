import { expect, it } from "vitest";
import { compareSchematicSnapshots } from "./schematicSnapshotDiff.js";
const fixture = () => ({
  context: { active: { pages: [{ uuid: "page" }] }, protectedBoard: { OtherProperty: { "@Update Time": "01:00:00" } } },
  components: [
    {
      PrimitiveId: "frame",
      ComponentType: "sheet",
      OtherProperty: { "@Update Date": "2026-11-05", "@Update Time": "01:00:00", Title: "Original" }
    },
    { PrimitiveId: "part", ComponentType: "part", OtherProperty: { "@Update Time": "01:00:00" } }
  ],
  wires: []
});
it("allows only exact derived keys on an existing sheet of current page and reports exact values", () => {
  const a = fixture(),
    b = structuredClone(a);
  b.components[0].OtherProperty["@Update Time"] = "02:00:00";
  const r = compareSchematicSnapshots(a, b, "page");
  expect(r.equal).toBe(true);
  expect(r.derivedMetadataDiffs).toEqual([
    {
      documentId: "page",
      primitiveId: "frame",
      componentType: "sheet",
      property: "OtherProperty.@Update Time",
      before: "01:00:00",
      after: "02:00:00"
    }
  ]);
  expect(b.components[0].OtherProperty["@Update Time"]).toBe("02:00:00");
});
it.each(["part", "other_property", "protected_board", "wrong_page"])("never ignores %s changes", (kind) => {
  const a = fixture(),
    b = structuredClone(a);
  if (kind === "part") b.components[1].OtherProperty["@Update Time"] = "02:00:00";
  else if (kind === "other_property") b.components[0].OtherProperty.Title = "Changed";
  else if (kind === "protected_board") b.context.protectedBoard.OtherProperty["@Update Time"] = "02:00:00";
  else b.components[0].OtherProperty["@Update Time"] = "02:00:00";
  const r = compareSchematicSnapshots(a, b, kind === "wrong_page" ? "other" : "page");
  expect(r.equal).toBe(false);
  expect(r.differences.length).toBeGreaterThan(0);
});
