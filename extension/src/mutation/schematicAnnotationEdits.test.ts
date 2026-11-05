import { beforeEach, expect, it, vi } from "vitest";
import { createSchematicHandlers } from "../handlers/schematicHandlers.js";
import { pageFixture } from "./schematicPageFixture.js";
import { prepareSchematicComponentMutation } from "./schematicComponentMutations.js";
import {
  compareAnnotationStates,
  executeSchematicAnnotation,
  getSchematicAnnotationInventory
} from "./schematicLayout.js";
import { extensionMutations } from "./mutationManager.js";
const target = { projectId: "project", documentId: "p1", documentType: "schematic" };
const guards = { target, expectedBoardName: "upper", protectedBoardName: "Board1" };
function fixture() {
  const f = pageFixture();
  const texts = [
    { primitiveId: "heading", x: 10, y: 20, content: "Old lower", fontSize: 12, bold: false },
    { primitiveId: "keep", x: 20, y: 30, content: "Keep", fontSize: 10, bold: true }
  ];
  const rectangles = [
    { primitiveId: "frame", topLeftX: 5, topLeftY: 5, width: 100, height: 100, lineWidth: 1, fillColor: "none" }
  ];
  const b = (name: string, sch: string, pages: any[]) => ({
    name,
    parentProjectUuid: "project",
    schematic: { uuid: sch, name: sch, parentProjectUuid: "project", page: pages },
    pcb: { uuid: name + "pcb", name: name + "pcb", parentProjectUuid: "project" }
  });
  const boards = [
    b("upper", "sch", f.pages),
    b("Board1", "original", [{ uuid: "originalpage", name: "Original", parentSchematicUuid: "original" }])
  ];
  f.eda.dmt_Project = { getCurrentProjectInfo: async () => ({ uuid: "project" }) };
  f.eda.dmt_Board = { getAllBoardsInfo: async () => boards, getCurrentBoardInfo: async () => boards[0] };
  f.eda.sch_ManufactureData = { getNetlistFile: vi.fn(async () => ({ text: async () => "(\nGND\nR1-1\n)" })) };
  f.eda.sch_PrimitiveComponent.getAll = vi.fn(f.eda.sch_PrimitiveComponent.getAll);
  for (const [type, items] of [
    ["Text", texts],
    ["Rectangle", rectangles]
  ] as const) {
    f.eda["sch_Primitive" + type] = {
      getAll: vi.fn(async () => items),
      modify: vi.fn(async (id: string, patch: any) =>
        Object.assign(
          items.find((v: any) => v.primitiveId === id)!,
          patch
        )
      ),
      delete: vi.fn(async (id: string) => {
        const i = items.findIndex((v: any) => v.primitiveId === id);
        if (i < 0) return false;
        items.splice(i, 1);
        return true;
      })
    };
  }
  const prepare = (annotation: any) =>
    prepareSchematicComponentMutation(f.api, {
      action: "update",
      component: "@schematic",
      target,
      properties: { annotation }
    });
  return { ...f, texts, rectangles, boards, prepare };
}
beforeEach(() => extensionMutations.invalidateAll());
const record = (p: any) => extensionMutations.get(p.mutationId);
it("modifies only explicit heading fields and preserves kept decorations, parts, wires and pins", async () => {
  const f = fixture();
  const p = await f.prepare({
    ...guards,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Upper sensors" }]
  });
  expect(f.eda.sch_PrimitiveText.modify).not.toHaveBeenCalled();
  const result = await executeSchematicAnnotation(record(p), f.api);
  expect(result.readback).toMatchObject({
    verified: true,
    electricalPrimitivesUnchanged: true,
    nativeConnectivityVerified: true,
    keptDecorationsPreserved: true,
    saved: false
  });
  expect(f.eda.sch_PrimitiveText.modify).toHaveBeenCalledExactlyOnceWith("heading", { content: "Upper sensors" });
  expect(f.texts[0]).toMatchObject({ content: "Upper sensors", x: 10, y: 20, fontSize: 12, bold: false });
  expect(f.texts[1].content).toBe("Keep");
  expect(f.eda.sch_PrimitiveComponent.getAll.mock.calls.every((c: any[]) => c[1] === false)).toBe(true);
});
it.each(["text", "rectangle"])("deletes explicit %s once and preserves all other decorations", async (type) => {
  const f = fixture();
  const id = type === "text" ? "heading" : "frame";
  const p = await f.prepare({ ...guards, action: "delete", items: [{ type, primitiveId: id }] });
  const result = await executeSchematicAnnotation(record(p), f.api);
  expect(result.readback.verified).toBe(true);
  expect(
    f.eda[type === "text" ? "sch_PrimitiveText" : "sch_PrimitiveRectangle"].delete
  ).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.texts.some((t) => t.primitiveId === "keep")).toBe(true);
});
it.each([
  { target: undefined },
  { expectedBoardName: undefined },
  { protectedBoardName: undefined },
  { expectedBoardName: "Board1" },
  { target: { ...target, documentId: "p2" } }
])("refuses missing or wrong explicit edit guard %j", async (delta) => {
  const f = fixture();
  await expect(
    f.prepare({ ...guards, ...delta, action: "delete", items: [{ type: "text", primitiveId: "heading" }] })
  ).rejects.toBeDefined();
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
});
it.each([
  { items: [{ type: "text", primitiveId: "c1" }], code: "annotation_not_found" },
  { items: [{ type: "rectangle", primitiveId: "heading" }], code: "annotation_not_found" },
  {
    items: [
      { type: "text", primitiveId: "heading" },
      { type: "text", primitiveId: "heading" }
    ],
    code: "invalid_params"
  }
])("refuses electrical/wrong-type/duplicate IDs %j", async ({ items, code }) => {
  const f = fixture();
  await expect(f.prepare({ ...guards, action: "delete", items })).rejects.toMatchObject({ code });
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
});

