import { exportLibraryFile as exportLibraryFileNative } from "../reporting/libraryFileExport.js";
import { apiError, ensureApi, sanitize, timestamp, toArray } from "../helpers.js";
import {
  fetchDeviceDetails,
  compareDevices as compareDevicesFn,
  verifyPinPadMapping as verifyPinPadMappingFn
} from "../reporting/deviceLibraryReports.js";
import {
  export3dModel as export3dModelEnhancement,
  exportDxf as exportDxfEnhancement,
  exportImage as exportImageEnhancement,
  exportProjectArchive as exportProjectArchiveEnhancement,
  validateExportContent
} from "../reporting/exportEnhancements.js";
import type { EasyEdaApi, RpcHandler } from "../types.js";

export function extractFile(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item) => typeof File !== "undefined" && item instanceof File) ?? value[0];
  }
  if (value && typeof value === "object" && "file" in value) {
    return (value as { file: unknown }).file;
  }
  return value;
}

export function pickManufactureApi(api: () => EasyEdaApi, scope: string | undefined, method: string): any {
  const eda = api();
  if (scope === "schematic") {
    ensureApi("sch_ManufactureData", method, eda);
    return eda.sch_ManufactureData;
  }
  if (scope === "pcb") {
    ensureApi("pcb_ManufactureData", method, eda);
    return eda.pcb_ManufactureData;
  }
  if (eda.pcb_ManufactureData?.[method]) {
    return eda.pcb_ManufactureData;
  }
  ensureApi("sch_ManufactureData", method, eda);
  return eda.sch_ManufactureData;
}

export async function saveApiFile(
  api: () => EasyEdaApi,
  file: unknown,
  fallbackFileName: string,
  betaApi: boolean,
  destinationPath?: string,
  explicitFormat?: string
): Promise<Record<string, unknown>> {
  const eda = api();
  const normalizedFile = extractFile(file);
  const ext = fallbackFileName.split(".").pop() ?? "dat";
  const format = explicitFormat ?? ext;

  if (!normalizedFile) {
    const validation = validateExportContent(format, file, fallbackFileName, destinationPath);
    return {
      saved: false,
      file: sanitize(file),
      reason: "EasyEDA returned a non-File value; returning it without saving.",
      betaApi,
      validation: sanitize(validation)
    };
  }

  ensureApi("sys_FileSystem", "saveFile", eda);
  const fileName = (normalizedFile as File).name || fallbackFileName;
  const validation = validateExportContent(format, normalizedFile, fileName, destinationPath);
  const saveResult = await eda.sys_FileSystem.saveFile(normalizedFile, fileName);
  return {
    saved:
      saveResult === true || (saveResult && typeof saveResult === "object" && saveResult.success === true)
        ? true
        : saveResult === false || (saveResult && typeof saveResult === "object" && saveResult.success === false)
          ? false
          : null,
    saveRequested: true,
    fileName,
    saveResult: sanitize(saveResult),
    betaApi,
    validation: sanitize(validation)
  };
}

const GERBER_DATA_LIMIT = 20 * 1024 * 1024;

// Checks actual ZIP framing/central directory bounds; does not decompress or verify member CRCs.
function validateGerberZip(bytes: Uint8Array): number {
  const invalid = () => apiError("invalid_export", "Gerber export is not a supported, structurally valid ZIP archive.");
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw invalid();
  const entries = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (entries === 65535 || view.getUint16(end + 8, true) !== entries || offset + size !== end) throw invalid();
  let cursor = offset;
  for (let n = 0; n < entries; n++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const localOffset = view.getUint32(cursor + 42, true);
    if (localOffset + 30 > offset || view.getUint32(localOffset, true) !== 0x04034b50) throw invalid();
    const dataOffset =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataOffset + view.getUint32(cursor + 20, true) > offset || view.getUint16(cursor + 34, true) !== 0)
      throw invalid();
    cursor +=
      46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor !== end || (!entries && (offset !== 0 || size !== 0))) throw invalid();
  return entries;
}

async function returnGerberData(file: unknown, fallbackFileName: string): Promise<Record<string, unknown>> {
  const normalized = extractFile(file) as File | undefined;
  if (!normalized || typeof normalized.arrayBuffer !== "function")
    throw apiError("invalid_export", "Gerber data export requires a binary File/Blob.");
  if (!Number.isSafeInteger(normalized.size) || normalized.size < 0 || normalized.size > GERBER_DATA_LIMIT)
    throw apiError("export_too_large", "Gerber returnData limit is 20 MiB.");
  const buffer = await normalized.arrayBuffer();
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength > GERBER_DATA_LIMIT ||
    buffer.byteLength !== normalized.size
  )
    throw apiError("invalid_export", "Gerber binary size mismatch or 20 MiB limit exceeded.");
  const bytes = new Uint8Array(buffer),
    entries = validateGerberZip(bytes);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return {
    saved: false,
    saveRequested: false,
    returned: true,
    fileName: normalized.name || fallbackFileName,
    mimeType: "application/zip",
    fileSizeBytes: bytes.length,
    dataBase64: btoa(chunks.join("")),
    betaApi: true,
    validation: {
      valid: true,
      format: "zip",
      fileSizeBytes: bytes.length,
      entries,
      checks: [
        {
          check: "zip_structure",
          passed: true,
          message: "ZIP headers and central directory bounds verified from bytes; member CRCs/content not checked."
        }
      ]
    }
  };
}

