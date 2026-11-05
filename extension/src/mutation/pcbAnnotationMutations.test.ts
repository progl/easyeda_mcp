import { beforeEach, expect, it } from "vitest";
import { preparePcbAnnotationMutation, executePcbAnnotationMutation } from "./pcbAnnotationMutations.js";
import { extensionMutations } from "./mutationManager.js";
const doc = { uuid: "pcb-1", documentType: 3 };
function fixture() {
  const values = new Map<string, any>();
  let calls = 0;
  function store(data: any) {
    const id = `p-${++calls}`;
    const obj = Object.fromEntries(
      Object.entries({ PrimitiveId: id, ...data }).map(([k, v]) => [`getState_${k}`, () => v])
    );
    values.set(id, obj);
    return obj;
  }
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => doc },
    pcb_PrimitiveString: {
      create: async (layer: any, x: any, y: any, text: any, font: any, fontSize: any, lineWidth: any) =>
        store({ Layer: layer, X: x, Y: y, Text: text, FontSize: fontSize, LineWidth: lineWidth }),
      modify: async (id: string, patch: any) => {
        const old = values.get(id);
        if (!old) return;
        for (const [k, v] of Object.entries(patch)) old[`getState_${k[0].toUpperCase() + k.slice(1)}`] = () => v;
        return old;
      },
      delete: async (ids: string[]) => {
        ids.forEach((id) => values.delete(id));
        return true;
      },
      get: async (id: string) => values.get(id)
    },
    pcb_MathPolygon: { createPolygon: (source: any) => ({ getSource: () => source }) },
    pcb_PrimitivePolyline: {
      create: async (net: any, layer: any, polygon: any, lineWidth: any) =>
        store({ Net: net, Layer: layer, Polygon: polygon, LineWidth: lineWidth }),
      modify: async (id: string, patch: any) => {
        const old = values.get(id);
        if (!old) return;
        for (const [k, v] of Object.entries(patch)) old[`getState_${k[0].toUpperCase() + k.slice(1)}`] = () => v;
        return old;
      },
      delete: async (ids: string[]) => {
        ids.forEach((id) => values.delete(id));
        return true;
      },
      get: async (id: string) => values.get(id)
    },
    pcb_PrimitiveLine: {
      create: () => {
        throw new Error("graphics require Polyline");
      }
    }
  };
  return { eda, values, count: () => calls };
}
beforeEach(() => extensionMutations.invalidateAll());
it("prepares without writes, converts all metric dimensions, and reads back text plus one native empty-net frame polyline", async () => {
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    units: "mm",
    items: [
      { kind: "text", layer: 3, x: 25.4, y: 2.54, text: "POWER", fontSize: 1.27, lineWidth: 0.127 },
      { kind: "rectangle", layer: 13, x: 0, y: 0, width: 25.4, height: 12.7, lineWidth: 0.127 }
    ]
  });
  expect(f.count()).toBe(0);
  expect(p.confirmation).toBe(`CONFIRM pcb:createAnnotations ${p.mutationId}`);
  const record: any = extensionMutations.get(p.mutationId);
  expect(record.operation.items[0]).toMatchObject({ x: 1000, y: 100, fontSize: 50, lineWidth: 5 });
  const result = await executePcbAnnotationMutation(() => f.eda, record);
  expect(result.executed).toBe(true);
  expect(f.count()).toBe(2);
  expect(result.readback.primitives as any[]).toHaveLength(2);
  expect([...f.values.values()].slice(1).every((v) => v.getState_Net() === "")).toBe(true);
});
it.each([1, 2, 11, 12, 14, "3"])("rejects forbidden layer %s before writes", async (layer) => {
  const f = fixture();
  await expect(
    preparePcbAnnotationMutation(() => f.eda, {
      items: [{ kind: "text", layer, x: 0, y: 0, text: "X", fontSize: 45, lineWidth: 6 }]
    })
  ).rejects.toThrow();
  expect(f.count()).toBe(0);
});
it("blocks a changed target before any create", async () => {
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "text", layer: 3, x: 0, y: 0, text: "X", fontSize: 45, lineWidth: 6 }]
  });
  f.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ ...doc, uuid: "other" });
  await expect(
    executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId) as any)
  ).rejects.toThrow();
  expect(f.count()).toBe(0);
});
it("does not accept a returned primitive without independent matching readback", async () => {
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "text", layer: 3, x: 0, y: 0, text: "X", fontSize: 45, lineWidth: 6 }]
  });
  f.eda.pcb_PrimitiveString.get = async () => undefined;
  await expect(executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId) as any)).rejects.toThrow(
    /readback/i
  );
  expect(f.count()).toBe(1);
});
it("rejects mismatched text geometry readback without a second create", async () => {
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "text", layer: 3, x: 0, y: 0, text: "X", fontSize: 45, lineWidth: 6 }]
  });
  f.eda.pcb_PrimitiveString.get = async (id: string) => ({ ...f.values.get(id), getState_X: () => 99 });
  await expect(executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId) as any)).rejects.toThrow(
    /mismatch/
  );
  expect(f.count()).toBe(1);
});
it("uses lifecycle exact confirmation, reports uncertain readback, and never replays a consumed mutation", async () => {
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "text", layer: 4, x: 0, y: 0, text: "X", fontSize: 45, lineWidth: 6 }]
  });
  const handlers = createActionHandlers(() => f.eda, {} as any);
  await expect(
    handlers.confirmedAction({ action: "mutation", params: { mutationId: p.mutationId }, confirmation: "CONFIRM" })
  ).rejects.toThrow();
  expect(f.count()).toBe(0);
  f.eda.pcb_PrimitiveString.get = async () => undefined;
  try {
    await handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    });
  } catch {
    // The consumed mutation remains uncertain; its write must never be replayed.
  }
  const count = f.count();
  expect(count).toBe(1);
  try {
    await handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    });
  } catch {
    // The consumed mutation remains uncertain; its write must never be replayed.
  }
  expect(f.count()).toBe(count);
  expect(extensionMutations.get(p.mutationId).status).toBe("unknown");
});

