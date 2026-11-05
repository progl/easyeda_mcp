import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeBoardOutlineMutation,
  getBoardOutlineSummary,
  prepareBoardOutlineMutation,
  resolveBoardOutlineLayer
} from "./pcbOutlineMutations.js";
import { extensionMutations } from "./mutationManager.js";
import { createActionHandlers } from "../handlers/actionHandlers.js";
import { DrcRules } from "../drcRules.js";

describe("PCB Board Outline Mutations & Inspection", () => {
  beforeEach(() => {
    extensionMutations.invalidateAll();
  });

  describe("resolveBoardOutlineLayer", () => {
    it("finds board outline layer dynamically from getAllLayers", async () => {
      const eda = {
        pcb_Layer: {
          getAllLayers: vi.fn(async () => [
            { id: 1, name: "TopLayer", type: "signal" },
            { id: 11, name: "BoardOutline", type: "boardoutline" }
          ])
        }
      };

      const layer = await resolveBoardOutlineLayer(eda);
      expect(layer).toEqual({ id: 11, name: "BoardOutline" });
    });

    it("falls back to SDK board-outline layer11 if layers are absent", async () => {
      const layer = await resolveBoardOutlineLayer({});
      expect(layer).toEqual({ id: 11, name: "BoardOutline" });
    });
  });

  describe("getBoardOutlineSummary", () => {
    it("computes bounds, closure, perimeter, and area for rectangular lines", async () => {
      const lines = [
        { primitiveId: "l1", layer: 11, startX: 0, startY: 0, endX: 100, endY: 0 },
        { primitiveId: "l2", layer: 11, startX: 100, startY: 0, endX: 100, endY: 50 },
        { primitiveId: "l3", layer: 11, startX: 100, startY: 50, endX: 0, endY: 50 },
        { primitiveId: "l4", layer: 11, startX: 0, startY: 50, endX: 0, endY: 0 }
      ];

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            name: "Board.PcbDoc",
            documentType: 3
          }))
        },
        pcb_Layer: {
          getAllLayers: vi.fn(async () => [{ id: 11, name: "BoardOutline" }])
        },
        pcb_PrimitiveLine: {
          getAll: vi.fn(async () => lines)
        }
      });

      const summary = await getBoardOutlineSummary(api);
      expect(summary.exists).toBe(true);
      expect(summary.segmentCount).toBe(4);
      expect(summary.isClosed).toBe(true);
      expect(summary.bounds).toEqual({
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 50,
        width: 100,
        height: 50
      });
      expect(summary.estimatedArea).toBe(5000);
      expect(summary.perimeter).toBe(300);
      expect(summary.segments).toHaveLength(4);
    });

    it("detects unclosed open path outlines", async () => {
      const lines = [
        { primitiveId: "l1", layer: 11, startX: 0, startY: 0, endX: 100, endY: 0 },
        { primitiveId: "l2", layer: 11, startX: 100, startY: 0, endX: 100, endY: 50 }
      ];

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_PrimitiveLine: {
          getAll: vi.fn(async () => lines)
        }
      });

      const summary = await getBoardOutlineSummary(api);
      expect(summary.isClosed).toBe(false);
      expect(summary.segmentCount).toBe(2);
    });

    it("returns empty bounds when no outline primitives exist", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            documentType: 3
          }))
        },
        pcb_PrimitiveLine: {
          getAll: vi.fn(async () => [])
        }
      });

      const summary = await getBoardOutlineSummary(api);
      expect(summary.exists).toBe(false);
      expect(summary.segmentCount).toBe(0);
      expect(summary.bounds.width).toBe(0);
      expect(summary.bounds.height).toBe(0);
    });

    it("rejects non-PCB active documents", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "sch-1",
            documentType: 1
          }))
        }
      });

      await expect(getBoardOutlineSummary(api)).rejects.toThrow(/requires an active PCB document/);
    });
  });

  describe("prepareBoardOutlineMutation", () => {
    const mockPcbApi = (lines: any[] = []) => {
      return () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            name: "Board.PcbDoc",
            documentType: 3
          }))
        },
        pcb_PrimitiveLine: {
          getAll: vi.fn(async () => lines)
        }
      });
    };

    it("prepares a create-only rectangle in mm using native mil and SDK layer11", async () => {
      const prepared = await prepareBoardOutlineMutation(mockPcbApi(), {
        action: "create",
        units: "mm",
        x: 2.54,
        y: 0,
        width: 25.4,
        height: 12.7
      });
      const op = extensionMutations.get(String(prepared.mutationId)).operation as any;
      expect(op).toMatchObject({ createOnly: true, clearExisting: false, layerId: 11 });
      expect(op.width).toBeCloseTo(1000);
      expect(op.height).toBeCloseTo(500);
      expect(op.x).toBeCloseTo(100);
    });

    it("refuses create-only when any existing outline is present", async () => {
      const lines = [{ primitiveId: "existing", layer: 11, startX: 0, startY: 0, endX: 100, endY: 0 }];
      await expect(
        prepareBoardOutlineMutation(mockPcbApi(lines), { action: "create", width: 100, height: 100 })
      ).rejects.toThrow(/already exists/i);
    });

    it("prepares set_rectangle with valid dimensions and confirmation token", async () => {
      const api = mockPcbApi();
      const prepared = (await prepareBoardOutlineMutation(api, {
        action: "set_rectangle",
        x: 0,
        y: 0,
        width: 80,
        height: 60
      })) as Record<string, any>;

      expect(prepared.mutationId).toBeDefined();
      expect(prepared.confirmation).toBe(`CONFIRM pcb:setBoardOutline ${prepared.mutationId}`);
      expect(prepared.action).toBe("setBoardOutline");
      expect(prepared.preview).toMatchObject({
        before: { exists: false },
        requestedAfter: {
          exists: true,
          bounds: { width: 80, height: 60 },
          segmentCount: 4,
          isClosed: true
        },
        changedKeys: ["bounds", "width", "height", "segmentCount", "isClosed"]
      });
    });

    it("prepares set_polygon with vertex points", async () => {
      const api = mockPcbApi();
      const points = [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 30 }
      ];

      const prepared = (await prepareBoardOutlineMutation(api, {
        action: "set_polygon",
        points
      })) as Record<string, any>;

      expect(prepared.action).toBe("setBoardOutline");
      expect(prepared.preview).toMatchObject({
        requestedAfter: {
          bounds: { width: 60, height: 40 },
          segmentCount: 4,
          isClosed: true
        }
      });
    });

    it("prepares clear action when outline exists", async () => {
      const existingLines = [
        { primitiveId: "l1", layer: 11, startX: 0, startY: 0, endX: 50, endY: 0 },
        { primitiveId: "l2", layer: 11, startX: 50, startY: 0, endX: 50, endY: 50 },
        { primitiveId: "l3", layer: 11, startX: 50, startY: 50, endX: 0, endY: 50 },
        { primitiveId: "l4", layer: 11, startX: 0, startY: 50, endX: 0, endY: 0 }
      ];

      const api = mockPcbApi(existingLines);
      const prepared = (await prepareBoardOutlineMutation(api, {
        action: "clear"
      })) as Record<string, any>;

      expect(prepared.confirmation).toBe(`CONFIRM pcb:clearBoardOutline ${prepared.mutationId}`);
      expect(prepared.preview).toMatchObject({
        before: { exists: true, segmentCount: 4 },
        requestedAfter: { exists: false, segmentCount: 0 }
      });
    });

    it("rejects clear action when outline does not exist", async () => {
      const api = mockPcbApi([]);
      await expect(prepareBoardOutlineMutation(api, { action: "clear" })).rejects.toThrow(
        /already has no board outline/
      );
    });

    it("prepares modify_segment for an existing segment", async () => {
      const existingLines = [{ primitiveId: "l1", layer: 11, startX: 0, startY: 0, endX: 50, endY: 0 }];

      const api = mockPcbApi(existingLines);
      const prepared = (await prepareBoardOutlineMutation(api, {
        action: "modify_segment",
        primitiveId: "l1",
        endX: 60
      })) as Record<string, any>;

      expect(prepared.confirmation).toBe(`CONFIRM pcb:modifyBoardOutline ${prepared.mutationId}`);
      expect(prepared.preview).toMatchObject({
        before: { primitiveId: "l1", endX: 50 },
        requestedAfter: { primitiveId: "l1", endX: 60 },
        changedKeys: ["endX"]
      });
    });
  });

  describe("executeBoardOutlineMutation & actionHandlers confirmation", () => {
    it("preserves an outline that appeared after a create-only preview", async () => {
      const create = vi.fn(),
        remove = vi.fn();
      const api = () => ({
        dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "pcb", documentType: 3 }) },
        pcb_PrimitiveLine: {
          getAll: async () => [{ primitiveId: "existing", layer: 11, startX: 0, startY: 0, endX: 100, endY: 0 }],
          create,
          delete: remove
        }
      });
      await expect(
        executeBoardOutlineMutation(api, {
          action: "set_rectangle",
          createOnly: true,
          clearExisting: false,
          width: 100,
          height: 100
        })
      ).rejects.toThrow(/already exists|changed/i);
      expect(create).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
    it("creates one native closed polyline on layer11, never a copper line, and verifies its geometry", async () => {
      const state: any[] = [];
      const create = vi.fn(async (_net, layer, polygon, lineWidth) => {
        const primitive = { primitiveId: "poly1", layer, polygon, lineWidth };
        state.push(primitive);
        return primitive;
      });
      const lineCreate = vi.fn(() => {
        throw new Error("Board outline requires Polyline");
      });
      const createPolygon = vi.fn((source) => ({ getSource: () => source }));
      const api = () => ({
        dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "pcb", documentType: 3 }) },
        pcb_MathPolygon: { createPolygon },
        pcb_PrimitivePolyline: { create, getAll: async () => state },
        pcb_PrimitiveLine: { create: lineCreate, getAll: async () => [] }
      });
      const result = await executeBoardOutlineMutation(api, {
        action: "set_rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        lineWidth: 6
      });
      expect(lineCreate).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledExactlyOnceWith("", 11, expect.any(Object), 6, false);
      expect(createPolygon).toHaveBeenCalledWith([10, 20, "L", 110, 20, 110, 100, 10, 100, 10, 20]);
      expect(result.readback).toMatchObject({
        segmentCount: 4,
        isClosed: true,
        bounds: { minX: 10, minY: 20, maxX: 110, maxY: 100, width: 100, height: 80 },
        verified: true
      });
    });

    it("clears a polyline once with its own SDK API rather than the copper-line API", async () => {
      let state: any[] = [
        { primitiveId: "poly1", layer: 11, polygon: { getSource: () => [0, 0, "L", 100, 0, 100, 50, 0, 50, 0, 0] } }
      ];
      const remove = vi.fn(async () => {
        state = [];
        return true;
      });
      const lineRemove = vi.fn();
      const api = () => ({
        dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "pcb", documentType: 3 }) },
        pcb_PrimitivePolyline: { getAll: async () => state, delete: remove },
        pcb_PrimitiveLine: { getAll: async () => [], delete: lineRemove }
      });
      const before = await getBoardOutlineSummary(api);
      expect(before.exists).toBe(true);
      expect(before.isClosed).toBe(true);
      await executeBoardOutlineMutation(api, { action: "clear" });
      expect(remove).toHaveBeenCalledExactlyOnceWith(["poly1"]);
      expect(lineRemove).not.toHaveBeenCalled();
    });

    it("does not erase an existing outline when native polygon construction fails", async () => {
      const remove = vi.fn(),
        create = vi.fn();
      const api = () => ({
        dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: "pcb", documentType: 3 }) },
        pcb_PrimitiveLine: {
          getAll: async () => [{ primitiveId: "old", layer: 11, startX: 0, startY: 0, endX: 100, endY: 0 }],
          delete: remove
        },
        pcb_MathPolygon: { createPolygon: () => undefined },
        pcb_PrimitivePolyline: { create, getAll: async () => [] }
      });
      await expect(
        executeBoardOutlineMutation(api, {
          action: "set_rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          clearExisting: true
        })
      ).rejects.toThrow(/rejected/);
      expect(remove).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it("clears board outline and verifies via confirmed_action integration", async () => {
      let linesState = [
        { primitiveId: "l1", layer: 11, startX: 0, startY: 0, endX: 50, endY: 0 },
        { primitiveId: "l2", layer: 11, startX: 50, startY: 0, endX: 50, endY: 50 },
        { primitiveId: "l3", layer: 11, startX: 50, startY: 50, endX: 0, endY: 50 },
        { primitiveId: "l4", layer: 11, startX: 0, startY: 50, endX: 0, endY: 0 }
      ];

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "pcb-doc-1",
            name: "Board.PcbDoc",
            documentType: 3
          }))
        },
        pcb_Layer: {
          getAllLayers: vi.fn(async () => [{ id: 11, name: "BoardOutline" }])
        },
        pcb_PrimitiveLine: {
          getAll: vi.fn(async () => linesState),
          delete: vi.fn(async (ids: string[]) => {
            linesState = linesState.filter((l) => !ids.includes(l.primitiveId));
          })
        }
      });

      const prepared = (await prepareBoardOutlineMutation(api, {
        action: "clear"
      })) as Record<string, any>;

      const actionHandlers = createActionHandlers(api, new DrcRules(api));
      const confirmed = (await actionHandlers.confirmedAction({
        action: "mutation",
        confirmation: prepared.confirmation as string,
        params: {
          mutationId: prepared.mutationId as string
        }
      })) as Record<string, any>;

      expect(confirmed.status).toBe("applied");
      expect(confirmed.domain).toBe("pcb");
      expect(confirmed.action).toBe("clearBoardOutline");
      expect(confirmed.after).toMatchObject({
        cleared: true,
        segmentCount: 0,
        verified: true
      });
      expect(linesState).toHaveLength(0);
    });
  });
});
