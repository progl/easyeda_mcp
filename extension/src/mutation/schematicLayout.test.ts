import { beforeEach, describe, expect, it, vi } from "vitest";
import { pageFixture } from "./schematicPageFixture.js";
import { prepareSchematicComponentMutation } from "./schematicComponentMutations.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
import { extensionMutations } from "./mutationManager.js";

function publicAttribute(a: any) {
  for (const key of Object.keys(a)) {
    const name = `getState_${key[0].toUpperCase() + key.slice(1)}`;
    if (typeof a[name] !== "function" && !key.startsWith("getState_"))
      Object.defineProperty(a, name, {
        configurable: true,
        value: function (this: any) {
          return this[key];
        }
      });
  }
  return a;
}
function fixture() {
  const f = pageFixture();
  const attrs = [
    {
      primitiveId: "attr",
      parentPrimitiveId: "c1",
      key: "Designator",
      value: "R1",
      x: 100,
      y: 120,
      fontSize: 72,
      getState_FontSize: () => 10,
      valueVisible: true
    }
  ];
  f.eda.sch_PrimitiveAttribute.getAll = async (parent?: string) =>
    attrs.filter((a) => !parent || a.parentPrimitiveId === parent).map(publicAttribute);
  f.eda.sch_PrimitiveAttribute.modify = vi.fn(async (id, patch) =>
    Object.assign(
      attrs.find((a) => a.primitiveId === id)!,
      { ...patch, ...(typeof patch.y === "number" ? { y: -patch.y } : {}) }
    )
  );
  f.eda.sch_PrimitiveWire.modify = vi.fn(async (id, patch) =>
    Object.assign(
      f.wires[f.active()].find((w) => w.primitiveId === id),
      patch
    )
  );
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id: string) => {
    const c = f.components[f.active()].find((c) => c.primitiveId === id);
    return [{ primitiveId: id + "-1", pinNumber: "1", x: c.x - 10, y: c.y, rotation: 180 }];
  };
  f.eda.sch_ManufactureData = { getNetlistFile: vi.fn(async () => ({ text: async () => "(\nGND\nR1-1\n)" })) };
  const texts: any[] = [],
    rectangles: any[] = [];
  f.eda.sch_PrimitiveText = {
    getAll: vi.fn(async () => texts),
    create: vi.fn(
      async (x, y, content, rotation, textColor, fontName, fontSize, bold, italic, underLine, alignMode) => {
        const t = {
          primitiveId: "text-" + texts.length,
          x,
          y,
          content,
          rotation,
          textColor,
          fontName,
          fontSize: fontSize * 7.2,
          getState_FontSize: () => fontSize,
          bold,
          italic,
          underLine,
          alignMode
        };
        texts.push(t);
        return t;
      }
    )
  };
  f.eda.sch_PrimitiveRectangle = {
    getAll: vi.fn(async () => rectangles),
    create: vi.fn(
      async (topLeftX, topLeftY, width, height, cornerRadius, rotation, color, fillColor, lineWidth, lineType) => {
        const r = {
          primitiveId: "rect-" + rectangles.length,
          topLeftX,
          topLeftY,
          width,
          height,
          cornerRadius,
          rotation,
          color,
          fillColor,
          lineWidth,
          lineType
        };
        rectangles.push(r);
        return r;
      }
    )
  };
  const handlers = createActionHandlers(f.api, {} as any, extensionMutations);
  const confirm = (p: any) =>
    handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    }) as Promise<any>;
  const prepare = (properties: any) =>
    prepareSchematicComponentMutation(f.api, { action: "update", component: "@schematic", properties });
  return { ...f, attrs, texts, rectangles, prepare, confirm };
}

