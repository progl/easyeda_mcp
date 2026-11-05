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
