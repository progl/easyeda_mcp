import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  findComponentInSchematic,
  prepareSchematicComponentMutation,
  executeSchematicComponentMutation
} from "./schematicComponentMutations.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";

describe("Schematic Component Mutations", () => {
  beforeEach(() => {
    extensionMutations.invalidateAll();
  });

  describe("findComponentInSchematic", () => {
    it("resolves only current-page parts when copied boards reuse IDs and designators", async () => {
      const other = { primitiveId: "shared-id", designator: "U_WEIGHT", x: 10, y: 20 };
      const current = { primitiveId: "shared-id", designator: "U_WEIGHT", x: 550, y: 400 };
      const getAll = vi.fn(async (_: unknown, allPages: boolean) => (allPages ? [other, current] : [current]));
      const api = () => ({ sch_PrimitiveComponent: { getAll } });
      expect((await findComponentInSchematic(api, "shared-id")).x).toBe(550);
      expect((await findComponentInSchematic(api, "U_WEIGHT")).y).toBe(400);
      expect(getAll).toHaveBeenCalledWith(undefined, false);
    });

    it("resolves component by primitiveId and by designator case-insensitively", async () => {
      const api = () => ({
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => [
            { primitiveId: "prim-1", designator: "R1", x: 100, y: 200, value: "10k" },
            { id: "prim-2", name: "U1", x: 500, y: 600, comment: "ESP32" }
          ])
        }
      });

      const byId = await findComponentInSchematic(api, "prim-1");
      expect(byId.primitiveId).toBe("prim-1");
      expect(byId.designator).toBe("R1");
      expect(byId.x).toBe(100);

      const byDesignator = await findComponentInSchematic(api, "r1");
      expect(byDesignator.primitiveId).toBe("prim-1");

      const byU1 = await findComponentInSchematic(api, "u1");
      expect(byU1.primitiveId).toBe("prim-2");
      expect(byU1.designator).toBe("U1");
    });

    it("throws component_not_found if component does not exist", async () => {
      const api = () => ({
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => [])
        }
      });

      await expect(findComponentInSchematic(api, "C99")).rejects.toThrow(/was not found/);
    });
  });

  describe("prepareSchematicComponentMutation", () => {
    const mockSchematicApi =
      (components: any[] = []) =>
      () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-doc-1",
            name: "Sheet1.SchDoc",
            documentType: 1
          }))
        },
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => components)
        }
      });

    it("prepares a create component mutation with preview and confirmation", async () => {
      const api = mockSchematicApi();
      const result = await prepareSchematicComponentMutation(api, {
        action: "create",
        device: "C1523",
        x: 1500,
        y: 2500,
        designator: "R1"
      });

      expect(result.mutationId).toBeDefined();
      expect(result.confirmation).toBe(`CONFIRM schematic:createComponent ${result.mutationId}`);
      expect(result.preview).toMatchObject({
        requestedAfter: {
          device: "C1523",
          x: 1500,
          y: 2500,
          designator: "R1"
        },
        changedKeys: ["device", "x", "y", "designator"]
      });
    });

    it("prepares a move component mutation with relative deltas", async () => {
      const api = mockSchematicApi([{ primitiveId: "prim-1", designator: "R1", x: 100, y: 200 }]);

      const result = await prepareSchematicComponentMutation(api, {
        action: "move",
        component: "R1",
        dx: 50,
        dy: -20
      });

      expect(result.preview).toMatchObject({
        before: { x: 100, y: 200 },
        requestedAfter: { x: 150, y: 180 },
        changedKeys: ["x", "y"]
      });
    });

    it("prepares an update component mutation", async () => {
      const api = mockSchematicApi([{ primitiveId: "prim-1", designator: "R1", x: 100, y: 200, value: "10k" }]);

      const result = await prepareSchematicComponentMutation(api, {
        action: "update",
        component: "R1",
        value: "22k",
        designator: "R2"
      });

      expect(result.preview).toMatchObject({
        before: { designator: "R1", value: "10k" },
        requestedAfter: { designator: "R2", value: "22k" },
        changedKeys: expect.arrayContaining(["designator", "value"])
      });
    });

    it("prepares a delete component mutation", async () => {
      const api = mockSchematicApi([{ primitiveId: "prim-1", designator: "R1", x: 100, y: 200 }]);

      const result = await prepareSchematicComponentMutation(api, {
        action: "delete",
        component: "prim-1"
      });

      expect(result.preview).toMatchObject({
        before: { primitiveId: "prim-1", designator: "R1" },
        requestedAfter: null,
        changedKeys: ["deleted"]
      });
    });

    it("rejects when active document is not schematic", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        }
      });

      await expect(
        prepareSchematicComponentMutation(api, { action: "create", device: "C1", x: 0, y: 0 })
      ).rejects.toThrow(/Schematic component mutations require an active schematic document/);
    });

    it("rejects when document target does not match", async () => {
      const api = mockSchematicApi();
      await expect(
        prepareSchematicComponentMutation(api, {
          action: "create",
          device: "C1",
          x: 0,
          y: 0,
          target: { documentId: "other-doc" }
        })
      ).rejects.toThrow(/Active document ID changed/);
    });
  });

  describe("executeSchematicComponentMutation & ActionHandler integration", () => {
    it.each([true, false])(
      "assigns explicit uniqueId with one modify and independent readback (persist=%s)",
      async (persist) => {
        let row: any;
        const modify = vi.fn(async (_id, patch) => {
          if (persist) Object.assign(row, patch);
        });
        const create = vi.fn(async () => {
          row = { primitiveId: "created", x: 1, y: 2, uniqueId: "" };
          return { primitiveId: "created", uniqueId: "requested" };
        });
        const api = () => ({
          dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "sch-doc-1", documentType: 1 }) },
          sch_PrimitiveComponent: { create, modify, getAll: async () => (row ? [row] : []) }
        });
        const prep = await prepareSchematicComponentMutation(api, {
          action: "create",
          device: { uuid: "a".repeat(32), libraryUuid: "b".repeat(32) },
          x: 1,
          y: 2,
          uniqueId: "requested",
          designator: "R9"
        });
        expect((prep.preview as any).requestedAfter.uniqueId).toBe("requested");
        const handlers = createActionHandlers(api, new DrcRules(api));
        const result: any = await handlers.confirmedAction({
          action: "mutation",
          confirmation: prep.confirmation,
          params: { mutationId: prep.mutationId }
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(modify).toHaveBeenCalledExactlyOnceWith("created", { designator: "R9", uniqueId: "requested" });
        expect(result.status).toBe(persist ? "applied" : "unknown");
        if (persist) expect(result.after.uniqueId).toBe("requested");
        else {
          await Promise.resolve(
            handlers.confirmedAction({
              action: "mutation",
              confirmation: prep.confirmation,
              params: { mutationId: prep.mutationId }
            })
          ).catch(() => {});
          expect(create).toHaveBeenCalledTimes(1);
        }
      }
    );

    it.each([true])(
      "reads public getter when sandbox Function constructor is unavailable (persist=%s)",
      async (persist) => {
        let row: any;
        const modify = vi.fn(async (_id, patch) => {
          if (persist) Object.assign(row, patch);
        });
        const create = vi.fn(async () => {
          row = {
            primitiveId: "created",
            x: 1,
            y: 2,
            uniqueId: "",
            getState_UniqueId() {
              return this.uniqueId;
            }
          };
          return { primitiveId: "created", uniqueId: "requested" };
        });
        const api = () => ({
          dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "sch-doc-1", documentType: 1 }) },
          sch_PrimitiveComponent: { create, modify, getAll: async () => (row ? [row] : []) }
        });
        const prep = await prepareSchematicComponentMutation(api, {
          action: "create",
          device: { uuid: "a".repeat(32), libraryUuid: "b".repeat(32) },
          x: 1,
          y: 2,
          uniqueId: "requested",
          designator: "R9"
        });
        expect((prep.preview as any).requestedAfter.uniqueId).toBe("requested");
        const handlers = createActionHandlers(api, new DrcRules(api));
        const nativeFunction = globalThis.Function;
        let result: any;
        try {
          (globalThis as any).Function = undefined;
          result = await handlers.confirmedAction({
            action: "mutation",
            confirmation: prep.confirmation,
            params: { mutationId: prep.mutationId }
          });
        } finally {
          globalThis.Function = nativeFunction;
        }
        expect(create).toHaveBeenCalledTimes(1);
        expect(modify).toHaveBeenCalledExactlyOnceWith("created", { designator: "R9", uniqueId: "requested" });
        expect(result.status).toBe(persist ? "applied" : "unknown");
        if (persist) expect(result.after.uniqueId).toBe("requested");
        else {
          await Promise.resolve(
            handlers.confirmedAction({
              action: "mutation",
              confirmation: prep.confirmation,
              params: { mutationId: prep.mutationId }
            })
          ).catch(() => {});
          expect(create).toHaveBeenCalledTimes(1);
        }
      }
    );

    it("executes createComponent mutation and verifies readback", async () => {
      let createdDoc: any = null;
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-doc-1",
            name: "Sheet1.SchDoc",
            documentType: 1
          }))
        },
        lib_Device: {
          search: vi.fn(async () => [
            {
              uuid: "710b598d5efc4c77bd86ae62b6b33075",
              libraryUuid: "0819f05c4eef4c71ace90d822a990e87",
              name: "10k 0603"
            }
          ])
        },
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => (createdDoc ? [createdDoc] : [])),
          create: vi.fn(async (device, x, y) => {
            createdDoc = { primitiveId: "prim-new-1", designator: "R10", x, y };
            return { getState_PrimitiveId: () => "prim-new-1" };
          }),
          modify: vi.fn(async (id, props) => {
            if (createdDoc) Object.assign(createdDoc, props);
          }),
          get: vi.fn(async (id) => (createdDoc?.primitiveId === id ? createdDoc : null))
        }
      });

      // 1. Prepare
      const prep = await prepareSchematicComponentMutation(api, {
        action: "create",
        device: "10k 0603",
        x: 1000,
        y: 2000,
        designator: "R10"
      });

      // 2. Apply via actionHandlers
      const actionHandlers = createActionHandlers(api, new DrcRules(api));
      const res = (await actionHandlers.confirmedAction({
        action: "mutation",
        confirmation: prep.confirmation,
        params: { mutationId: prep.mutationId }
      })) as any;

      expect(res.status).toBe("applied");
      expect(res.documentSaved).toBe(false);
      expect(res.after).toMatchObject({
        primitiveId: "prim-new-1",
        designator: "R10",
        x: 1000,
        y: 2000,
        verified: true
      });

      // 3. Query result via getMutationResult
      const queryRes = actionHandlers.getMutationResult({ mutationId: prep.mutationId }) as any;
      expect(queryRes.status).toBe("applied");
      expect(queryRes.after.verified).toBe(true);
    });

    it("executes moveComponent mutation and verifies readback position", async () => {
      const comp = { primitiveId: "prim-1", designator: "R1", x: 100, y: 200 };
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-doc-1",
            documentType: 1
          }))
        },
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => [comp]),
          modify: vi.fn(async (id, props) => {
            if (props.x !== undefined) comp.x = props.x;
            if (props.y !== undefined) comp.y = props.y;
          })
        }
      });

      const prep = await prepareSchematicComponentMutation(api, {
        action: "move",
        component: "R1",
        x: 350,
        y: 450
      });

      const record = extensionMutations.get(String(prep.mutationId));
      const exec = await executeSchematicComponentMutation(record, api);

      expect(exec.executed).toBe(true);
      expect(exec.readback).toMatchObject({
        primitiveId: "prim-1",
        x: 350,
        y: 450,
        verified: true
      });
      expect(comp.x).toBe(350);
      expect(comp.y).toBe(450);
    });

    it("executes deleteComponent and verifies absence in readback", async () => {
      let components = [{ primitiveId: "prim-del", designator: "U5", x: 0, y: 0 }];
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-doc-1",
            documentType: 1
          }))
        },
        sch_PrimitiveComponent: {
          getAll: vi.fn(async () => components),
          delete: vi.fn(async () => {
            components = [];
          })
        }
      });

      const prep = await prepareSchematicComponentMutation(api, {
        action: "delete",
        component: "U5"
      });

      const record = extensionMutations.get(String(prep.mutationId));
      const exec = await executeSchematicComponentMutation(record, api);

      expect(exec.executed).toBe(true);
      expect(exec.readback).toMatchObject({
        primitiveId: "prim-del",
        deleted: true,
        verified: true
      });
      expect(components).toHaveLength(0);
    });
  });
  it("rejects a cached project component reference before SDK create or library lookup", async () => {
    const create = vi.fn(),
      get = vi.fn(),
      api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: async () => ({ uuid: "sch", parentProjectUuid: "p", documentType: 1 })
        },
        sch_PrimitiveComponent: { create },
        lib_Device: { get }
      });
    await expect(
      prepareSchematicComponentMutation(api, {
        action: "create",
        device: {
          libraryUuid: "0819f05c4eef4c71ace90d822a990e87",
          uuid: "872f61e794230495",
          name: "B3B-PH-K-S(LF)(SN)"
        },
        x: 1,
        y: 2
      })
    ).rejects.toThrow(/catalog|cached|32/i);
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it("also rejects a legacy prepared invalid reference at execution without dispatching SDK create", async () => {
    const create = vi.fn();
    await expect(
      executeSchematicComponentMutation(
        {
          operation: {
            action: "createComponent",
            device: { uuid: "872f61e794230495", libraryUuid: "0819f05c4eef4c71ace90d822a990e87" },
            x: 1,
            y: 2
          }
        } as any,
        () => ({ sch_PrimitiveComponent: { create } })
      )
    ).rejects.toThrow(/catalog|cached|32/i);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("generic schematic update native contract", () => {
  beforeEach(() => extensionMutations.invalidateAll());
  function fixture(persist = false) {
    const state: Record<string, any> = {
      primitiveId: "part-a",
      designator: "R1",
      name: "old",
      x: 1,
      y: 2,
      rotation: 0,
      mirror: false,
      addIntoBom: true,
      addIntoPcb: true,
      manufacturer: "old vendor",
      otherProperty: { Description: "old", enabled: true },
      footprint: { uuid: "old-footprint", libraryUuid: "personal", name: "old package" }
    };
    const modify = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      if (persist) Object.assign(state, patch);
      // A completed SDK call/result is deliberately not persistence evidence.
      return { ...state, ...patch };
    });
    const api = () => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "sheet-a", documentType: 1 }) },
      sch_PrimitiveComponent: { getAll: async () => [{ ...state }], modify }
    });
    return { state, modify, api, handlers: createActionHandlers(api, new DrcRules(api)) };
  }
  async function confirm(f: ReturnType<typeof fixture>, properties: Record<string, unknown>) {
    const p = await prepareSchematicComponentMutation(f.api, { action: "update", component: "R1", properties });
    return f.handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    });
  }

  it("verifies explicit top-level native update fields alongside properties", async () => {
    const f = fixture(true);
    const p = await prepareSchematicComponentMutation(f.api, {
      action: "update", component: "R1", properties: { name: "new" },
      addIntoBom: false, addIntoPcb: false, subPartName: "B", uniqueId: "stable-id"
    });
    const result: any = await f.handlers.confirmedAction({
      action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation
    });
    expect(result.status).toBe("applied");
    expect(result.after.properties).toEqual({
      name: "new", addIntoBom: false, addIntoPcb: false, subPartName: "B", uniqueId: "stable-id"
    });
  });
  it("does not change omitted top-level BOM or PCB flags", async () => {
    const f = fixture(true);
    f.state.addIntoBom = false;
    f.state.addIntoPcb = false;
    const result: any = await confirm(f, { name: "new" });
    expect(result.status).toBe("applied");
    expect(f.modify).toHaveBeenCalledWith("part-a", { name: "new" });
    expect(f.state.addIntoBom).toBe(false);
    expect(f.state.addIntoPcb).toBe(false);
  });
  it.each(["package-a", { uuid: "new-footprint", libraryUuid: "personal", name: "package-a" }])(
    "rejects unsupported footprint changes before dispatch (%j)",
    async (footprint) => {
      const f = fixture();
      await expect(
        prepareSchematicComponentMutation(f.api, {
          action: "update",
          component: "R1",
          properties: { footprint }
        })
      ).rejects.toMatchObject({ code: "unsupported_property" });
      expect(f.modify).not.toHaveBeenCalled();
    }
  );
  it("rejects the legacy top-level footprint alias without stringifying it", async () => {
    const f = fixture();
    await expect(
      prepareSchematicComponentMutation(f.api, {
        action: "update",
        component: "R1",
        footprint: { uuid: "new-footprint" }
      })
    ).rejects.toMatchObject({ code: "unsupported_property" });
  });
  it("rejects unsupported properties instead of silently forwarding them", async () => {
    const f = fixture();
    await expect(
      prepareSchematicComponentMutation(f.api, {
        action: "update",
        component: "R1",
        properties: { madeUpField: true }
      })
    ).rejects.toMatchObject({ code: "unsupported_property" });
  });
  it("blocks legacy prepared footprint operations at execution before any SDK write", async () => {
    const f = fixture();
    await expect(
      executeSchematicComponentMutation(
        {
          operation: {
            action: "updateComponent",
            primitiveId: "part-a",
            properties: { footprint: { uuid: "new" } }
          }
        } as any,
        f.api
      )
    ).rejects.toMatchObject({ code: "unsupported_property" });
    expect(f.modify).not.toHaveBeenCalled();
  });
  it.each([
    { name: "new" },
    { rotation: 90 },
    { mirror: true },
    { addIntoBom: false },
    { addIntoPcb: false },
    { manufacturer: "new vendor" },
    { otherProperty: { Description: "new" } }
  ])("never reports ignored requested keys as applied (%j)", async (properties) => {
    const f = fixture();
    const result: any = await confirm(f, properties);
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/readback|mismatch/i);
    expect(f.modify).toHaveBeenCalledTimes(1);
  });
  it("requires every requested key even when the designator persisted", async () => {
    const f = fixture();
    f.modify.mockImplementation(async (_id, patch) => {
      f.state.designator = patch.designator;
      return { ...f.state, ...patch };
    });
    const result: any = await confirm(f, { designator: "R2", name: "not persisted" });
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/name/);
  });
  it("verifies false and zero values and returns fresh observed properties", async () => {
    const f = fixture(true);
    const properties = {
      name: "new",
      mirror: false,
      rotation: 0,
      addIntoBom: false,
      otherProperty: { enabled: false, count: 0, Description: "" }
    };
    const result: any = await confirm(f, properties);
    expect(result.status).toBe("applied");
    expect(result.after.properties).toEqual(properties);
    expect(result.after.verifiedKeys.slice().sort()).toEqual(Object.keys(properties).sort());
  });
  it("maps the documented value alias to native name and verifies the independent name", async () => {
    const f = fixture(true);
    const p = await prepareSchematicComponentMutation(f.api, { action: "update", component: "R1", value: "22k" });
    const result: any = await f.handlers.confirmedAction({
      action: "mutation",
      params: { mutationId: p.mutationId },
      confirmation: p.confirmation
    });
    expect(f.modify).toHaveBeenCalledExactlyOnceWith("part-a", { name: "22k" });
    expect(result.status).toBe("applied");
    expect(result.after.properties.name).toBe("22k");
  });
  it("preserves structured footprint references in snapshots instead of [object Object]", async () => {
    const f = fixture();
    const c = await findComponentInSchematic(f.api, "R1");
    expect(c.footprint).toEqual(f.state.footprint);
  });
});

