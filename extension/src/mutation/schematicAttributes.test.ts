import { expect, it, vi } from "vitest";
import { readSchematicAttributes, restoreSchematicAttributes } from "./schematicAttributes.js";

// Three installed layers: SDK forwards modify.property unchanged; backend writes model.y;
// backend projector aN returns {x:model.x,y:-model.y,fontSize:model.fontSize/100};
// the SDK instance getState_Y/getState_FontSize return those projected values unchanged.
it("round-trips public attribute coordinates through asymmetric backend Y without altering font/style", async () => {
  const model: any = {
    primitiveId: "a",
    parentPrimitiveId: "w",
    x: 100,
    y: -120,
    fontSize: 1000,
    key: "Name",
    value: "I2C_SCL",
    color: "#123456",
    valueVisible: true
  };
  const snapshot = () => {
    const projected = { ...model, y: -model.y, fontSize: model.fontSize / 100 };
    return Object.fromEntries(
      Object.keys(projected).map((key) => [`getState_${key[0].toUpperCase() + key.slice(1)}`, () => projected[key]])
    );
  };
  const modify = vi.fn(async (_id: string, property: any) => {
    Object.assign(model, property);
    return snapshot();
  });
  const api = () => ({ sch_PrimitiveAttribute: { getAll: async () => [snapshot()], modify } });
  const before = await readSchematicAttributes(api, "w");
  await restoreSchematicAttributes(api, "w", before, 200, 300);
  expect(modify).toHaveBeenCalledExactlyOnceWith("a", { x: 300, y: -420 });
  expect(await readSchematicAttributes(api, "w")).toEqual([{ ...before[0], x: 300, y: 420 }]);
  expect(model).toMatchObject({
    x: 300,
    y: -420,
    fontSize: 1000,
    color: "#123456",
    value: "I2C_SCL",
    valueVisible: true
  });
});
