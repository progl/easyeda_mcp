import { expect, it, vi } from "vitest";
import { createExportHandlers, saveApiFile } from "./exportHandlers.js";
const emptyZip = new Uint8Array([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]);
function fixture(file: unknown = new File([emptyZip], "board.zip", { type: "application/zip" })) {
  const saveFile = vi.fn(async (): Promise<unknown> => undefined);
  const eda = { pcb_ManufactureData: { getGerberFile: async () => file }, sys_FileSystem: { saveFile } };
  return { eda, saveFile, handlers: createExportHandlers(() => eda) };
}
it("returns actual ZIP bytes without asking OS to save", async () => {
  const f = fixture();
  const result: any = await f.handlers.exportGerber({ returnData: true });
  expect(result).toMatchObject({
    saved: false,
    returned: true,
    fileName: "board.zip",
    mimeType: "application/zip",
    fileSizeBytes: 22,
    validation: { valid: true }
  });
  expect(Buffer.from(result.dataBase64, "base64")).toEqual(Buffer.from(emptyZip));
  expect(f.saveFile).not.toHaveBeenCalled();
});
it("rejects invalid ZIP bytes even when metadata says zip", async () => {
  const f = fixture(new File(["notzip"], "board.zip", { type: "application/zip" }));
  await expect(f.handlers.exportGerber({ returnData: true })).rejects.toThrow(/ZIP/);
  expect(f.saveFile).not.toHaveBeenCalled();
});
it("rejects oversized data before reading arrayBuffer", async () => {
  const arrayBuffer = vi.fn();
  const f = fixture({ size: 20 * 1024 * 1024 + 1, name: "board.zip", arrayBuffer });
  await expect(f.handlers.exportGerber({ returnData: true })).rejects.toThrow(/limit/);
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(f.saveFile).not.toHaveBeenCalled();
});
it("does not claim saved when native saveFile returns void", async () => {
  const f = fixture();
  const result = await saveApiFile(() => f.eda, new File([emptyZip], "board.zip"), "board.zip", true);
  expect(result).toMatchObject({ saved: null, saveRequested: true });
});
it("reports explicit save cancellation as unsaved", async () => {
  const f = fixture();
  f.saveFile.mockResolvedValue(false);
  expect(await f.handlers.exportGerber({})).toMatchObject({ saved: false, saveRequested: true });
});
it("reports explicit native save success", async () => {
  const f = fixture();
  f.saveFile.mockResolvedValue({ success: true });
  expect(await f.handlers.exportGerber({})).toMatchObject({ saved: true, saveRequested: true });
});
it("returns a real ZIP containing drill bytes unchanged", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("board.drl", "M48\nMETRIC,TZ\nT1C3.200\n%");
  const original = await zip.generateAsync({ type: "arraybuffer" });
  const f = fixture(new File([original], "fabrication.zip"));
  const result: any = await f.handlers.exportGerber({ returnData: true });
  const decoded = Buffer.from(result.dataBase64, "base64");
  expect(decoded).toEqual(Buffer.from(original));
  expect(result.validation.entries).toBe(1);
  expect(f.saveFile).not.toHaveBeenCalled();
});
it("rejects a fake ZIP prefix without a central directory", async () => {
  const f = fixture(new File([new Uint8Array([80, 75, 3, 4, ...new Array(50).fill(0)])], "fake.zip"));
  await expect(f.handlers.exportGerber({ returnData: true })).rejects.toThrow(/ZIP/);
  expect(f.saveFile).not.toHaveBeenCalled();
});
