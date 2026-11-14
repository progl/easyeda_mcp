import { beforeEach, describe, expect, it, vi } from "vitest";
import { pageFixture } from "./schematicPageFixture.js";
import { prepareBlockTransfer, executeBlockTransfer } from "./schematicBlockTransfer.js";
import { extensionMutations } from "./mutationManager.js";
describe("block transfer", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  const params = { components: ["R1"], destinationPageId: "p2", dx: 0, dy: 0 };
  it("preserves identity, footprint, value and wires and only then removes source", async () => {
    const f = pageFixture();
    const p = await prepareBlockTransfer(f.api, params);
    expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
    const r = await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
    expect(r.readback.verified).toBe(true);
    expect(f.components.p1).toHaveLength(0);
    expect(f.components.p2[0]).toMatchObject({
      designator: "R1",
      uniqueId: "uid1",
      footprint: { uuid: "fp" },
      otherProperty: { Value: "10k" }
    });
    expect(f.wires.p2[0].net).toBe("GND");
    expect(f.active()).toBe("p1");
  });
  it("leaves source intact if copy creation fails", async () => {
    const f = pageFixture();
    const p = await prepareBlockTransfer(f.api, params);
    f.eda.sch_PrimitiveComponent.create.mockRejectedValue(new Error("fail"));
    await expect(executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow(
      /inspect|replay|partial/i
    );
    expect(f.components.p1).toHaveLength(1);
    expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
    expect(f.active()).toBe("p1");
  });
  it("rejects a wire shared physically with a component outside the block", async () => {
    const f = pageFixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2" });
    await expect(prepareBlockTransfer(f.api, params)).rejects.toThrow(/boundary|outside|shared/i);
  });
  it("rejects unnamed boundary wires", async () => {
    const f = pageFixture();
    f.wires.p1[0].net = "";
    await expect(prepareBlockTransfer(f.api, params)).rejects.toThrow(/unnamed|net/i);
  });
  it("rejects a duplicate destination reference", async () => {
    const f = pageFixture();
    f.components.p2.push({ ...f.components.p1[0], primitiveId: "dest", uniqueId: "other" });
    await expect(prepareBlockTransfer(f.api, params)).rejects.toThrow(/duplicate|exists|conflict/i);
  });
  it("rejects source changes after preview before creating anything", async () => {
    const f = pageFixture();
    const p = await prepareBlockTransfer(f.api, params);
    f.components.p1[0].otherProperty.Value = "20k";
    await expect(executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow(
      /stale|changed/
    );
    expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
  });
  it("preserves attached annotation positions and visibility", async () => {
    const f = pageFixture();
    const source = {
      primitiveId: "attr1",
      parentPrimitiveId: "c1",
      key: "Designator",
      value: "R1",
      x: 100,
      y: 120,
      valueVisible: true
    };
    const dest = { ...source, primitiveId: "attr2", parentPrimitiveId: "copy", x: 0, y: 0, valueVisible: false };
    f.eda.sch_PrimitiveAttribute = {
      getAll: async (id?: string) =>
        id === "c1" ? [source] : id === "copy" ? [dest] : f.active() === "p1" ? [source] : [dest],
      modify: vi.fn(async (_: string, p: any) =>
        Object.assign(dest, { ...p, ...(typeof p.y === "number" ? { y: -p.y } : {}) })
      )
    };
    const p = await prepareBlockTransfer(f.api, params);
    await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
    expect(dest).toMatchObject({ x: 100, y: 120, valueVisible: true });
    expect(f.eda.sch_PrimitiveAttribute.modify).toHaveBeenCalled();
  });
  it("rejects a destination pin even when it has no wire", async () => {
    const f = pageFixture();
    f.components.p2.push({ ...f.components.p1[0], primitiveId: "other", designator: "R9", uniqueId: "uid9" });
    await expect(prepareBlockTransfer(f.api, params)).rejects.toThrow(/collision|intersect/i);
  });
  it("never deletes source when the copied uniqueId or footprint is not preserved", async () => {
    const f = pageFixture();
    const p = await prepareBlockTransfer(f.api, params);
    f.eda.sch_PrimitiveComponent.modify.mockImplementation(async (id: string, props: any) => {
      const c = f.components[f.active()].find((c) => c.primitiveId === id);
      Object.assign(c, props);
      c.uniqueId = "changed-by-editor";
      return c;
    });
    await expect(executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow(/readback/);
    expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
    expect(f.components.p1).toHaveLength(1);
  });

  it("resolves a project-local device ID to an exact global library part before writing", async () => {
    const f = pageFixture();
    f.components.p1[0].component.uuid = "0123456789abcdef";
    f.components.p1[0].manufacturerId = "PART";
    f.components.p1[0].supplierId = "C123";
    f.eda.lib_Device = {
      search: vi.fn(async () => [
        {
          uuid: "a".repeat(32),
          libraryUuid: "lib",
          manufacturerId: "PART",
          supplierId: "C123",
          footprintName: undefined
        }
      ])
    };
    f.eda.sch_PrimitiveComponent.create.mockImplementation(async (device: any, x: number, y: number) => {
      const c = {
        ...f.components.p1[0],
        primitiveId: "copy",
        component: { ...device, uuid: "0123456789abcdef" },
        x,
        y
      };
      f.components.p2.push(c);
      return c;
    });
    const p = await prepareBlockTransfer(f.api, params);
    await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
    expect(f.eda.sch_PrimitiveComponent.create.mock.calls[0][0].uuid).toBe("a".repeat(32));
  });
});

it("uses public attribute units instead of internal inch-sized font fields", async () => {
  const f = pageFixture();
  const source: any = {
    primitiveId: "a1",
    parentPrimitiveId: "c1",
    key: "Name",
    value: "10k",
    x: 100,
    y: 120,
    fontSize: 0.0675,
    getState_FontSize() {
      return this.fontSize * 100;
    }
  };
  const dest: any = { ...source, primitiveId: "a2", parentPrimitiveId: "copy" };
  f.eda.sch_PrimitiveAttribute = {
    getAll: async (id?: string) =>
      id === "c1" ? [source] : id === "copy" ? [dest] : f.active() === "p1" ? [source] : [dest],
    modify: vi.fn(async (_: string, p: any) => {
      Object.assign(dest, p);
      if (p.fontSize !== undefined) dest.fontSize = p.fontSize / 100;
      return dest;
    })
  };
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
  expect(dest.getState_FontSize()).toBeCloseTo(6.75);
  expect(f.components.p1).toHaveLength(0);
});

it("transfers identities even when the editor rejects duplicates across pages", async () => {
  const f = pageFixture();
  f.eda.sch_PrimitiveComponent.modify.mockImplementation(async (id: string, patch: any) => {
    const c = f.components[f.active()].find((c) => c.primitiveId === id);
    for (const key of ["designator", "uniqueId"])
      if (
        patch[key] &&
        Object.values(f.components)
          .flat()
          .some((other) => other !== c && other[key] === patch[key])
      )
        throw new Error("Duplicate " + key);
    Object.assign(c, patch);
    return c;
  });
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
  expect(f.components.p2[0]).toMatchObject({ designator: "R1", uniqueId: "uid1" });
  expect(f.components.p1).toHaveLength(0);
});

it("does not retire source identities when annotation verification fails", async () => {
  const f = pageFixture();
  const source = { primitiveId: "a1", parentPrimitiveId: "c1", key: "Name", value: "10k", x: 100, y: 120 };
  const dest = { ...source, primitiveId: "a2", parentPrimitiveId: "copy", x: 0 };
  f.eda.sch_PrimitiveAttribute = {
    getAll: async (id?: string) =>
      id === "c1" ? [source] : id === "copy" ? [dest] : f.active() === "p1" ? [source] : [dest],
    modify: vi.fn(async () => undefined)
  };
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  await expect(executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow(
    /Annotation readback failed/
  );
  expect(f.components.p1[0]).toMatchObject({ designator: "R1", uniqueId: "uid1" });
  expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
});

it("keeps both sides and an identity journal if final handoff fails", async () => {
  const f = pageFixture();
  f.eda.sch_PrimitiveComponent.modify.mockImplementation(async (id: string, patch: any) => {
    if (f.active() === "p2" && patch.designator === "R1") throw new Error("handoff rejected");
    const c = f.components[f.active()].find((c) => c.primitiveId === id);
    Object.assign(c, patch);
    return c;
  });
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  const record = extensionMutations.get(String(p.mutationId));
  await expect(executeBlockTransfer(record, f.api)).rejects.toThrow(/assign_destination_identity/);
  expect(f.components.p1).toHaveLength(1);
  expect(f.components.p2).toHaveLength(1);
  expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
  expect((record.operation as any).progress.identityTransfers[0].original).toEqual({
    designator: "R1",
    uniqueId: "uid1"
  });
});

it("waits for delayed wire readback before retiring source identities", async () => {
  const f = pageFixture();
  let stale = true;
  f.eda.sch_PrimitiveWire.getAll = vi.fn(async () => {
    if (f.active() === "p2" && f.wires.p2.length && stale) {
      stale = false;
      return [];
    }
    return f.wires[f.active()];
  });
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
  expect(f.components.p1).toHaveLength(0);
  expect(f.components.p2[0].designator).toBe("R1");
});

it("refreshes native connectivity before checking newly created wire net names", async () => {
  const f = pageFixture();
  let published = false;
  f.eda.sch_PrimitiveWire.getAll = async () =>
    f.active() === "p2" && !published ? f.wires.p2.map((w) => ({ ...w, net: "$PENDING" })) : f.wires[f.active()];
  f.eda.sch_ManufactureData = {
    getNetlistFile: vi.fn(async () => {
      published = true;
      return { text: async () => "(\nGND\nR1-1\n)" };
    })
  };
  const p = await prepareBlockTransfer(f.api, { components: ["R1"], destinationPageId: "p2" });
  await executeBlockTransfer(extensionMutations.get(String(p.mutationId)), f.api);
  expect(f.eda.sch_ManufactureData.getNetlistFile).toHaveBeenCalled();
  expect(f.components.p1).toHaveLength(0);
});
