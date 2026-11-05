import { executePcb3dTransform } from "../mutation/pcb3dTransformMutations.js";
import { executePcbFreeTextDelete } from "../mutation/pcbFreeTextMutations.js";
import { executeMechanicalPad } from "../mutation/mechanicalPadMutations.js";
import { executeLegacyDeviceRecreate } from "../mutation/schematicLegacyRecreate.js";
import { executeSchematicPrune } from "../mutation/schematicPrune.js";
import { executeBoardOperation } from "../mutation/boardOperations.js";
import { executeSchematicPageCopy, executeSchematicPageDelete } from "../mutation/schematicPageCopies.js";
import { executeSchematicDeviceReplace } from "../mutation/schematicDeviceReplace.js";
import { executePcbAnnotationMutation } from "../mutation/pcbAnnotationMutations.js";
import { executeSchematicPage } from "../mutation/schematicPages.js";
import { executeBlockTransfer } from "../mutation/schematicBlockTransfer.js";
import type { DrcRules } from "../drcRules.js";
import { apiError, ensureApi, optionalCall, pickString } from "../helpers.js";
import { extractDocumentIdentity } from "../identity.js";
import { extensionMutations } from "../mutation/mutationManager.js";
import { executeBoardOutlineMutation } from "../mutation/pcbOutlineMutations.js";
import { executeMountingHoles } from "../mutation/pcbMountingHoles.js";
import { executePcbComponentMutation } from "../mutation/pcbComponentMutations.js";
import { executePcbCopperKeepoutMutation } from "../mutation/pcbCopperKeepoutMutations.js";
import { executePcbExternalImportMutation } from "../mutation/pcbExternalImportMutations.js";
import { executePcbNetConstraintMutation } from "../mutation/pcbNetConstraintMutations.js";
import {
  executePcbLayoutMutation,
  executePcbRoutingMutation,
  getNativeRoutingObservation,
  fetchLayoutSummary,
  fetchRoutingSummary
} from "../mutation/pcbRoutingMutations.js";
import { executePcbTrackViaMutation } from "../mutation/pcbTrackViaMutations.js";
import { executeSchematicComponentMutation } from "../mutation/schematicComponentMutations.js";
import { executeSchematicPcbSyncMutation } from "../mutation/schematicPcbSyncMutations.js";
import { executeSchematicBusMutation, executeSchematicPortMutation } from "../mutation/schematicPortBusMutations.js";
import { executeSchematicWireMutation } from "../mutation/schematicWireMutations.js";
import type { EasyEdaApi, RpcHandler } from "../types.js";