it("refuses stale kept decoration before delete", async () => {
  const f = fixture();
  const p = await f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] });
  f.texts[1].content = "Changed";
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({ code: "stale_mutation" });
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
});
it.each(["false", "other-decoration", "wire", "native"])(
  "keeps outcome unknown without replay after %s failure",
  async (mode) => {
    const f = fixture();
    const p = await f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] });
    f.eda.sch_PrimitiveText.delete.mockImplementation(async () => {
      f.texts.splice(0, 1);
      if (mode === "other-decoration") f.texts[0].content = "Unexpected";
      if (mode === "wire") f.wires.p1[0].net = "VCC";
      if (mode === "native")
        f.eda.sch_ManufactureData.getNetlistFile.mockResolvedValue({ text: async () => "(\nVCC\nR1-1\n)" });
      return mode !== "false";
    });
    await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({
      code: "write_readback_unknown"
    });
    expect(f.eda.sch_PrimitiveText.delete).toHaveBeenCalledTimes(1);
  }
);

it.each(["texts", "rectangles", "parts", "wires"])(
  "refuses unavailable %s list instead of inventing empty preservation",
  async (kind) => {
    const f = fixture();
    if (kind === "texts") f.eda.sch_PrimitiveText.getAll.mockResolvedValue(undefined);
    if (kind === "rectangles") f.eda.sch_PrimitiveRectangle.getAll.mockResolvedValue(undefined);
    if (kind === "parts") f.eda.sch_PrimitiveComponent.getAll.mockResolvedValue(undefined);
    if (kind === "wires") f.eda.sch_PrimitiveWire.getAll = async () => undefined;
    await expect(
      f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] })
    ).rejects.toMatchObject({ code: "unverified_inventory" });
    expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
  }
);
it("modifies a rectangle through native top-left keys and preserves its style", async () => {
  const f = fixture();
  const p = await f.prepare({
    ...guards,
    action: "modify",
    items: [{ type: "rectangle", primitiveId: "frame", x: 15, width: 120 }]
  });
  await executeSchematicAnnotation(record(p), f.api);
  expect(f.eda.sch_PrimitiveRectangle.modify).toHaveBeenCalledExactlyOnceWith("frame", { topLeftX: 15, width: 120 });
  expect(f.rectangles[0]).toMatchObject({
    topLeftX: 15,
    topLeftY: 5,
    width: 120,
    height: 100,
    lineWidth: 1,
    fillColor: "none"
  });
});
it("detects changed electrical pin position before a write", async () => {
  const f = fixture();
  const p = await f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] });
  f.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => [
    { primitiveId: "c1-1", pinNumber: "1", x: 999, y: 100, rotation: 180 }
  ];
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({ code: "stale_mutation" });
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
});