describe("schematic functional layout", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  const annotation = {
    items: [
      { type: "rectangle", x: 20, y: 20, width: 400, height: 200 },
      { type: "text", x: 35, y: 35, text: "Питание USB-C", fontSize: 16, bold: true },
      { type: "text", x: 35, y: 60, text: "20 В → 12 В", fontSize: 10 }
    ]
  };
  it("creates a confirmed batch of non-electrical frames/headings with native font units", async () => {
    const f = fixture();
    const before = JSON.stringify({ components: f.components, wires: f.wires });
    const p = await f.prepare({ annotation });
    expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveRectangle.create).not.toHaveBeenCalled();
    const r = await f.confirm(p);
    expect(r.status).toBe("applied");
    expect(r.after).toMatchObject({ verified: true, electricalPrimitivesUnchanged: true, units: "10mil" });
    expect(f.texts).toHaveLength(2);
    expect(f.rectangles[0].fillColor).toBe("none");
    expect(f.eda.sch_PrimitiveText.create.mock.calls[0][6]).toBe(16);
    expect(JSON.stringify({ components: f.components, wires: f.wires })).toBe(before);
  });
  it("rejects unsupported annotation APIs and stale previews before writing", async () => {
    const f = fixture();
    const p = await f.prepare({ annotation });
    f.components.p1[0].x++;
    await expect(f.confirm(p)).rejects.toThrow(/stale|changed/i);
    expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
    delete f.eda.sch_PrimitiveRectangle.create;
    await expect(f.prepare({ annotation })).rejects.toThrow(/API|capability/i);
  });
  it("does not silently duplicate an existing annotation", async () => {
    const f = fixture();
    await f.confirm(await f.prepare({ annotation }));
    await expect(f.prepare({ annotation })).rejects.toThrow(/already|duplicate/i);
    expect(f.texts).toHaveLength(2);
  });
  it("retains a partial annotation journal rather than replaying a failed batch", async () => {
    const f = fixture();
    const p = await f.prepare({ annotation });
    f.eda.sch_PrimitiveText.create.mockRejectedValue(new Error("SDK stopped"));
    const result = await f.confirm(p);
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Do not replay.*rect-0/i);
    expect(f.eda.sch_PrimitiveRectangle.create).toHaveBeenCalledTimes(1);
  });
  it("translates an electrically closed block in place, preserving original IDs, nets and attributes", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } });
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
    const result = await f.confirm(p);
    expect(result.status).toBe("applied");
    expect(result.after).toMatchObject({ identityPreserved: true, nativeConnectivityVerified: true });
    expect(f.components.p1[0]).toMatchObject({ primitiveId: "c1", uniqueId: "uid1", designator: "R1", x: 300, y: 400 });
    expect(f.wires.p1[0]).toMatchObject({ primitiveId: "w1", net: "GND", line: [280, 400, 290, 400] });
    expect(f.attrs[0]).toMatchObject({ primitiveId: "attr", x: 300, y: 420, fontSize: 72, valueVisible: true });
    expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveWire.create).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveWire.delete).not.toHaveBeenCalled();
  });
  it("refuses physical boundary connections and destination collisions before writing", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2" });
    await expect(f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } })).rejects.toThrow(
      /boundary|outside|shared/i
    );
    f.components.p1[1].x = 300;
    f.components.p1[1].y = 400;
    await expect(f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } })).rejects.toThrow(
      /collision|intersect/i
    );
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  });
  it("rejects cyclic wire swaps before writing even though the final packing has no overlap", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    f.wires.p1.push({ primitiveId: "w2", line: [380, 100, 390, 100], net: "GND" });
    await expect(
      f.prepare({
        layout: {
          placements: [
            { component: "R1", x: 400, y: 100 },
            { component: "R2", x: 100, y: 100 }
          ]
        }
      })
    ).rejects.toThrow(/cyclic/i);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveWire.modify).not.toHaveBeenCalled();
  });
  it("rejects a shared wire group whose connected components have different deltas", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    f.wires.p1[0].line = [90, 100, 390, 100];
    await expect(
      f.prepare({
        layout: {
          placements: [
            { component: "R1", x: 100, y: 300 },
            { component: "R2", x: 400, y: 500 }
          ]
        }
      })
    ).rejects.toThrow(/shared.*delta|different.*delta/i);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  });
  it("translates a shared wire only once when its connected parts have the same delta", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    f.wires.p1[0].line = [90, 100, 390, 100];
    f.eda.sch_ManufactureData.getNetlistFile.mockResolvedValue({ text: async () => "(\nGND\nR1-1\nR2-1\n)" });
    const result = await f.confirm(await f.prepare({ layout: { componentIds: ["R1", "R2"], dx: 200, dy: 300 } }));
    expect(result.status).toBe("applied");
    expect(f.wires.p1[0].line).toEqual([290, 400, 590, 400]);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
  });
  it("checks moved wires against unwired pins of another independently moved part", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 1000 });
    await expect(
      f.prepare({
        layout: {
          placements: [
            { component: "R1", x: 400, y: 100 },
            { component: "R2", x: 395, y: 100 }
          ]
        }
      })
    ).rejects.toThrow(/intersect|collision/i);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  });
  it("retains partial in-place progress and never copies or deletes when an SDK move fails", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    const p = await f.prepare({ layout: { componentIds: ["R1", "R2"], dx: 200, dy: 300 } });
    f.eda.sch_PrimitiveComponent.modify
      .mockImplementationOnce(async (id: string, patch: any) =>
        Object.assign(
          f.components.p1.find((c) => c.primitiveId === id),
          patch
        )
      )
      .mockRejectedValueOnce(new Error("SDK stopped"));
    const result = await f.confirm(p);
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Do not replay.*c1/i);
    expect(f.eda.sch_PrimitiveWire.modify).not.toHaveBeenCalled();
    expect(f.components.p1.map((c) => c.uniqueId)).toEqual(["uid1", "uid2"]);
    expect(f.eda.sch_PrimitiveComponent.create).not.toHaveBeenCalled();
    expect(f.eda.sch_PrimitiveComponent.delete).not.toHaveBeenCalled();
  });
  it("refuses a stale layout and never begins a move without native connectivity evidence", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } });
    f.components.p1[0].x++;
    await expect(f.confirm(p)).rejects.toThrow(/stale|changed/i);
    delete f.eda.sch_ManufactureData;
    await expect(f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } })).rejects.toThrow(
      /native|connectivity|getNetlistFile/i
    );
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  });
  it("does not claim success when native membership differs after the move", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300, nativeNetlistTimeoutMs: 200 } });
    f.eda.sch_PrimitiveWire.modify.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      Object.assign(
        f.wires.p1.find((w) => w.primitiveId === id),
        patch
      );
      f.eda.sch_ManufactureData.getNetlistFile.mockResolvedValue({ text: async () => "(\nOTHER\nR1-1\n)" });
    });
    const result = await f.confirm(p);
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Do not replay|connectivity/i);
    expect(result.error).toContain('"changedPins":1');
    expect(result.error).toContain('"expectedNet":"GND"');
    expect(result.error).toContain('"actualNet":"OTHER"');
    expect(f.eda.sch_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
  });
  it("rejects bus-bearing sheets before any layout write", async () => {
    const f = fixture();
    f.eda.sch_PrimitiveBus = { getAll: async () => [{ primitiveId: "bus1" }] };
    await expect(f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } })).rejects.toThrow(/bus-aware/i);
    expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  });

  it("preserves SDK replacement wire fields and waits for asynchronous normalized geometry before exporting", async () => {
    const f = fixture();
    Object.assign(f.wires.p1[0], { color: "#123456", lineWidth: 2, lineType: 1 });
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } });
    f.eda.sch_PrimitiveWire.modify.mockImplementation(async (id: string, patch: Record<string, any>) => {
      setTimeout(
        () =>
          Object.assign(
            f.wires.p1.find((w) => w.primitiveId === id),
            {
              line: [patch.line[2], patch.line[3], patch.line[0], patch.line[1]],
              net: patch.net ?? "",
              color: patch.color ?? null,
              lineWidth: patch.lineWidth ?? null,
              lineType: patch.lineType ?? null
            }
          ),
        25
      );
      return { primitiveId: id };
    });
    f.eda.sch_ManufactureData.getNetlistFile.mockImplementation(async () => {
      const w = f.wires.p1[0];
      expect(w.line).toEqual([290, 400, 280, 400]);
      expect(w).toMatchObject({ net: "GND", color: "#123456", lineWidth: 2, lineType: 1 });
      return { text: async () => "(\nGND\nR1-1\n)" };
    });
    expect((await f.confirm(p)).status).toBe("applied");
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_ManufactureData.getNetlistFile).toHaveBeenCalledTimes(2);
  });

  it("does not export or verify topology before wire persistence is confirmed", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300, nativeNetlistTimeoutMs: 100 } });
    f.eda.sch_PrimitiveWire.modify.mockResolvedValue({ primitiveId: "w1" });
    const result = await f.confirm(p);
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/wire.*persistence|positions/i);
    expect(f.eda.sch_ManufactureData.getNetlistFile).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
  });
  it("serializes wire persistence when overlapping SDK dispatches would discard an earlier write", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    f.wires.p1.push({ primitiveId: "w2", line: [380, 100, 390, 100], net: "GND" });
    const p = await f.prepare({
      layout: { componentIds: ["R1", "R2"], dx: 200, dy: 300, nativeNetlistTimeoutMs: 200 }
    });
    let inFlight = false,
      dropped = 0;
    f.eda.sch_PrimitiveWire.modify.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (inFlight) {
        dropped++;
        return;
      }
      inFlight = true;
      setTimeout(() => {
        Object.assign(
          f.wires.p1.find((w) => w.primitiveId === id),
          patch
        );
        inFlight = false;
      }, 25);
    });
    expect((await f.confirm(p)).status).toBe("applied");
    expect(dropped).toBe(0);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(2);
    expect(f.wires.p1.map((w) => w.line)).toEqual([
      [280, 400, 290, 400],
      [580, 400, 590, 400]
    ]);
  });

  it("reports bounded mismatch counts and the first eight primitive IDs instead of the full journal", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300, nativeNetlistTimeoutMs: 100 } });
    f.eda.sch_PrimitiveWire.modify.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      Object.assign(
        f.wires.p1.find((w) => w.primitiveId === id),
        patch
      );
      for (let n = 0; n < 12; n++)
        f.texts.push({
          primitiveId: `unexpected-${n.toString().padStart(2, "0")}`,
          x: 9999,
          y: 9999,
          content: "changed"
        });
    });
    const result = await f.confirm(p);
    expect(result.status).toBe("unknown");
    expect(result.error).toContain('"text":12');
    expect(result.error).toContain("unexpected-07");
    expect(result.error).not.toContain("unexpected-08");
    expect(result.error.length).toBeLessThan(1800);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
  });
  it("repairs exact attribute positions without moving electrical primitives or changing font units", async () => {
    const f = fixture();
    const electrical = JSON.stringify({ c: f.components, w: f.wires });
    const p = await f.prepare({
      attributeLayout: { parentIds: ["c1"], placements: [{ attributeId: "attr", x: 900, y: 800 }] }
    });
    const r = await f.confirm(p);
    expect(r.status).toBe("applied");
    expect(f.attrs[0]).toMatchObject({ x: 900, y: 800, fontSize: 72, value: "R1", parentPrimitiveId: "c1" });
    expect(f.eda.sch_PrimitiveAttribute.modify).toHaveBeenCalledExactlyOnceWith("attr", { x: 900, y: -800 });
    expect(JSON.stringify({ c: f.components, w: f.wires })).toBe(electrical);
    expect(r.after).toMatchObject({ verified: true, nativeConnectivityVerified: true, visualRenderVerified: false });
  });
  it("enumerates parent-only component and wire labels when global attribute read is empty", async () => {
    const f = fixture();
    const wireAttr = {
      ...f.attrs[0],
      primitiveId: "netlabel",
      parentPrimitiveId: "w1",
      key: "actual-native-key",
      value: "GND",
      x: 80,
      y: 100
    };
    f.attrs.push(wireAttr);
    f.eda.sch_PrimitiveAttribute.getAll = async (parent?: string) =>
      parent ? f.attrs.filter((a) => a.parentPrimitiveId === parent).map(publicAttribute) : [];
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300 } });
    expect((await f.confirm(p)).status).toBe("applied");
    expect(wireAttr).toMatchObject({ x: 280, y: 400, value: "GND" });
  });

  it("stops a batch when the active target changes after a wire persists", async () => {
    const f = fixture();
    f.components.p1.push({ ...f.components.p1[0], primitiveId: "c2", designator: "R2", uniqueId: "uid2", x: 400 });
    f.wires.p1.push({ primitiveId: "w2", line: [380, 100, 390, 100], net: "GND" });
    const p = await f.prepare({ layout: { componentIds: ["R1", "R2"], dx: 200, dy: 300 } });
    f.eda.sch_PrimitiveWire.modify.mockImplementation(async (id: string, patch: any) => {
      Object.assign(
        f.wires.p1.find((w) => w.primitiveId === id),
        patch
      );
      f.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({
        uuid: "p2",
        parentProjectUuid: "project",
        documentType: 1
      });
    });
    expect((await f.confirm(p)).status).toBe("unknown");
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_PrimitiveAttribute.modify).not.toHaveBeenCalled();
  });
  it("refuses an attribute repair whose exact IDs or baseline fields changed", async () => {
    const f = fixture();
    await expect(
      f.prepare({ attributeLayout: { parentIds: ["c1"], placements: [{ attributeId: "missing", x: 1, y: 2 }] } })
    ).rejects.toThrow(/attribute.*missing|missing.*attribute/i);
    const p = await f.prepare({
      attributeLayout: { parentIds: ["c1"], placements: [{ attributeId: "attr", x: 1, y: 2 }] }
    });
    f.attrs[0].value = "changed";
    await expect(f.confirm(p)).rejects.toThrow(/changed|stale/i);
    expect(f.eda.sch_PrimitiveAttribute.modify).not.toHaveBeenCalled();
  });
  it("reconciles a transient post-layout native export using reads only, with exact export/write counts", async () => {
    const f = fixture();
    const p = await f.prepare({ layout: { componentIds: ["R1"], dx: 200, dy: 300, nativeNetlistTimeoutMs: 1000 } });
    f.eda.sch_ManufactureData.getNetlistFile.mockResolvedValueOnce({ text: async () => "(\nSTALE\nR1-1\n)" });
    const result = await f.confirm(p);
    expect(result.status).toBe("applied");
    expect(result.after.nativeReadback).toMatchObject({ verified: true, attempts: 2, reconciled: true });
    expect(f.eda.sch_ManufactureData.getNetlistFile).toHaveBeenCalledTimes(3);
    expect(f.eda.sch_PrimitiveComponent.modify).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_PrimitiveWire.modify).toHaveBeenCalledTimes(1);
  });
  it("uses the same read-only reconciliation for attribute repairs without replaying their writes", async () => {
    const f = fixture();
    const p = await f.prepare({
      attributeLayout: {
        parentIds: ["c1"],
        placements: [{ attributeId: "attr", x: 900, y: 800 }],
        nativeNetlistTimeoutMs: 1000
      }
    });
    f.eda.sch_ManufactureData.getNetlistFile.mockResolvedValueOnce({ text: async () => "(\nSTALE\nR1-1\n)" });
    const result = await f.confirm(p);
    expect(result.status).toBe("applied");
    expect(result.after.nativeReadback).toMatchObject({ verified: true, attempts: 2, reconciled: true });
    expect(f.eda.sch_ManufactureData.getNetlistFile).toHaveBeenCalledTimes(3);
    expect(f.eda.sch_PrimitiveAttribute.modify).toHaveBeenCalledTimes(1);
  });
});
