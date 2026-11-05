import { expect, it } from "vitest";
import { buildNamedStubPlan } from "./schematicNamedStubPlan.js";
function fixture() {
  const snapshot: any = {
    components: [
      { PrimitiveId: "old", ComponentType: "part", X: 100, Y: 100, Rotation: 0, Mirror: false },
      { PrimitiveId: "new", ComponentType: "part", X: 1000, Y: 1000, Rotation: 0, Mirror: false }
    ],
    pins: [],
    wires: []
  };
  const selections: any[] = [];
  for (let i = 0; i < 4; i++) {
    const number = String(i + 1);
    snapshot.pins.push(
      {
        PrimitiveId: `old-${number}`,
        componentId: "old",
        pinNumber: number,
        net: `N${number}`,
        X: 125,
        Y: 130 - i * 20,
        Rotation: 0
      },
      {
        PrimitiveId: `new-${number}`,
        componentId: "new",
        pinNumber: number,
        net: "",
        X: 980,
        Y: 1015 - i * 10,
        Rotation: 180
      }
    );
    snapshot.wires.push({
      PrimitiveId: `w${number}`,
      Line: [125, 130 - i * 20, 150, 130 - i * 20],
      Net: `N${number}`,
      Color: null,
      LineWidth: null,
      LineType: null
    });
    selections.push({ pinNumber: number, wireId: `w${number}` });
  }
  return { snapshot, selections };
}
it("previews exact explicitly selected independent stubs by native pin numbers at final pose", () => {
  const f = fixture(),
    p = buildNamedStubPlan(f.snapshot, "old", "new", f.selections);
  expect(p.oldWireIds).toEqual(["w1", "w2", "w3", "w4"]);
  expect(p.stubs[0]).toMatchObject({
    pinNumber: "1",
    net: "N1",
    oldWireId: "w1",
    oldLine: [125, 130, 150, 130],
    newLine: [80, 115, 55, 115]
  });
  expect(p.stubs[3].newLine).toEqual([80, 85, 55, 85]);
});
it.each(["branch", "crossing", "other_pin", "wrong_net", "polyline", "missing_selection", "new_collision"])(
  "rejects unsafe %s without any CAD call",
  (kind) => {
    const f = fixture();
    if (kind === "branch") f.snapshot.wires.push({ PrimitiveId: "extra", Line: [150, 130, 175, 130], Net: "N1" });
    if (kind === "crossing") f.snapshot.wires.push({ PrimitiveId: "extra", Line: [140, 120, 140, 140], Net: "OTHER" });
    if (kind === "other_pin")
      f.snapshot.pins.push({
        PrimitiveId: "foreign-pin",
        componentId: "keep",
        pinNumber: "1",
        net: "N1",
        X: 150,
        Y: 130
      });
    if (kind === "wrong_net") f.snapshot.wires[0].Net = "WRONG";
    if (kind === "polyline") f.snapshot.wires[0].Line = [125, 130, 150, 130, 150, 150];
    if (kind === "missing_selection") f.selections.pop();
    if (kind === "new_collision")
      f.snapshot.wires.push({ PrimitiveId: "extra", Line: [60, 110, 60, 120], Net: "OTHER" });
    expect(() => buildNamedStubPlan(f.snapshot, "old", "new", f.selections)).toThrow();
  }
);
const reviewed = {
  mapping: [
    { oldPinNumber: "1", newPinNumber: "2" },
    { oldPinNumber: "2", newPinNumber: "1" }
  ],
  extraNCpins: [
    {
      pinNumber: "0",
      reviewedRole: "mechanical",
      evidence:
        "Reviewed PJ-063AH datasheet page2 MS tabs; source pads0; leave unconnected, no claim of metal isolation."
    }
  ]
};
function twoToThree() {
  const f = fixture();
  f.snapshot.pins = f.snapshot.pins.filter((p: any) => ["1", "2"].includes(p.pinNumber));
  f.snapshot.wires.splice(2);
  f.selections.splice(2);
  f.snapshot.pins.push({
    PrimitiveId: "new-0",
    componentId: "new",
    pinNumber: "0",
    net: "",
    X: 980,
    Y: 1050,
    Rotation: 180
  });
  return f;
}
it("maps explicit two electrical pins and leaves exact reviewed extra pin native NC", () => {
  const f = twoToThree();
  const plan = buildNamedStubPlan(f.snapshot, "old", "new", f.selections, reviewed);
  expect(plan.stubs[0]).toMatchObject({ oldPinNumber: "1", pinNumber: "2", net: "N1", newLine: [80, 105, 55, 105] });
  expect(plan.extraNCpins).toEqual([expect.objectContaining({ pinNumber: "0", net: "", X: 80, Y: 150 })]);
});
it.each([
  "noContract",
  "missingMapping",
  "duplicateTarget",
  "wrongExtra",
  "wiredExtra",
  "extraTouchesWire",
  "extraTouchesPin",
  "extraTouchesAnchor",
  "missingEvidence"
])("refuses unsafe2to3 %s", (kind) => {
  const f = twoToThree(),
    contract: any = structuredClone(reviewed);
  if (kind === "missingMapping") contract.mapping.pop();
  if (kind === "duplicateTarget") contract.mapping[1].newPinNumber = "2";
  if (kind === "wrongExtra") contract.extraNCpins[0].pinNumber = "3";
  if (kind === "wiredExtra") f.snapshot.pins.find((p: any) => p.pinNumber === "0").net = "GND";
  if (kind === "extraTouchesWire") f.snapshot.wires.push({ PrimitiveId: "kept", Line: [70, 150, 90, 150], Net: "GND" });
  if (kind === "extraTouchesPin")
    f.snapshot.pins.push({ PrimitiveId: "other", componentId: "keep", pinNumber: "8", X: 80, Y: 150 });
  if (kind === "extraTouchesAnchor") f.snapshot.components.push({ PrimitiveId: "anchor", X: 80, Y: 150 });
  if (kind === "missingEvidence") contract.extraNCpins[0].evidence = "";
  expect(() =>
    buildNamedStubPlan(f.snapshot, "old", "new", f.selections, kind === "noContract" ? undefined : contract)
  ).toThrow();
});