export function createExportHandlers(api: () => EasyEdaApi): Record<string, RpcHandler> {
  async function exportBom(params: Record<string, any>): Promise<Record<string, unknown>> {
    const fileName = params.fileName ?? `easyeda-bom-${timestamp()}`;
    const format = params.format ?? "csv";
    const mfgApi = pickManufactureApi(api, params.scope, "getBomFile");
    const file = await mfgApi.getBomFile(fileName, format);
    return saveApiFile(api, file, `${fileName}.${format}`, true, params.destinationPath, format);
  }

  async function exportNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
    const fileName = params.fileName ?? `easyeda-netlist-${timestamp()}`;
    const mfgApi = pickManufactureApi(api, params.scope, "getNetlistFile");
    const file = await mfgApi.getNetlistFile(fileName, params.netlistType);
    return saveApiFile(api, file, `${fileName}.net`, true, params.destinationPath, "net");
  }

  async function exportGerber(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    ensureApi("pcb_ManufactureData", "getGerberFile", eda);
    const fileName = params.fileName ?? `easyeda-gerber-${timestamp()}`;
    const file = await eda.pcb_ManufactureData.getGerberFile(fileName);
    if (params.returnData === true) return returnGerberData(file, `${fileName}.zip`);
    return saveApiFile(api, file, `${fileName}.zip`, true, params.destinationPath, "zip");
  }

  async function exportPdf(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const fileName = params.fileName ?? `easyeda-export-${timestamp()}`;
    if (
      params.scope === "schematic" ||
      (!eda.pcb_ManufactureData?.getPdfFile && eda.sch_ManufactureData?.getExportDocumentFile)
    ) {
      const file = await eda.sch_ManufactureData.getExportDocumentFile(fileName, "pdf");
      return saveApiFile(api, file, `${fileName}.pdf`, true, params.destinationPath, "pdf");
    }
    ensureApi("pcb_ManufactureData", "getPdfFile", eda);
    const file = await eda.pcb_ManufactureData.getPdfFile(fileName);
    return saveApiFile(api, file, `${fileName}.pdf`, true, params.destinationPath, "pdf");
  }

  async function exportCpl(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    ensureApi("pcb_ManufactureData", "getPickAndPlaceFile", eda);
    const fileName = params.fileName ?? `easyeda-cpl-${timestamp()}`;
    const format = params.format ?? "csv";
    const unit = params.unit ?? "mm";
    const file = await eda.pcb_ManufactureData.getPickAndPlaceFile(fileName, format, unit);
    return saveApiFile(api, file, `${fileName}.${format}`, true, params.destinationPath, format);
  }

  async function searchLibrary(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const query = String(params.query ?? "").trim();
    if (!query) {
      throw apiError("missing_query", "query parameter is required to search the component library.");
    }
    const limit = Math.max(1, Math.min(100, Number(params.limit ?? 20)));

    let rawResults: unknown;
    if (eda.lib_Device?.search) {
      rawResults = await eda.lib_Device.search(query);
    } else if (eda.lib_Search?.search) {
      rawResults = await eda.lib_Search.search(query);
    } else {
      throw apiError("api_unavailable", "eda.lib_Device.search is unavailable in this EasyEDA Pro environment.");
    }

    const list = toArray(rawResults);
    const results = list.slice(0, limit).map((item: any) => {
      if (!item || typeof item !== "object") return item;
      return {
        uuid: item.uuid ?? item.id,
        name: item.name ?? item.title,
        lcscCode: item.lcscCode ?? item.code ?? item.orderCode ?? item.partNumber,
        deviceType: item.deviceType ?? item.type,
        package: item.package ?? item.footprint ?? item.packageName,
        manufacturer: item.manufacturer ?? item.mfr,
        description: item.description ?? item.comment,
        inStock: item.inStock ?? item.stock,
        isJlcBasic: item.isJlcBasic ?? item.basicPart
      };
    });

    return {
      query,
      count: results.length,
      total: list.length,
      results: sanitize(results),
      raw: sanitize(list.slice(0, limit))
    };
  }

  return {
    exportLibraryFile: (params: Record<string, any>) => exportLibraryFileNative(api, params),
    exportBom,
    exportNetlist,
    exportGerber,
    exportPdf,
    exportCpl,
    exportImage: (params: Record<string, any>) =>
      exportImageEnhancement(
        api,
        (file, name) => saveApiFile(api, file, name, true, params.destinationPath, params.format),
        params
      ),
    export3dModel: (params: Record<string, any>) =>
      export3dModelEnhancement(
        api,
        (file, name) => saveApiFile(api, file, name, true, params.destinationPath, params.format),
        params
      ),
    exportProjectArchive: (params: Record<string, any>) =>
      exportProjectArchiveEnhancement(
        api,
        (file, name) => saveApiFile(api, file, name, true, params.destinationPath, params.format),
        params
      ),
    exportDxf: (params: Record<string, any>) =>
      exportDxfEnhancement(
        api,
        (file, name) => saveApiFile(api, file, name, true, params.destinationPath, "dxf"),
        params
      ),
    searchLibrary,
    getDeviceDetails: (params: Record<string, any>) => fetchDeviceDetails(api, params as any),
    compareDevices: (params: Record<string, any>) => compareDevicesFn(api, params as any),
    verifyPinPadMapping: (params: Record<string, any>) => verifyPinPadMappingFn(api, params as any)
  };
}