it("uses independent native getters rather than stale facade fields for an update receipt", async () => {
  extensionMutations.invalidateAll();
  const state = { designator: "R1", name: "old" };
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "getter-sheet", documentType: 1 }) },
    sch_PrimitiveComponent: {
      getAll: async () => [
        {
          primitiveId: "getter-part",
          designator: "stale",
          name: "stale",
          x: 1,
          y: 2,
          getState_Designator: () => state.designator,
          getState_Name: () => state.name
        }
      ],
      modify: async (_id: string, patch: any) => {
        Object.assign(state, patch);
      }
    }
  };
  const api = () => eda;
  const p = await prepareSchematicComponentMutation(api, {
    action: "update",
    component: "getter-part",
    properties: { designator: "R2", name: "new" }
  });
  const r: any = await createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation",
    params: { mutationId: p.mutationId },
    confirmation: p.confirmation
  });
  expect(r.status).toBe("applied");
  expect(r.after.designator).toBe("R2");
  expect(r.after.properties).toEqual({ designator: "R2", name: "new" });
});

it("rejects an empty legacy generic update before SDK dispatch", async () => {
  const modify = vi.fn();
  await expect(
    executeSchematicComponentMutation(
      { operation: { action: "updateComponent", primitiveId: "legacy-part", properties: {} } } as any,
      () => ({ sch_PrimitiveComponent: { modify } })
    )
  ).rejects.toMatchObject({ code: "invalid_params" });
  expect(modify).not.toHaveBeenCalled();
});

