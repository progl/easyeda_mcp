import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSchematicPages, prepareSchematicPage, executeSchematicPage } from "./schematicPages.js";
import { extensionMutations } from "./mutationManager.js";
import { pageFixture } from "./schematicPageFixture.js";
describe("schematic pages", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  it("lists page counts and restores focus", async () => {
    const f = pageFixture();
    const r = await listSchematicPages(f.api, { includeCounts: true });
    expect(r.pages.map((p: any) => p.componentCount)).toEqual([1, 0]);
    expect(f.active()).toBe("p1");
  });
  it("prepares creation without writing then verifies created page and name", async () => {
    const f = pageFixture();
    const p = await prepareSchematicPage(f.api, { action: "create", name: "pH" });
    expect(f.eda.dmt_Schematic.createSchematicPage).not.toHaveBeenCalled();
    const r = await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
    expect(r.readback).toMatchObject({ pageId: "p3", name: "pH", verified: true });
  });
  it("rejects a page outside the current schematic before writing", async () => {
    const f = pageFixture();
    await expect(prepareSchematicPage(f.api, { action: "rename", pageId: "foreign", name: "x" })).rejects.toThrow(
      /page|sheet/i
    );
    expect(f.eda.dmt_Schematic.modifySchematicPageName).not.toHaveBeenCalled();
  });
  it("rejects rename drift after preview", async () => {
    const f = pageFixture();
    const p = await prepareSchematicPage(f.api, { action: "rename", pageId: "p2", name: "new" });
    f.pages[1].name = "changed";
    await expect(executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow(
      /changed|stale/
    );
  });
  it("does not report success when native create returns no UUID", async () => {
    const f = pageFixture();
    f.eda.dmt_Schematic.createSchematicPage.mockResolvedValue(undefined);
    const p = await prepareSchematicPage(f.api, { action: "create", name: "pH" });
    await expect(executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api)).rejects.toThrow();
  });
});

import { prepareSchematicComponentMutation } from "./schematicComponentMutations.js";
it("exposes page preparation through the legacy component transport without changing a component", async () => {
  const f = pageFixture();
  const r = await prepareSchematicComponentMutation(f.api, {
    action: "update",
    component: "@schematic",
    properties: { page: { action: "create", name: "pH" } }
  });
  expect(r.action).toBe("schematicPage");
  expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
});

it("changes drawing dimensions and restores the original focus", async () => {
  const f = pageFixture();
  f.components.p2.push({
    primitiveId: "frame",
    componentType: "sheet",
    otherProperty: { "Page Size": "A4", Width: "1170", Height: "825" }
  });
  const p = await prepareSchematicPage(f.api, { action: "format", pageId: "p2", format: "A3" });
  await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
  expect(f.components.p2[0].otherProperty).toMatchObject({ "Page Size": "A3", Width: "1654", Height: "1170" });
  expect(f.active()).toBe("p1");
});
it("accepts EasyEDA's canonical lowercase page names without claiming a failed write", async () => {
  const f = pageFixture();
  f.eda.dmt_Schematic.modifySchematicPageName.mockImplementation(async (id: string, name: string) => {
    f.pages.find((p) => p.uuid === id).name = name.toLowerCase();
    return true;
  });
  const p = await prepareSchematicPage(f.api, { action: "create", name: "pH_ISOLATED" });
  const r = await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
  expect(r.readback).toMatchObject({ name: "ph_isolated", verified: true });
});

it("uses native title-block API for sheet formatting instead of modifying a part", async () => {
  const f = pageFixture();
  f.components.p2.push({
    primitiveId: "frame",
    componentType: "sheet",
    otherProperty: { "Page Size": "A4", Width: "1170", Height: "825" }
  });
  f.eda.dmt_Schematic.modifySchematicPageTitleBlock = vi.fn(async (_show: any, data: any) => {
    Object.assign(f.components.p2[0].otherProperty, { "Page Size": data.Size.value, Width: "2339", Height: "1654" });
    return true;
  });
  f.eda.sch_PrimitiveComponent.modify.mockRejectedValue(new Error("Only part components may be modified"));
  const p = await prepareSchematicPage(f.api, { action: "format", pageId: "p2", format: "A2" });
  const result = await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
  expect(result.readback.verified).toBe(true);
  expect(f.eda.dmt_Schematic.modifySchematicPageTitleBlock).toHaveBeenCalledWith(undefined, {
    Size: { showTitle: false, showValue: false, value: "A2" }
  });
  expect(f.eda.sch_PrimitiveComponent.modify).not.toHaveBeenCalled();
  expect(f.active()).toBe("p1");
});
it("waits for deferred native rename readback without repeating the write", async () => {
  const f = pageFixture();
  const original = f.eda.dmt_Schematic.getSchematicPageInfo;
  let stale = 0;
  f.eda.dmt_Schematic.getSchematicPageInfo = vi.fn(async (id: string) => {
    const p = await original(id);
    return ++stale === 1 ? { ...p, name: "old" } : p;
  });
  const p = await prepareSchematicPage(f.api, { action: "rename", pageId: "p2", name: "DOSERS" });
  const r = await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
  expect(r.readback.name).toBe("DOSERS");
  expect(f.eda.dmt_Schematic.modifySchematicPageName).toHaveBeenCalledTimes(1);
});

it("verifies native rounded A2 dimensions even if the legacy Page Size attribute is stale", async () => {
  const f = pageFixture();
  f.components.p2.push({
    primitiveId: "frame",
    componentType: "sheet",
    otherProperty: { "Page Size": "A4", Width: "1170", Height: "825" }
  });
  f.eda.dmt_Schematic.modifySchematicPageTitleBlock = vi.fn(async () => {
    Object.assign(f.components.p2[0].otherProperty, { Width: "2338", Height: "1652" });
    return true;
  });
  const p = await prepareSchematicPage(f.api, { action: "format", pageId: "p2", format: "A2" });
  const r = await executeSchematicPage(extensionMutations.get(String(p.mutationId)), f.api);
  expect(r.readback).toMatchObject({ format: "A2", verified: true });
  const listed = await listSchematicPages(f.api, { includeCounts: true });
  expect(listed.pages.find((p: any) => p.pageId === "p2").format).toBe("A2");
});
