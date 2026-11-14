import { expect, it, vi } from "vitest";
import { collectRoutingNetContext } from "./routingNetContext.js";

function fixture() {
  const target = { projectId: "project", documentId: "pcb", documentType: "pcb" as const };
  const component = { getState_PrimitiveId: () => "c1" };
  const nc = { getState_PrimitiveId: () => "pad0", getState_Net: () => undefined };
  const pads: any[] = [nc, { primitiveId: "pad1", net: "SIGNAL" }];
  const eda: any = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: vi.fn(async () => ({ uuid: "pcb", parentProjectUuid: "project", documentType: 3 }))
    },
    pcb_Net: { getAllNetsName: async () => ["GND", "SIGNAL"] },
    pcb_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => pads },
    pcb_PrimitiveLine: { getAll: async () => [] },
    pcb_PrimitiveVia: { getAll: async () => [] }
  };
  return { api: () => eda, eda, pads, target };
}
it("uses public getters, retains explicit native NC, and ignores enumeration order in its exact fingerprint", async () => {
  const f = fixture();
  const a = await collectRoutingNetContext(f.api, f.target);
  f.pads.reverse();
  const b = await collectRoutingNetContext(f.api, f.target);
  expect(a.allNetNames).toEqual(["GND", "SIGNAL"]);
  expect(a.counts.pads).toBe(2);
  expect(a.fingerprint).toBe(b.fingerprint);
  delete f.pads[1].getState_Net;
  await expect(collectRoutingNetContext(f.api, f.target)).rejects.toMatchObject({
    code: "routing_context_unavailable"
  });
});
it.each(["duplicatePad", "missingNet", "malformedNames", "malformedTracks"])(
  "refuses incomplete native membership: %s",
  async (kind) => {
    const f = fixture();
    if (kind === "duplicatePad") f.pads.push({ primitiveId: "pad1", net: "SIGNAL" });
    if (kind === "missingNet") f.pads.push({ primitiveId: "pad2" });
    if (kind === "malformedNames") f.eda.pcb_Net.getAllNetsName = async () => ["GND", {}];
    if (kind === "malformedTracks") f.eda.pcb_PrimitiveLine.getAll = async () => ({ tracks: [] });
    await expect(collectRoutingNetContext(f.api, f.target)).rejects.toMatchObject({
      code: "routing_context_unavailable"
    });
  }
);
it("refuses target drift observed after independent native reads", async () => {
  const f = fixture();
  f.eda.dmt_SelectControl.getCurrentDocumentInfo
    .mockResolvedValueOnce({ uuid: "pcb", parentProjectUuid: "project", documentType: 3 })
    .mockResolvedValue({ uuid: "other", parentProjectUuid: "project", documentType: 3 });
  await expect(collectRoutingNetContext(f.api, f.target)).rejects.toThrow(/target|document/i);
});
it("bounds pending read-only collection and never continues to pad queries after late completion", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let finish!: (value: any) => void;
    f.eda.pcb_PrimitiveComponent.getAll = () => new Promise((resolve) => (finish = resolve));
    f.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId = vi.fn(async () => []);
    const read = collectRoutingNetContext(f.api, f.target);
    const check = expect(read).rejects.toMatchObject({ code: "routing_context_unavailable" });
    await vi.advanceTimersByTimeAsync(10001);
    await check;
    finish([{ primitiveId: "late" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