const persistenceMode = "legacy32TransactionalTextReplace";
function compatibilityFixture() {
  const f = fixture();
  for (const text of f.texts)
    Object.assign(text, {
      rotation: 0,
      textColor: "#123456",
      fontName: null,
      italic: false,
      underLine: false,
      alignMode: 2
    });
  f.eda.sys_Environment = { getEditorCurrentVersion: vi.fn(() => "3.2.209") };
  f.eda.sch_PrimitiveText.get = vi.fn(async (id: string) => {
    const text = f.texts.find((t) => t.primitiveId === id);
    return text && { ...text, alignMode: 1 };
  });
  f.eda.sch_PrimitiveText.create = vi.fn(
    async (x, y, content, rotation, textColor, fontName, fontSize, bold, italic, underLine, alignMode) => {
      const item = {
        primitiveId: "replacement-1",
        x,
        y,
        content,
        rotation,
        textColor,
        fontName,
        fontSize,
        bold,
        italic,
        underLine,
        alignMode: [0, 2, 4, 6, 3, 5, 7, 4, 6, 8][alignMode]
      };
      f.texts.push(item);
      return item;
    }
  );
  f.eda.sch_PrimitiveCircle = {
    delete: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        const i = f.texts.findIndex((t) => t.primitiveId === id);
        if (i < 0) return false;
        f.texts.splice(i, 1);
      }
      return true;
    })
  };
  return f;
}
it("explicit compatibility modify creates a full-style replacement before transactional old-ID delete", async () => {
  const f = compatibilityFixture();
  const old: any = structuredClone(f.texts[0]);
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Upper title", bold: false, x: 0 }]
  });
  expect((p.preview as any).impact).toMatch(/runtime|3\.2|Circle/i);
  const result = await executeSchematicAnnotation(record(p), f.api);
  expect(f.eda.sch_PrimitiveText.create).toHaveBeenCalledExactlyOnceWith(
    0,
    old.y,
    "Upper title",
    old.rotation,
    old.textColor,
    old.fontName,
    old.fontSize,
    false,
    old.italic,
    old.underLine,
    1
  );
  expect(f.eda.sch_PrimitiveCircle.delete).toHaveBeenCalledExactlyOnceWith(["heading"]);
  expect(f.eda.sch_PrimitiveText.modify).not.toHaveBeenCalled();
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
  expect(f.texts.map((t) => t.primitiveId).sort()).toEqual(["keep", "replacement-1"]);
  expect(result.readback).toMatchObject({
    verified: true,
    saved: false,
    persistence: false,
    persistenceVerified: false,
    journal: [{ oldId: "heading", newId: "replacement-1" }]
  });
});
it("explicit compatibility delete uses exact reviewed text IDs, rectangle deletion remains ordinary", async () => {
  const f = compatibilityFixture();
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "delete",
    items: [
      { type: "text", primitiveId: "heading" },
      { type: "rectangle", primitiveId: "frame" }
    ]
  });
  await executeSchematicAnnotation(record(p), f.api);
  expect(f.eda.sch_PrimitiveCircle.delete).toHaveBeenCalledExactlyOnceWith(["heading"]);
  expect(f.eda.sch_PrimitiveRectangle.delete).toHaveBeenCalledExactlyOnceWith("frame");
  expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
});
it.each(["4.1.1", "3.2.210", undefined])("refuses unverified runtime %j for compatibility mode", async (version) => {
  const f = compatibilityFixture();
  f.eda.sys_Environment.getEditorCurrentVersion.mockReturnValue(version);
  await expect(
    f.prepare({ ...guards, persistenceMode, action: "delete", items: [{ type: "text", primitiveId: "heading" }] })
  ).rejects.toBeDefined();
  expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
});
it("refuses incomplete original style before creation", async () => {
  const f = compatibilityFixture();
  delete (f.texts[0] as any).fontName;
  await expect(
    f.prepare({
      ...guards,
      persistenceMode,
      action: "modify",
      items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
    })
  ).rejects.toBeDefined();
  expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
});
it("never deletes old text if replacement geometry/style is wrong", async () => {
  const f = compatibilityFixture();
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
  });
  const create = f.eda.sch_PrimitiveText.create.getMockImplementation();
  f.eda.sch_PrimitiveText.create.mockImplementation(async (...args: any[]) => {
    const t = await create(...args);
    t.rotation = 90;
    return t;
  });
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({ code: "write_readback_unknown" });
  expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
  expect(f.texts.some((t) => t.primitiveId === "heading")).toBe(true);
});
it("partial transactional delete failure keeps old/new ID journal without cleanup or replay", async () => {
  const f = compatibilityFixture();
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
  });
  f.eda.sch_PrimitiveCircle.delete.mockResolvedValue(false);
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({
    code: "write_readback_unknown",
    message: expect.stringContaining("replacement-1")
  });
  expect(f.eda.sch_PrimitiveText.create).toHaveBeenCalledTimes(1);
  expect(f.eda.sch_PrimitiveCircle.delete).toHaveBeenCalledTimes(1);
  expect(f.texts.some((t) => t.primitiveId === "heading")).toBe(true);
});

