import { expect, it } from "vitest";
import { buildSafeWireOrder } from "./schematicWireOrder.js";
const wire = (primitiveId: string, line: unknown) => ({ primitiveId, line });
it("moves an old-geometry blocker first even when its ID sorts later", () => {
  const baseline = [wire("a", [0, 0, 10, 0]), wire("b", [0, 10, 10, 10])];
  const desired = [wire("a", [0, 10, 10, 10]), wire("b", [0, 20, 10, 20])];
  const copy = JSON.stringify({ baseline, desired });
  expect(buildSafeWireOrder(baseline, desired)).toEqual(["b", "a"]);
  expect(JSON.stringify({ baseline, desired })).toBe(copy);
});
it("sorts independent ready wires deterministically by ID", () => {
  const baseline = [wire("z", [0, 0, 10, 0]), wire("a", [30, 0, 40, 0]), wire("m", [60, 0, 70, 0])];
  const desired = [wire("z", [0, 20, 10, 20]), wire("m", [60, 20, 70, 20]), wire("a", [30, 20, 40, 20])];
  expect(buildSafeWireOrder(baseline, desired)).toEqual(["a", "m", "z"]);
  expect(buildSafeWireOrder([...baseline].reverse(), [...desired].reverse())).toEqual(["a", "m", "z"]);
});
it("refuses a stationary blocker, including endpoint touch", () => {
  expect(() =>
    buildSafeWireOrder([wire("a", [0, 0, 10, 0]), wire("b", [10, 10, 20, 10])], [wire("a", [0, 10, 10, 10])])
  ).toThrow(/stationary|unselected/i);
});
it("refuses cyclic geometry dependencies before producing an order", () => {
  const old = [wire("a", [0, 0, 10, 0]), wire("b", [0, 10, 10, 10])];
  expect(() => buildSafeWireOrder(old, [wire("a", old[1].line), wire("b", old[0].line)])).toThrow(/cycl/i);
});
it("finds dependencies for perpendicular intersection and nested paths", () => {
  const baseline = [
    wire("a", [0, 0, 10, 0]),
    wire("b", [
      [5, 10, 5, 30],
      [5, 30, 10, 30]
    ])
  ];
  expect(
    buildSafeWireOrder(baseline, [
      wire("a", [0, 20, 10, 20]),
      wire("b", [
        [25, 10, 25, 30],
        [25, 30, 30, 30]
      ])
    ])
  ).toEqual(["b", "a"]);
});
it("rejects duplicate and missing IDs", () => {
  expect(() => buildSafeWireOrder([wire("a", [0, 0, 10, 0]), wire("a", [0, 10, 10, 10])], [])).toThrow(/duplicate/i);
  expect(() =>
    buildSafeWireOrder([wire("a", [0, 0, 10, 0])], [wire("a", [0, 10, 10, 10]), wire("a", [0, 20, 10, 20])])
  ).toThrow(/duplicate/i);
  expect(() => buildSafeWireOrder([], [wire("a", [0, 0, 10, 0])])).toThrow(/baseline|missing/i);
  expect(() => buildSafeWireOrder([wire("", [0, 0, 10, 0])], [])).toThrow(/ID/i);
});
it.each(
  [
    undefined,
    [],
    [0, 0],
    [0, 0, 10],
    [0, 0, 10, NaN],
    [0, 0, 10, Infinity],
    [0, 0, 10, 10],
    [0, 0, 0, 0],
    [
      [0, 0],
      [10, 0]
    ],
    [[0, 0, 10, 0], []]
  ].map((line) => ({ line }))
)("rejects invalid line $line", ({ line }) => {
  expect(() => buildSafeWireOrder([wire("a", line)], [])).toThrow(/line|geometry|path|orthogonal|segment/i);
});
it("conservatively refuses a remaining shared endpoint with an unselected wire", () => {
  const old = [wire("a", [0, 0, 10, 0]), wire("b", [10, 0, 20, 0])];
  expect(() => buildSafeWireOrder(old, [wire("a", [0, 10, 10, 10, 10, 0])])).toThrow(/stationary|unselected/i);
});
it("handles a multi-step dependency chain and an empty requested set", () => {
  const baseline = [wire("a", [0, 0, 10, 0]), wire("b", [0, 10, 10, 10]), wire("c", [0, 20, 10, 20])];
  expect(buildSafeWireOrder(baseline, [])).toEqual([]);
  expect(
    buildSafeWireOrder(baseline, [wire("a", [0, 10, 10, 10]), wire("b", [0, 20, 10, 20]), wire("c", [0, 30, 10, 30])])
  ).toEqual(["c", "b", "a"]);
});