it("does not treat an absent readback field as proof of a requested null reset", async () => {
  extensionMutations.invalidateAll();
  const modify = vi.fn(async () => ({ manufacturer: null }));
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "reset-sheet", documentType: 1 }) },
    sch_PrimitiveComponent: {
      modify,
      getAll: async () => [{ primitiveId: "reset-part", designator: "R1", x: 1, y: 2 }]
    }
  });
  const p = await prepareSchematicComponentMutation(api, {
    action: "update",
    component: "R1",
    properties: { manufacturer: null }
  });
  const result: any = await createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation",
    params: { mutationId: p.mutationId },
    confirmation: p.confirmation
  });
  expect(result.status).toBe("unknown");
  expect(result.error).toMatch(/manufacturer.*unavailable/);
  expect(modify).toHaveBeenCalledTimes(1);
});

it("does not treat an undefined native getter result as a verified null reset", async () => {
  extensionMutations.invalidateAll();
  const modify = vi.fn(async () => ({ manufacturer: null }));
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "getter-reset-sheet", documentType: 1 }) },
    sch_PrimitiveComponent: {
      modify,
      getAll: async () => [{ primitiveId: "getter-reset-part", designator: "R1", x: 1, y: 2,
        getState_Manufacturer: () => undefined }]
    }
  });
  const p = await prepareSchematicComponentMutation(api, {
    action: "update", component: "R1", properties: { manufacturer: null }
  });
  const result: any = await createActionHandlers(api, new DrcRules(api)).confirmedAction({
    action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation
  });
  expect(result.status).toBe("unknown");
  expect(modify).toHaveBeenCalledTimes(1);
});