export function createActionHandlers(
  api: () => EasyEdaApi,
  drcRules: DrcRules,
  mutations = extensionMutations
): Record<string, RpcHandler> {
  async function confirmedAction(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const action = String(params.action ?? "");
    if (action === "editDrcRules") return drcRules.apply(params.params, params.confirmation);

    if (action === "mutation" && params.params?.mutationId) {
      const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
      const currentTarget = extractDocumentIdentity(documentInfo);
      const record = mutations.get(params.params.mutationId);

      let executeFn: () => Promise<boolean | void> = async () => true;
      let readbackFn: () => Promise<unknown> = async () => record.before;

      if (record.domain === "project" && ["copyBoard", "renameBoard"].includes(record.action)) {
        let resultReadback: Record<string, unknown> = {};
        executeFn = async () => {
          const result = await executeBoardOperation(api, record);
          resultReadback = result.readback;
          return result.executed;
        };
        readbackFn = async () => resultReadback;
      } else if (record.domain === "schematic") {
        let resultReadback: Record<string, unknown> = {};
        executeFn = async () => {
          let res: { executed: boolean; readback: Record<string, unknown> };
          if (["legacyDeviceStage", "legacyDeviceCommit"].includes(record.action)) {
            res = await executeLegacyDeviceRecreate(api, record);
          } else if (record.action === "prunePage") {
            res = await executeSchematicPrune(api, record);
          } else if (record.action === "replaceDevice") {
            res = await executeSchematicDeviceReplace(api, record);
          } else if (record.action === "schematicPage") {
            res = await executeSchematicPage(record, api);
          } else if (record.action === "copySchematicPage") {
            res = await executeSchematicPageCopy(api, record);
          } else if (record.action === "deleteSchematicPage") {
            res = await executeSchematicPageDelete(api, record);
          } else if (record.action === "transferBlock") {
            res = await executeBlockTransfer(record, api);
          } else if (["createWire", "modifyWire", "deleteWire", "addNetLabel"].includes(record.action)) {
            res = await executeSchematicWireMutation(record, api);
          } else if (["createPort", "modifyPort", "deletePort"].includes(record.action)) {
            res = await executeSchematicPortMutation(record, api);
          } else if (
            ["createBus", "modifyBus", "deleteBus", "createBusEntry", "deleteBusEntry"].includes(record.action)
          ) {
            res = await executeSchematicBusMutation(record, api);
          } else {
            res = await executeSchematicComponentMutation(record, api);
          }
          resultReadback = res.readback;
          return res.executed;
        };
        readbackFn = async () => resultReadback;
      } else if (record.domain === "sync") {
        let resultReadback: Record<string, unknown> = {};
        executeFn = async () => {
          const res = await executeSchematicPcbSyncMutation(record, api);
          resultReadback = res.readback;
          return res.executed;
        };
        readbackFn = async () => resultReadback;
      } else if (record.domain === "pcb") {
        let resultReadback: Record<string, unknown> = {};
        executeFn = async () => {
          let res: { executed: boolean; readback: Record<string, unknown> };
          if (["createAnnotations", "modifyAnnotations", "deleteAnnotations"].includes(record.action)) {
            res = await executePcbAnnotationMutation(api, record);
          } else if (record.action === "setPcbComponent3dTransform") {
            res = await executePcb3dTransform(api, record);
          } else if (record.action === "deleteExplicitFreePcbTexts") {
            res = await executePcbFreeTextDelete(api, record);
          } else if (["createStandaloneNpth", "moveStandaloneNpth", "deleteStandaloneNpth"].includes(record.action)) {
            res = await executeMechanicalPad(api, record);
          } else if (record.action === "createMountingHoles") {
            res = await executeMountingHoles(api, record);
          } else if (["autoroute", "unroute"].includes(record.action)) {
            res = await executePcbRoutingMutation(
              api,
              { ...((record as any).operation ?? record), mutationId: record.mutationId, target: record.target },
              record.before
            );
          } else if (record.action === "autolayout") {
            res = await executePcbLayoutMutation(api, (record as any).operation ?? record, record.before);
          } else if (["setBoardOutline", "clearBoardOutline", "modifyBoardOutline"].includes(record.action)) {
            res = await executeBoardOutlineMutation(api, (record as any).operation ?? record, record.before);
          } else if (
            [
              "createCopperZone",
              "modifyCopperZone",
              "deleteCopperZone",
              "rebuildCopper",
              "createKeepout",
              "modifyKeepout",
              "deleteKeepout"
            ].includes(record.action)
          ) {
            res = await executePcbCopperKeepoutMutation(api, (record as any).operation ?? record, record.before);
          } else if (
            [
              "createNetClass",
              "modifyNetClass",
              "deleteNetClass",
              "createDifferentialPair",
              "modifyDifferentialPair",
              "deleteDifferentialPair",
              "createLengthGroup",
              "modifyLengthGroup",
              "deleteLengthGroup"
            ].includes(record.action)
          ) {
            res = await executePcbNetConstraintMutation(api, (record as any).operation ?? record, record.before);
          } else if (record.action === "import_external") {
            res = await executePcbExternalImportMutation(
              api,
              { ...((record as any).operation ?? record), mutationId: record.mutationId, target: record.target },
              record.before
            );
          } else if (
            ["createTrack", "modifyTrack", "deleteTrack", "createVia", "modifyVia", "deleteVia"].includes(record.action)
          ) {
            res = await executePcbTrackViaMutation(
              api,
              { ...((record as any).operation ?? record), mutationId: record.mutationId, target: record.target },
              record.before
            );
          } else {
            res = await executePcbComponentMutation(api, (record as any).operation ?? record, record.before);
          }
          resultReadback = res.readback;
          return res.executed;
        };
        readbackFn = async () => resultReadback;
      }

      return mutations.apply({
        mutationId: params.params.mutationId,
        confirmation: String(params.confirmation ?? ""),
        currentTarget,
        currentBefore: record.before,
        execute: executeFn,
        readback: readbackFn,
        readbackTarget: currentTarget
      });
    }

    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const documentUuid = pickString(documentInfo, ["uuid", "documentUuid", "id"]);

    if (action === "save") {
      const type = extractDocumentIdentity(documentInfo).documentType;
      const documentApi = type === "schematic" ? eda.sch_Document : type === "pcb" ? eda.pcb_Document : undefined;
      if (!documentApi?.save) throw apiError("capability_unavailable", `Save API is unavailable for ${type}.`);
      const result = await documentApi.save(documentUuid);
      if (result === false) throw apiError("save_failed", "Native document save returned false.");
      return { action, saved: true, documentUuid, target: extractDocumentIdentity(documentInfo) };
    }

    if (action === "importChanges") {
      throw apiError(
        "prepared_mutation_required",
        "Schematic-to-PCB import requires easyeda_prepare_schematic_pcb_sync action:'syncToPcb' with explicit projectId, boardName, schematicUuid, pcbUuid and protectedBoardName, then its exact mutation confirmation. Query/reconcile an unknown import read-only; never repeat it automatically."
      );
    }

    if (action === "autoroute" || action === "nativeAutoRoute") {
      if (params.params?.file) {
        ensureApi("pcb_Document", "importAutoRouteJsonFile", eda);
        await eda.pcb_Document.importAutoRouteJsonFile(params.params.file);
        return {
          action: "autoroute",
          method: "external_import",
          imported: true,
          betaApi: true,
          target: extractDocumentIdentity(documentInfo)
        };
      }

      throw apiError(
        "prepared_mutation_required",
        "Native autorouting requires easyeda_prepare_pcb_routing followed by action:'mutation' and its exact confirmation. Query that mutationId after a deadline; never restart an unknown native router task."
      );
    }

    if (action === "autolayout" || action === "nativeAutoLayout") {
      if (params.params?.file) {
        ensureApi("pcb_Document", "importAutoLayoutJsonFile", eda);
        await eda.pcb_Document.importAutoLayoutJsonFile(params.params.file);
        return {
          action: "autolayout",
          method: "external_import",
          imported: true,
          betaApi: true,
          target: extractDocumentIdentity(documentInfo)
        };
      }

      const layoutFn = eda.pcb_Document?.autoLayout ?? eda.pcb_Document?.autoPlace;
      if (!layoutFn) {
        ensureApi("pcb_Document", "autoLayout", eda);
      }
      await layoutFn(params.params ?? {});
      const layoutStatus = await fetchLayoutSummary(api);
      return {
        action: "autolayout",
        method: "native",
        arranged: true,
        layoutStatus,
        target: extractDocumentIdentity(documentInfo)
      };
    }

    if (action === "unroute") {
      const unrouteFn = eda.pcb_Document?.unRoute ?? eda.pcb_Document?.unroute ?? eda.pcb_Document?.clearRouting;
      if (!unrouteFn) {
        ensureApi("pcb_Document", "unRoute", eda);
      }
      await unrouteFn(params.params ?? {});
      const routingStatus = await fetchRoutingSummary(api);
      return {
        action: "unroute",
        method: "native",
        unrouted: true,
        routingStatus,
        target: extractDocumentIdentity(documentInfo)
      };
    }

    if (action === "importAutoRouteFile") {
      ensureApi("pcb_Document", "importAutoRouteJsonFile", eda);
      if (!params.params?.file) {
        throw apiError(
          "missing_file",
          "importAutoRouteFile requires params.file from an EasyEDA-compatible autoroute JSON/SES file."
        );
      }
      await eda.pcb_Document.importAutoRouteJsonFile(params.params.file);
      return {
        action: "importAutoRouteFile",
        method: "external_import",
        imported: true,
        betaApi: true,
        target: extractDocumentIdentity(documentInfo)
      };
    }

    if (action === "importAutoLayoutFile") {
      ensureApi("pcb_Document", "importAutoLayoutJsonFile", eda);
      if (!params.params?.file) {
        throw apiError(
          "missing_file",
          "importAutoLayoutFile requires params.file from an EasyEDA-compatible autolayout JSON file."
        );
      }
      await eda.pcb_Document.importAutoLayoutJsonFile(params.params.file);
      return {
        action: "importAutoLayoutFile",
        method: "external_import",
        imported: true,
        betaApi: true,
        target: extractDocumentIdentity(documentInfo)
      };
    }

    throw apiError("unsupported_action", `Unsupported or unavailable confirmed action: ${action}.`);
  }

  function getMutationResult(params: Record<string, any>): Record<string, unknown> {
    const mutationId = String(params.mutationId ?? "");
    const record = mutations.get(mutationId);
    return record.domain === "pcb" && record.action === "autoroute"
      ? { ...record, nativeTask: getNativeRoutingObservation(mutationId, record.status) }
      : record;
  }

  return {
    confirmedAction,
    getMutationResult
  };
}
