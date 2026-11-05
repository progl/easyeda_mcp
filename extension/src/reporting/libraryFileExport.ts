import { apiError } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";
import { validateExportDestination } from "./exportEnhancements.js";
export interface LibraryFileExportParams {
  kind: "device" | "footprint" | "symbol";
  uuid: string;
  libraryUuid: string;
  fileName?: string;
  format?: "elibz2";
  timeoutMs?: number;
}
// Frame validation only. No decompression, member CRC or library geometry proof.
async function zipFrame(file: File, read: <T>(step: string, fn: () => Promise<T>) => Promise<T>) {
  if (file.size < 30 || file.size > 64 * 1024 * 1024)
    throw new Error("Native library File must be nonempty ZIP, at most64MiB.");
  const head = new Uint8Array(await read("ZIP local header", () => file.slice(0, 4).arrayBuffer()));
  if (new DataView(head.buffer).getUint32(0, true) !== 0x04034b50)
    throw new Error("Native library File has no ZIP local header; JSON/metadata are not a library archive.");
  const start = Math.max(0, file.size - 65557);
  const bytes = new Uint8Array(await read("ZIP central-directory footer", () => file.slice(start).arrayBuffer()));
  const view = new DataView(bytes.buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      end = i;
      break;
    }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new Error("Native library ZIP footer unavailable/multidisk unsupported.");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    !count ||
    count === 65535 ||
    view.getUint16(end + 8, true) !== count ||
    size < 46 ||
    offset < 30 ||
    offset + size !== start + end
  )
    throw new Error("Native library ZIP central-directory framing is incomplete/empty/unsupported.");
  const directory = await read("ZIP central-directory signature", () => file.slice(offset, offset + 4).arrayBuffer());
  if (new DataView(directory).getUint32(0, true) !== 0x02014b50)
    throw new Error("Native library central directory missing.");
  return count;
}
export async function exportLibraryFile(
  api: () => EasyEdaApi,
  params: LibraryFileExportParams | Record<string, any>
): Promise<Record<string, unknown>> {
  if (
    !["device", "footprint", "symbol"].includes(params.kind) ||
    (params.format !== undefined && params.format !== "elibz2")
  )
    throw apiError("invalid_params", "Explicit device/footprint/symbol kind; only native elibz2 supported.");
  for (const key of ["uuid", "libraryUuid"] as const)
    if (
      typeof params[key] !== "string" ||
      !params[key] ||
      params[key] !== params[key].trim() ||
      params[key].length > 128
    )
      throw apiError("invalid_params", `Explicit ${key} required.`);
  if (params.timeoutMs !== undefined && (!Number.isFinite(params.timeoutMs) || params.timeoutMs < 1000))
    throw apiError("invalid_params", "timeoutMs must be a finite budget of at least1000ms.");
  const format = "elibz2",
    eda = api();
  const method = (
    {
      device: "getDeviceFileByDeviceUuid",
      footprint: "getFootprintFileByFootprintUuid",
      symbol: "getSymbolFileBySymbolUuid"
    } as Record<string, string>
  )[params.kind];
  if (typeof eda.sys_FileManager?.[method] !== "function" || typeof eda.sys_FileSystem?.saveFile !== "function")
    throw apiError(
      "api_unavailable",
      `Public sys_FileManager.${method} and sys_FileSystem.saveFile required; no synthetic fallback.`
    );
  const rawName = params.fileName === undefined ? `easyeda-library-${params.kind}-${params.uuid}` : params.fileName;
  if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 240)
    throw apiError("invalid_params", "Nonempty friendly fileName up to240 characters required when supplied.");
  const base = rawName.trim().replace(/\.elibz2$/i, "");
  const fileName = `${base}.${format}`;
  if (!base || [".", ".."].includes(base) || !validateExportDestination(fileName).valid)
    throw apiError("invalid_params", "fileName must be a plain filename, never a destination path.");
  const budget = Math.min(50000, Math.max(1, (params.timeoutMs ?? 60000) - 1000)),
    deadline = Date.now() + budget;
  let expired = false,
    nativeFileReceived = false,
    saveRequested = false,
    nativeFileSizeBytes: number | undefined;
  const bounded = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    if (expired || Date.now() >= deadline) throw new Error(`Library export expired before ${step}; no retry.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (expired) throw new Error("Library export budget expired");
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error(`Library export ${step} timed out; cancellation/retry unavailable.`));
          }, deadline - Date.now());
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let file: File, entryCount: number;
  try {
    const result: any = await bounded(method, () =>
      eda.sys_FileManager[method](params.uuid, params.libraryUuid, format)
    );
    // Native editor sandboxes may not expose File/Blob/Function constructors.
    // Require a named byte-bearing file interface, then verify actual ZIP bytes.
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.name !== "string" ||
      !result.name ||
      !Number.isSafeInteger(result.size) ||
      result.size <= 0 ||
      typeof result.arrayBuffer !== "function" ||
      typeof result.slice !== "function"
    )
      throw new Error("Native API returned no nonempty named byte-bearing File; no metadata/Blob/string fallback.");
    file = result;
    nativeFileSizeBytes = file.size;
    entryCount = await zipFrame(file, bounded);
    nativeFileReceived = true;
  } catch (error) {
    throw apiError(
      "export_outcome_unknown",
      `Native library export unconfirmed: ${String(error)} No save or automatic retry.`,
      {
        kind: params.kind,
        uuid: params.uuid,
        libraryUuid: params.libraryUuid,
        fileName,
        format,
        nativeFileReceived,
        nativeFileSizeBytes,
        saveRequested,
        status: "unknown"
      }
    );
  }
  let saveResult: unknown;
  try {
    saveResult = await bounded("save native library File", () => {
      saveRequested = true;
      // Exact original native bytes, explicit friendly filename. Documented API returns void.
      return eda.sys_FileSystem.saveFile(file, fileName);
    });
    if (saveResult === false || (saveResult && typeof saveResult === "object" && (saveResult as any).success === false))
      throw new Error("Native save was rejected/cancelled.");
  } catch (error) {
    throw apiError(
      "export_outcome_unknown",
      `Real native library File received but save outcome unconfirmed: ${String(error)} Inspect downloads before any retry.`,
      {
        kind: params.kind,
        uuid: params.uuid,
        libraryUuid: params.libraryUuid,
        fileName,
        format,
        nativeFileReceived,
        nativeFileSizeBytes,
        saveRequested,
        status: "unknown"
      }
    );
  }
  return {
    kind: params.kind,
    uuid: params.uuid,
    libraryUuid: params.libraryUuid,
    format,
    fileName,
    nativeFileName: file.name,
    nativeFileReceived: true,
    nativeFileSizeBytes: file.size,
    saveRequested,
    saved:
      saveResult === true || (saveResult && typeof saveResult === "object" && (saveResult as any).success === true)
        ? true
        : null,
    zipFramingVerified: true,
    zipEntryCount: entryCount,
    archiveContentsVerified: false,
    geometryVerified: false
  };
}
