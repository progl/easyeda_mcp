import { expect, it } from "vitest";
import {
  encodePcbPreservationInventory as encode,
  decodePcbPreservationInventory as decode
} from "./pcbPreservationEncoding.js";
it("roundtrips every native field including explicit undefined/null, ordered arrays and reviewed NaN tags without shared aliases", () => {
  const tag = { encoding: "native_not_applicable_v1", rawNonFinite: "NaN", layer: 1, holeDiscriminant: null };
  const input = {
    groups: {
      Pad: [
        {
          PrimitiveId: "a",
          Hole: null,
          HoleRotation: tag,
          Undefined: undefined,
          Native: [1, undefined, null, { foo: undefined, bar: null }]
        },
        { PrimitiveId: "b", HoleRotation: tag }
      ]
    },
    componentPads: [{ PrimitiveId: "a", OwnerComponentId: "U1" }]
  };
  const output = decode(JSON.parse(JSON.stringify(encode(input))));
  expect(output).toEqual(input);
  expect(Object.prototype.hasOwnProperty.call(output.groups.Pad[0], "Undefined")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(output.groups.Pad[1], "Undefined")).toBe(false);
  output.groups.Pad[0].HoleRotation.layer = 2;
  expect(output.groups.Pad[1].HoleRotation.layer).toBe(1);
  expect(input.groups.Pad[0].HoleRotation.layer).toBe(1);
});
it.each(["reference", "version", "nonfinite", "unsafeKey"])("fails closed on malformed %s proof", (kind) => {
  const encoded: any = encode({ groups: { Pad: [{ PrimitiveId: "a" }] }, componentPads: [] });
  if (kind === "reference") encoded.root = 999999;
  if (kind === "version") encoded.encoding = "unreviewed";
  if (kind === "nonfinite") encoded.values.push([1, NaN]);
  if (kind === "unsafeKey")
    (encoded.keySets.push(["__proto__"]),
      encoded.values.push([3, encoded.keySets.length - 1, [0]]),
      (encoded.root = encoded.values.length - 1));
  expect(() => decode(encoded)).toThrow();
});
