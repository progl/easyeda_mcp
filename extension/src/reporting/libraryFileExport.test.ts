import { expect, it, vi } from "vitest";
import { exportLibraryFile } from "./libraryFileExport.js";
const uuid = "d".repeat(32),
  libraryUuid = "l".repeat(32);
async function nativeFile() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("device.json", JSON.stringify({ uuid }));
  return new File([await zip.generateAsync({ type: "arraybuffer" })], "ProLib_pc.elibz2");
}
it.each([
  ["device", "getDeviceFileByDeviceUuid"],
  ["footprint", "getFootprintFileByFootprintUuid"],
  ["symbol", "getSymbolFileBySymbolUuid"]
])(
  "exports real %s File through exact public positional arguments and explicit friendly save filename",
  async (kind, method) => {
    const file = await nativeFile(),
      get = vi.fn(async () => file),
      save = vi.fn(async () => undefined);
    const result = await exportLibraryFile(
      () => ({ sys_FileManager: { [method]: get }, sys_FileSystem: { saveFile: save } }),
      { kind, uuid, libraryUuid, fileName: "Header-export-review" }
    );
    expect(get).toHaveBeenCalledExactlyOnceWith(uuid, libraryUuid, "elibz2");
    expect(save).toHaveBeenCalledExactlyOnceWith(file, "Header-export-review.elibz2");
    expect(result).toMatchObject({
      format: "elibz2",
      nativeFileReceived: true,
      nativeFileSizeBytes: file.size,
      saveRequested: true,
      saved: null,
      fileName: "Header-export-review.elibz2",
      archiveContentsVerified: false,
      geometryVerified: false
    });
    expect(result).not.toHaveProperty("file");
    expect(result).not.toHaveProperty("base64");
  }
);
it("fails before native dispatch without capability or valid filename", async () => {
  const get = vi.fn(),
    save = vi.fn();
  await expect(
    exportLibraryFile(() => ({ sys_FileManager: {}, sys_FileSystem: { saveFile: save } }), {
      kind: "device",
      uuid,
      libraryUuid
    })
  ).rejects.toMatchObject({ code: "api_unavailable" });
  await expect(
    exportLibraryFile(
      () => ({ sys_FileManager: { getDeviceFileByDeviceUuid: get }, sys_FileSystem: { saveFile: save } }),
      { kind: "device", uuid, libraryUuid, fileName: "../invalid" }
    )
  ).rejects.toMatchObject({ code: "invalid_params" });
  expect(get).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it.each([
  undefined,
  "metadata",
  new Blob(["not a File"]),
  new File([], "empty.elibz2"),
  new File(['{"manifest":{}}'], "fake.elibz2"),
  new File([new Uint8Array([80, 75, 3, 4])], "header.elibz2")
])("rejects no-result/non-File/empty/JSON/header-only output without saving or retry %s", async (payload) => {
  const get = vi.fn(async () => payload),
    save = vi.fn();
  await expect(
    exportLibraryFile(
      () => ({ sys_FileManager: { getDeviceFileByDeviceUuid: get }, sys_FileSystem: { saveFile: save } }),
      { kind: "device", uuid, libraryUuid }
    )
  ).rejects.toMatchObject({ code: "export_outcome_unknown" });
  expect(get).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});
it("reports uncertain save without another download/save", async () => {
  const get = vi.fn(async () => await nativeFile()),
    save = vi.fn(async () => {
      throw new Error("download interrupted");
    });
  await expect(
    exportLibraryFile(
      () => ({ sys_FileManager: { getDeviceFileByDeviceUuid: get }, sys_FileSystem: { saveFile: save } }),
      { kind: "device", uuid, libraryUuid }
    )
  ).rejects.toMatchObject({
    code: "export_outcome_unknown",
    details: { nativeFileReceived: true, saveRequested: true }
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
});
it("late native result after read deadline does not trigger save", async () => {
  let resolve!: (value: File) => void;
  const get = vi.fn(
      () =>
        new Promise<File>((r) => {
          resolve = r;
        })
    ),
    save = vi.fn(),
    file = await nativeFile();
  vi.useFakeTimers();
  try {
    const pending = exportLibraryFile(
      () => ({ sys_FileManager: { getDeviceFileByDeviceUuid: get }, sys_FileSystem: { saveFile: save } }),
      { kind: "device", uuid, libraryUuid, timeoutMs: 2000 }
    );
    const checked = expect(pending).rejects.toMatchObject({ code: "export_outcome_unknown" });
    await vi.advanceTimersByTimeAsync(2001);
    await checked;
    resolve(file);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("exports through registered read handler without any CAD API", async () => {
  const { createExportHandlers } = await import("../handlers/exportHandlers.js");
  const file = await nativeFile(),
    save = vi.fn(async () => undefined);
  const handlers = createExportHandlers(() => ({
    sys_FileManager: { getDeviceFileByDeviceUuid: async () => file },
    sys_FileSystem: { saveFile: save }
  }));
  const result: any = await handlers.exportLibraryFile({ kind: "device", uuid, libraryUuid, fileName: "Header" });
  expect(result.nativeFileReceived).toBe(true);
  expect(save).toHaveBeenCalledExactlyOnceWith(file, "Header.elibz2");
});

it("exports native file bytes without a global File constructor in the sandbox", async () => {
  const file = await nativeFile(),
    save = vi.fn(async () => undefined);
  vi.stubGlobal("File", undefined);
  try {
    await expect(
      exportLibraryFile(
        () => ({
          sys_FileManager: { getDeviceFileByDeviceUuid: async () => file },
          sys_FileSystem: { saveFile: save }
        }),
        { kind: "device", uuid, libraryUuid, fileName: "Sandbox" }
      )
    ).resolves.toMatchObject({ nativeFileReceived: true, zipFramingVerified: true });
    expect(save).toHaveBeenCalledExactlyOnceWith(file, "Sandbox.elibz2");
  } finally {
    vi.unstubAllGlobals();
  }
});