it("reads exact free annotation IDs/styles without staging or mutating", async () => {
  const f = compatibilityFixture();
  const result = await getSchematicAnnotationInventory(f.api, guards);
  expect(result).toMatchObject({
    target: { documentId: "p1" },
    readOnly: true,
    persistenceVerified: false,
    units: "10mil",
    texts: [{ primitiveId: "heading", content: "Old lower" }, { primitiveId: "keep" }],
    rectangles: [{ primitiveId: "frame" }]
  });
  const routed = await createSchematicHandlers(f.api).getSchematicAnnotationInventory(guards);
  expect(routed).toMatchObject({ readOnly: true, texts: result.texts, rectangles: result.rectangles });
  expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
  expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
});

it("awaits hung replacement creation and keeps lifecycle lock; late completion never deletes old text", async () => {
  const f = compatibilityFixture();
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
  });
  const r = record(p);
  const create = f.eda.sch_PrimitiveText.create.getMockImplementation();
  let finish!: () => Promise<void>;
  f.eda.sch_PrimitiveText.create.mockImplementation(
    (...args: any[]) =>
      new Promise((resolve) => {
        finish = async () => {
          resolve(await create(...args));
        };
      })
  );
  vi.useFakeTimers();
  try {
    const pending = extensionMutations.apply({
      mutationId: String(p.mutationId),
      confirmation: String(p.confirmation),
      currentTarget: r.target,
      currentBefore: r.before,
      execute: async () => {
        const result = await executeSchematicAnnotation(r, f.api);
        return result.executed;
      },
      readback: async () => ({})
    });
    for (let i = 0; i < 1500 && !finish; i++) await Promise.resolve();
    expect(finish).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(45001);
    expect((await pending).status).toBe("unknown");
    expect(record(p).execution?.lockHeld).toBe(true);
    expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
    await finish();
    for (let i = 0; i < 1500 && record(p).execution?.lockHeld; i++) await Promise.resolve();
    expect(record(p).execution?.lockHeld).toBe(false);
    expect(record(p).status).toBe("unknown");
    expect(f.eda.sch_PrimitiveText.create).toHaveBeenCalledTimes(1);
    expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
    expect(f.texts.some((t) => t.primitiveId === "heading")).toBe(true);
    expect(f.texts.some((t) => t.primitiveId === "replacement-1")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
  "preserves bundled getAll alignment using exact get enum %i",
  async (alignment) => {
    const f = compatibilityFixture();
    const raw = [0, 2, 4, 6, 3, 5, 7, 4, 6, 8][alignment];
    Object.assign(f.texts[0], { alignMode: raw });
    f.eda.sch_PrimitiveText.get.mockImplementation(async (id: string) => ({
      ...f.texts.find((t) => t.primitiveId === id),
      alignMode: alignment
    }));
    const p = await f.prepare({
      ...guards,
      persistenceMode,
      action: "modify",
      items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
    });
    await executeSchematicAnnotation(record(p), f.api);
    expect(f.eda.sch_PrimitiveText.create.mock.calls[0][10]).toBe(alignment);
    expect(f.texts.find((t) => t.primitiveId === "replacement-1")).toMatchObject({ alignMode: raw });
  }
);
it("refuses an inconsistent exact alignment before creating replacement", async () => {
  const f = compatibilityFixture();
  f.eda.sch_PrimitiveText.get.mockImplementation(async () => ({ ...f.texts[0], alignMode: 2 }));
  await expect(
    f.prepare({
      ...guards,
      persistenceMode,
      action: "modify",
      items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
    })
  ).rejects.toBeDefined();
  expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
});

it("refuses ambiguous alignment change after preview before creation", async () => {
  const f = compatibilityFixture();
  Object.assign(f.texts[0], { alignMode: 4 });
  f.eda.sch_PrimitiveText.get.mockImplementation(async () => ({ ...f.texts[0], alignMode: 2 }));
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
  });
  f.eda.sch_PrimitiveText.get.mockImplementation(async () => ({ ...f.texts[0], alignMode: 7 }));
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({ code: "write_readback_unknown" });
  expect(f.eda.sch_PrimitiveText.create).not.toHaveBeenCalled();
});
it("retains old text when new exact alignment disagrees despite identical aggregate value", async () => {
  const f = compatibilityFixture();
  Object.assign(f.texts[0], { alignMode: 4 });
  f.eda.sch_PrimitiveText.get.mockImplementation(async (id: string) => ({
    ...f.texts.find((t) => t.primitiveId === id),
    alignMode: id === "replacement-1" ? 7 : 2
  }));
  const p = await f.prepare({
    ...guards,
    persistenceMode,
    action: "modify",
    items: [{ type: "text", primitiveId: "heading", text: "Changed" }]
  });
  await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({ code: "write_readback_unknown" });
  expect(f.eda.sch_PrimitiveCircle.delete).not.toHaveBeenCalled();
});