async function createdText(f: ReturnType<typeof fixture>) {
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "text", layer: 3, x: 10, y: 20, text: "TMC1", fontSize: 40, lineWidth: 5 }]
  });
  const result = await executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId));
  return (result.readback.primitives as any[])[0].primitiveId;
}
it("stages and moves only an owned annotation with native snapshot readback", async () => {
  const f = fixture(),
    id = await createdText(f);
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    action: "modify",
    kind: "text",
    primitiveId: id,
    units: "mm",
    properties: { x: 2.54, fontSize: 1.27 }
  });
  expect(f.values.get(id).getState_X()).toBe(10);
  const result = await executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId));
  expect(result.readback).toMatchObject({ action: "modify", primitiveId: id, verified: true });
  expect(f.values.get(id).getState_X()).toBe(100);
  expect(f.values.get(id).getState_FontSize()).toBe(50);
});
it("rejects arbitrary primitive IDs and forbidden properties before writes", async () => {
  const f = fixture();
  await expect(
    preparePcbAnnotationMutation(() => f.eda, { action: "delete", kind: "text", primitiveId: "foreign" })
  ).rejects.toThrow(/owned|ownership|receipt/i);
  const id = await createdText(f);
  await expect(
    preparePcbAnnotationMutation(() => f.eda, {
      action: "modify",
      kind: "text",
      primitiveId: id,
      properties: { net: "GND" }
    })
  ).rejects.toThrow();
  await expect(
    preparePcbAnnotationMutation(() => f.eda, {
      action: "modify",
      kind: "text",
      primitiveId: id,
      properties: { layer: 1 }
    })
  ).rejects.toThrow();
});
it("refuses a stale annotation snapshot and verifies explicit deletion", async () => {
  const f = fixture(),
    id = await createdText(f);
  const p: any = await preparePcbAnnotationMutation(() => f.eda, { action: "delete", kind: "text", primitiveId: id });
  f.values.get(id).getState_Text = () => "USER EDIT";
  await expect(executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(
    /changed|stale/i
  );
  expect(f.values.has(id)).toBe(true);
});

it("adopts only an explicitly supplied legacy applied receipt matching native target/ID/text/geometry", async () => {
  const f = fixture();
  const id = "legacy-only";
  const proof = { primitiveId: id, Layer: 3, X: 10, Y: 20, Text: "TTL", FontSize: 40, LineWidth: 5 };
  f.values.set(
    id,
    Object.fromEntries(
      Object.entries(proof).map(([k, v]) => [k === "primitiveId" ? "getState_PrimitiveId" : `getState_${k}`, () => v])
    )
  );
  const receipt = {
    mutationId: "historical-applied",
    status: "applied",
    action: "createAnnotations",
    target: { documentId: doc.uuid, documentType: "pcb" },
    after: { primitives: [proof] }
  };
  await expect(
    preparePcbAnnotationMutation(() => f.eda, {
      action: "delete",
      kind: "text",
      primitiveId: id,
      originalCreationReceipt: { ...receipt, status: "unknown" }
    })
  ).rejects.toThrow(/receipt/i);
  await expect(
    preparePcbAnnotationMutation(() => f.eda, {
      action: "delete",
      kind: "text",
      primitiveId: id,
      originalCreationReceipt: { ...receipt, after: { primitives: [{ ...proof, Text: "FAKE" }] } }
    })
  ).rejects.toThrow(/receipt/i);
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    action: "delete",
    kind: "text",
    primitiveId: id,
    originalCreationReceipt: receipt
  });
  const result = await executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId));
  expect(result.readback).toMatchObject({ action: "delete", deleted: true, verified: true, primitiveId: id });
  expect(f.values.has(id)).toBe(false);
});
it("uses exact confirmation for owned annotation edit and never replays an unknown write", async () => {
  const f = fixture(),
    id = await createdText(f);
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    action: "modify",
    kind: "text",
    primitiveId: id,
    properties: { y: 90 }
  });
  let writes = 0;
  f.eda.pcb_PrimitiveString.modify = async () => {
    writes++;
    throw new Error("transport after dispatch");
  };
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const handlers = createActionHandlers(() => f.eda, {} as any);
  await expect(
    handlers.confirmedAction({ action: "mutation", confirmation: "CONFIRM", params: { mutationId: p.mutationId } })
  ).rejects.toThrow();
  expect(writes).toBe(0);
  const result: any = await handlers.confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  expect(result.status).toBe("unknown");
  try {
    await handlers.confirmedAction({
      action: "mutation",
      confirmation: p.confirmation,
      params: { mutationId: p.mutationId }
    });
  } catch {
    /* Consumed unknown mutations must not replay. */
  }
  expect(writes).toBe(1);
});
it("modifies only an owned empty-net rectangular Polyline", async () => {
  const f = fixture();
  const p: any = await preparePcbAnnotationMutation(() => f.eda, {
    items: [{ kind: "rectangle", layer: 13, x: 0, y: 0, width: 100, height: 50, lineWidth: 5 }]
  });
  const r = await executePcbAnnotationMutation(() => f.eda, extensionMutations.get(p.mutationId));
  const id = (r.readback.primitives as any[])[0].primitiveId;
  const edit: any = await preparePcbAnnotationMutation(() => f.eda, {
    action: "modify",
    kind: "rectangle",
    primitiveId: id,
    properties: { x: 20, width: 120 }
  });
  await executePcbAnnotationMutation(() => f.eda, extensionMutations.get(edit.mutationId));
  expect(f.values.get(id).getState_Net()).toBe("");
  expect(f.values.get(id).getState_Polygon().getSource()).toEqual([20, 0, "L", 140, 0, 140, 50, 20, 50, 20, 0]);
  f.values.get(id).getState_Net = () => "GND";
  await expect(
    preparePcbAnnotationMutation(() => f.eda, { action: "delete", kind: "rectangle", primitiveId: id })
  ).rejects.toThrow();
});
