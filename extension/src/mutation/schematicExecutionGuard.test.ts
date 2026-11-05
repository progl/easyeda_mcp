import { expect, it, vi } from "vitest";
import { extractDocumentIdentity } from "../identity.js";
import { guardedSchematicApi } from "./schematicExecutionGuard.js";
const target = extractDocumentIdentity({ uuid: "p", documentType: 1, parentProjectUuid: "project" });
it("a timed-out pure getter cannot resume the executor and dispatch writes after its late resolution", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: any) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    const modify = vi.fn(async () => {});
    const get = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
          markStarted();
        })
    );
    const api = () => ({
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ uuid: "p", parentProjectUuid: "project", documentType: 1 })
      },
      sch_PrimitiveWire: { get, modify }
    });
    const execution = guardedSchematicApi(api, target, 20);
    const run = (async () => {
      await execution.api().sch_PrimitiveWire.get("w");
      await execution.api().sch_PrimitiveWire.modify("w", {});
    })();
    const expired = expect(run).rejects.toThrow(/deadline|budget/i);
    // Establish that the native getter is pending before advancing its deadline.
    await started;
    expect(get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(21);
    await expired;
    resolve({ primitiveId: "w" });
    await vi.advanceTimersByTimeAsync(0);
    expect(modify).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("checks the target immediately before every attribute write", async () => {
  const modify = vi.fn(async () => {});
  const api = () => ({
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "other", parentProjectUuid: "project", documentType: 1 })
    },
    sch_PrimitiveAttribute: { modify }
  });
  const execution = guardedSchematicApi(api, target);
  await expect(execution.api().sch_PrimitiveAttribute.modify("a", { x: 1, y: 2 })).rejects.toThrow(/target|document/i);
  expect(modify).not.toHaveBeenCalled();
});