function addCurrentFrame(f: ReturnType<typeof fixture>) {
  const frame: any = {
    primitiveId: "sheet-frame",
    componentType: "sheet",
    otherProperty: { "@Update Date": "2026-11-05", "@Update Time": "01:00:00", Title: "Original" }
  };
  const get = f.eda.sch_PrimitiveComponent.getAll;
  f.eda.sch_PrimitiveComponent.getAll = vi.fn(async (...args: any[]) => [...(await get(...args)), frame]);
  return frame;
}
it("audits only unique current-page frame derived times before and after annotation write", async () => {
  const f = fixture(),
    frame = addCurrentFrame(f);
  const p = await f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] });
  frame.otherProperty["@Update Time"] = "02:00:00";
  const remove = f.eda.sch_PrimitiveText.delete.getMockImplementation();
  f.eda.sch_PrimitiveText.delete.mockImplementation(async (id: string) => {
    frame.otherProperty["@Update Time"] = "03:00:00";
    return remove(id);
  });
  const r = await executeSchematicAnnotation(record(p), f.api);
  expect((p.preview as any).requestedAfter.derivedMetadataDiffs).toEqual([]);
  expect((r.readback as any).derivedMetadataDiffs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ primitiveId: "sheet-frame", before: "01:00:00", after: "02:00:00" }),
      expect.objectContaining({ primitiveId: "sheet-frame", before: "02:00:00", after: "03:00:00" })
    ])
  );
});
it.each(["title", "part", "invalid", "newProperty", "differentId", "ambiguousFrame", "wire"])(
  "rejects %s drift with bounded actual diff before write",
  async (kind) => {
    const f = fixture(),
      frame = addCurrentFrame(f);
    if (kind === "newProperty") delete frame.otherProperty["@Update Time"];
    if (kind === "ambiguousFrame") {
      const get = f.eda.sch_PrimitiveComponent.getAll;
      f.eda.sch_PrimitiveComponent.getAll = vi.fn(async (...args: any[]) => [
        ...(await get(...args)),
        { ...frame, primitiveId: "another-frame" }
      ]);
    }
    const p = await f.prepare({ ...guards, action: "delete", items: [{ type: "text", primitiveId: "heading" }] });
    if (kind === "title") frame.otherProperty.Title = "Changed";
    else if (kind === "differentId") frame.primitiveId = "new-frame";
    else if (kind === "part") frame.componentType = "part";
    else if (kind === "wire") f.wires[f.active()][0].net = "CHANGED";
    else frame.otherProperty["@Update Time"] = kind === "invalid" ? "bad-time" : "02:00:00";
    await expect(executeSchematicAnnotation(record(p), f.api)).rejects.toMatchObject({
      code: "stale_mutation",
      message: expect.stringMatching(/Differences=/)
    });
    expect(f.eda.sch_PrimitiveText.delete).not.toHaveBeenCalled();
  }
);

