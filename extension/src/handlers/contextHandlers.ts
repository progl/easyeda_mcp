import { optionalCall, sanitize, toArray, isRecord } from "../helpers.js";
import { detectMethodCapabilities, extractDocumentIdentity, assertDocumentTargetMatch } from "../identity.js";
import type { EasyEdaApi, RpcHandler } from "../types.js";
import { getPcbComponents, getPcbNetNames } from "./pcbHandlers.js";
import { getSchematicComponents } from "./schematicHandlers.js";

export function createContextHandlers(
  api: () => EasyEdaApi,
  getStatus: () => Promise<Record<string, unknown>>
): Record<string, RpcHandler> {
  async function getContext(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const documentIdentity = extractDocumentIdentity(documentInfo);
    if (params.target) assertDocumentTargetMatch(params.target, documentIdentity);
    const hasTarget = Boolean(documentIdentity.projectId && documentIdentity.documentId);
    const guard = async () => {
      if (hasTarget)
        assertDocumentTargetMatch(
          documentIdentity,
          extractDocumentIdentity(await eda.dmt_SelectControl.getCurrentDocumentInfo())
        );
    };
    const readBoard = async (method: string, all = false) => {
      const fn = eda.dmt_Board?.[method];
      if (typeof fn !== "function") return { status: "unsupported", reason: `dmt_Board.${method} is unavailable.` };
      let result: Record<string, unknown>;
      try {
        const value = await fn.call(eda.dmt_Board);
        result =
          value === undefined || value === null
            ? { status: "unavailable", reason: `dmt_Board.${method} did not report a board context.` }
            : all && !Array.isArray(value)
              ? { status: "error", error: "Board list API returned a non-array value." }
              : !all && !isRecord(value)
                ? { status: "error", error: "Current board API returned a non-object value." }
                : { status: "available", value: sanitize(value) };
      } catch (error) {
        result = { status: "error", error: String(error).slice(0, 500) };
      }
      await guard();
      return result;
    };
    const boardContext = {
      capabilities: {
        getCurrentBoardInfo: typeof eda.dmt_Board?.getCurrentBoardInfo === "function",
        getAllBoardsInfo: typeof eda.dmt_Board?.getAllBoardsInfo === "function"
      },
      current: await readBoard("getCurrentBoardInfo"),
      all: await readBoard("getAllBoardsInfo", true),
      targetVerified: hasTarget,
      snapshotAtomic: false,
      source: "public_dmt_Board_getters"
    };
    const methodCapabilities = detectMethodCapabilities(api);
    const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl?.getSplitScreenTree?.());
    const pcbNets = await optionalCall(() => getPcbNetNames(api));
    const pcbComponents = await optionalCall(() => getPcbComponents(api));
    const schComponents = await optionalCall(() => getSchematicComponents(api));

    const status = await getStatus();
    await guard();
    return {
      status,
      boardContext,
      documentIdentity,
      documentInfo: sanitize(documentInfo),
      methodCapabilities,
      splitScreenTree: sanitize(splitScreenTree),
      counts: {
        pcbNets: Array.isArray(pcbNets) ? pcbNets.length : undefined,
        pcbComponents: Array.isArray(pcbComponents) ? pcbComponents.length : undefined,
        schematicComponents: Array.isArray(schComponents) ? schComponents.length : undefined
      },
      betaApi: true
    };
  }

  async function getSelection(): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const documentIdentity = extractDocumentIdentity(documentInfo);
    let selectedPrimitives: unknown[] = [];

    if (eda.dmt_SelectControl?.getSelectedPrimitives) {
      selectedPrimitives = toArray(await optionalCall(() => eda.dmt_SelectControl.getSelectedPrimitives()));
    } else if (eda.dmt_SelectControl?.getAllSelectedPrimitives) {
      selectedPrimitives = toArray(await optionalCall(() => eda.dmt_SelectControl.getAllSelectedPrimitives()));
    } else if (eda.dmt_SelectControl?.getSelected) {
      selectedPrimitives = toArray(await optionalCall(() => eda.dmt_SelectControl.getSelected()));
    }

    const items = selectedPrimitives.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      return {
        id: item.primitiveId ?? item.id ?? item.uuid,
        type: item.type ?? item.primitiveType ?? item.sourceType,
        name: item.designator ?? item.name ?? item.title,
        layer: item.layer ?? item.layerId
      };
    });

    return {
      documentIdentity,
      document: {
        uuid: documentIdentity.documentId,
        type: documentIdentity.documentType,
        name: documentIdentity.documentName
      },
      count: items.length,
      selection: sanitize(items),
      raw: sanitize(selectedPrimitives)
    };
  }

  return {
    getContext,
    getSelection
  };
}
