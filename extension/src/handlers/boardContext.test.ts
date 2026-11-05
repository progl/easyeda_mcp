import { expect, it, vi } from "vitest";
import { createContextHandlers } from "./contextHandlers.js";
import { createActionHandlers } from "./actionHandlers.js";
it("reports actual board references and separates unavailable API/error instead of invented empty arrays", async () => {
  const identity = () => ({ uuid: "pcb", parentProjectUuid: "p", documentType: 3 });
  const board = { name: "main", schematic: { uuid: "sch" }, pcb: { uuid: "pcb" } };
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => identity() },
    dmt_Board: { getCurrentBoardInfo: async () => board, getAllBoardsInfo: async () => [board] }
  });
  const result: any = await createContextHandlers(api, async () => ({})).getContext({});
  expect(result.boardContext).toMatchObject({
    current: { status: "available", value: board },
    all: { status: "available", value: [board] },
    targetVerified: true
  });
  const missing: any = await createContextHandlers(
    () => ({
      dmt_SelectControl: { getCurrentDocumentInfo: async () => identity() },
      dmt_Board: {
        getCurrentBoardInfo: async () => {
          throw new Error("read failed");
        }
      }
    }),
    async () => ({})
  ).getContext({});
  expect(missing.boardContext).toMatchObject({ current: { status: "error" }, all: { status: "unsupported" } });
  expect(missing.boardContext.all.value).toBeUndefined();
});
it("rejects active target drift during board-context enumeration", async () => {
  let doc = "pcb";
  const api = () => ({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: doc, parentProjectUuid: "p", documentType: 3 }) },
    dmt_Board: {
      getCurrentBoardInfo: async () => {
        doc = "other";
        return {};
      },
      getAllBoardsInfo: async () => []
    }
  });
  await expect(
    createContextHandlers(api, async () => ({})).getContext({ target: { projectId: "p", documentId: "pcb" } })
  ).rejects.toThrow(/target|document/i);
});
it.each([{}, { uuid: "pcb" }, { schematicUuid: "schematic", force: true }])(
  "refuses generic importChanges bypass %j before native write",
  async (params) => {
    const native = vi.fn(async () => true);
    const api = () => ({
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ uuid: "pcb", parentProjectUuid: "p", documentType: 3 })
      },
      pcb_Document: { importChanges: native }
    });
    await expect(
      createActionHandlers(api, {} as any).confirmedAction({
        action: "importChanges",
        confirmation: "CONFIRM import changes",
        params
      })
    ).rejects.toMatchObject({ code: "prepared_mutation_required" });
    expect(native).not.toHaveBeenCalled();
  }
);