it.each([
  "wrongPage",
  "missingContext",
  "differentRef",
  "newProperty",
  "invalidDate",
  "invalidTime",
  "part",
  "protectedBoard"
])("comparison keeps %s strict", (kind) => {
  const a: any = {
    scope: {
      documentId: "page",
      boardName: "upper",
      schematicUuid: "sch",
      boards: [{ name: "upper", schematic: { uuid: "sch", pages: [{ uuid: "page" }, { uuid: "other-page" }] } }]
    },
    electrical: {
      components: [
        {
          primitiveId: "frame",
          componentType: "sheet",
          ref: "original",
          otherProperty: { "@Update Date": "2026-11-05", "@Update Time": "01:00:00" }
        }
      ]
    }
  };
  if (kind === "newProperty") delete a.electrical.components[0].otherProperty["@Update Time"];
  if (kind === "missingContext") a.scope.boards = [];
  if (kind === "part") a.electrical.components[0].componentType = "part";
  const b = structuredClone(a);
  b.electrical.components[0].otherProperty["@Update Time"] = "02:00:00";
  if (kind === "differentRef") b.electrical.components[0].ref = "changed";
  if (kind === "invalidTime") b.electrical.components[0].otherProperty["@Update Time"] = "25:00:00";
  if (kind === "invalidDate") b.electrical.components[0].otherProperty["@Update Date"] = "2026-02-30";
  if (kind === "protectedBoard") b.scope.boards.push({ name: "Board1", changed: true });
  const r = compareAnnotationStates(a, b, kind === "wrongPage" ? "other-page" : "page");
  expect(r.equal).toBe(false);
  expect(r.differences.length).toBeGreaterThan(0);
  expect(r.differences.length).toBeLessThanOrEqual(8);
});
