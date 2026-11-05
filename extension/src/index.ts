import { readPcb3dTransform, preparePcb3dTransform } from "./mutation/pcb3dTransformMutations.js";
import { readPcbFreeTexts, preparePcbFreeTextDelete } from "./mutation/pcbFreeTextMutations.js";
import { readMechanicalPads, prepareMechanicalPad } from "./mutation/mechanicalPadMutations.js";
import { reconcileExplicitUnroute } from "./mutation/pcbExplicitUnroute.js";
import { prepareLegacyDeviceRecreate, reconcileLegacyDeviceStage } from "./mutation/schematicLegacyRecreate.js";
import { readScopedPcbSyncState, reconcileSchematicPcbSync } from "./mutation/schematicPcbSyncGuards.js";
import { reconcileSchematicCreate } from "./mutation/schematicCreateReconcile.js";
import { prepareSchematicPrune } from "./mutation/schematicPrune.js";
import { getBoardInventory, prepareBoardOperation, reconcileBoardCopy } from "./mutation/boardOperations.js";
import {
  prepareSchematicPageCopy,
  prepareSchematicPageDelete,
  getSchematicPageInventory,
  reconcileSchematicPageDelete
} from "./mutation/schematicPageCopies.js";
import { prepareSchematicDeviceReplace } from "./mutation/schematicDeviceReplace.js";
import { getSchematicAttributeInventory } from "./handlers/schematicAttributeInventory.js";
import { getNativePreflight } from "./reporting/nativePreflight.js";
import { preparePcbAnnotationMutation } from "./mutation/pcbAnnotationMutations.js";
import { listSchematicPages, prepareSchematicPage } from "./mutation/schematicPages.js";
import { prepareBlockTransfer } from "./mutation/schematicBlockTransfer.js";
import { auditSchematicConnectivity } from "./handlers/schematicConnectivity.js";
declare const eda: EasyEdaApi;

import { getBridgeConfig, getBridgeUri } from "./bridgeConfig.js";
import { createBridgeConnection, type BridgeConnection } from "./connection.js";
import { detectCapabilities, formatDiagnostics, formatStatusSummary } from "./diagnostics.js";
import { createDispatcher } from "./dispatcher.js";
import { DrcRules } from "./drcRules.js";
import { createActionHandlers } from "./handlers/actionHandlers.js";
import { createContextHandlers } from "./handlers/contextHandlers.js";
import { createDocumentHandlers } from "./handlers/documentHandlers.js";
import { createExportHandlers } from "./handlers/exportHandlers.js";
import { createNavigationHandlers } from "./handlers/navigationHandlers.js";
import { createPcbHandlers } from "./handlers/pcbHandlers.js";
import { createSchematicHandlers } from "./handlers/schematicHandlers.js";
import { log, showMessage } from "./helpers.js";
import { extensionMutations } from "./mutation/mutationManager.js";
import { prepareBoardOutlineMutation } from "./mutation/pcbOutlineMutations.js";
import { prepareMountingHoles } from "./mutation/pcbMountingHoles.js";
import { preparePcbComponentMutation } from "./mutation/pcbComponentMutations.js";
import { preparePcbCopperKeepoutMutation } from "./mutation/pcbCopperKeepoutMutations.js";
import { preparePcbExternalImportMutation } from "./mutation/pcbExternalImportMutations.js";
import { preparePcbNetConstraintMutation } from "./mutation/pcbNetConstraintMutations.js";
import { preparePcbLayoutMutation, preparePcbRoutingMutation } from "./mutation/pcbRoutingMutations.js";
import { preparePcbTrackViaMutation } from "./mutation/pcbTrackViaMutations.js";
import { prepareSchematicComponentMutation } from "./mutation/schematicComponentMutations.js";
import { compareSchematicPcb, prepareSchematicPcbSyncMutation } from "./mutation/schematicPcbSyncMutations.js";
import { prepareSchematicBusMutation, prepareSchematicPortMutation } from "./mutation/schematicPortBusMutations.js";
import { prepareSchematicWireMutation } from "./mutation/schematicWireMutations.js";
import { evaluateSpiceFeasibility, generateSpiceNetlist } from "./reporting/spiceFeasibilityReport.js";
import type { EasyEdaApi, RpcHandler } from "./types.js";

const getApi = (): EasyEdaApi => (typeof eda !== "undefined" ? eda : (globalThis as any).eda);

const bridgeConfig = getBridgeConfig();
const drcRules = new DrcRules(getApi);

const pcbHandlers = createPcbHandlers(getApi);
const schematicHandlers = createSchematicHandlers(getApi);
const exportHandlers = createExportHandlers(getApi);
const navigationHandlers = createNavigationHandlers(getApi, schematicHandlers.findComponent as any);
const actionHandlers = createActionHandlers(getApi, drcRules);
const documentHandlers = createDocumentHandlers(getApi);

let bridgeConnection: BridgeConnection;

const contextHandlers = createContextHandlers(getApi, () => bridgeConnection.getStatus());

const handlers: Record<string, RpcHandler> = {
  readPcb3dTransform: (params) => readPcb3dTransform(getApi, params),
  preparePcb3dTransform: (params) => preparePcb3dTransform(getApi, params),
  readPcbFreeTexts: (params) => readPcbFreeTexts(getApi, params),
  preparePcbFreeTextDelete: (params) => preparePcbFreeTextDelete(getApi, params),
  readMechanicalPads: (params) => readMechanicalPads(getApi, params),
  prepareMechanicalPad: (params) => prepareMechanicalPad(getApi, params),
  reconcileExplicitUnroute: (params) => reconcileExplicitUnroute(getApi, params),
  readScopedPcbSyncState: (params) => readScopedPcbSyncState(getApi, params),
  reconcileSchematicPcbSync: (params) => reconcileSchematicPcbSync(getApi, params),
  getSchematicAttributes: (params) => getSchematicAttributeInventory(getApi, params),
  getBoardInventory: (params) => getBoardInventory(getApi, params),
  reconcileBoardCopy: (params) => reconcileBoardCopy(getApi, params),
  prepareBoardOperation: (params) => prepareBoardOperation(getApi, params),
  getNativePreflight: (params) => getNativePreflight(getApi, params),
  listSchematicPages: (params) => listSchematicPages(getApi, params),
  prepareSchematicPage: (params) => prepareSchematicPage(getApi, params),
  prepareSchematicPageCopy: (params) => prepareSchematicPageCopy(getApi, params),
  prepareSchematicPageDelete: (params) => prepareSchematicPageDelete(getApi, params),
  getSchematicPageInventory: (params) => getSchematicPageInventory(getApi, params),
  reconcileSchematicPageDelete: (params) => reconcileSchematicPageDelete(getApi, params),
  prepareSchematicBlockTransfer: (params) => prepareBlockTransfer(getApi, params),
  auditSchematicConnectivity: (params) => auditSchematicConnectivity(getApi, params),
  getDrcRules: (params) => drcRules.read(params),
  prepareDrcEdit: (params) => drcRules.prepare(params),
  getDrcEditResult: (params) => drcRules.result(params),
  prepareBoardOutline: (params) => prepareBoardOutlineMutation(getApi, params),
  prepareMountingHoles: (params) => prepareMountingHoles(getApi, params),
  prepareCopperKeepout: (params) => preparePcbCopperKeepoutMutation(getApi, params),
  prepareExternalImport: (params) => preparePcbExternalImportMutation(getApi, params),
  prepareNetConstraint: (params) => preparePcbNetConstraintMutation(getApi, params),
  preparePcbAnnotation: (params) => preparePcbAnnotationMutation(getApi, params),
  preparePcbComponent: (params) => preparePcbComponentMutation(getApi, params),
  preparePcbLayout: (params) => preparePcbLayoutMutation(getApi, params),
  preparePcbRouting: (params) => preparePcbRoutingMutation(getApi, params),
  preparePcbTrackVia: (params) => preparePcbTrackViaMutation(getApi, params),
  reconcileSchematicCreate: (params) => reconcileSchematicCreate(getApi, params),
  reconcileLegacyDeviceStage: (params) => reconcileLegacyDeviceStage(getApi, params),
  prepareLegacyDeviceRecreate: (params) => prepareLegacyDeviceRecreate(getApi, params),
  prepareSchematicDeviceReplace: (params) => prepareSchematicDeviceReplace(getApi, params),
  prepareSchematicPrune: (params) => prepareSchematicPrune(getApi, params),
  prepareSchematicComponent: (params) => prepareSchematicComponentMutation(getApi, params),
  prepareSchematicWire: (params) => prepareSchematicWireMutation(getApi, params),
  prepareSchematicPort: (params) => prepareSchematicPortMutation(getApi, params),
  prepareSchematicBus: (params) => prepareSchematicBusMutation(getApi, params),
  prepareSchematicPcbSync: (params) => prepareSchematicPcbSyncMutation(getApi, params),
  compareSchematicPcb: (params) => compareSchematicPcb(getApi, params),
  evaluateSpiceFeasibility: (params) => evaluateSpiceFeasibility(getApi, params),
  generateSpiceNetlist: (params) => generateSpiceNetlist(getApi, exportHandlers.saveApiFile as any, params),
  ...contextHandlers,
  ...documentHandlers,
  ...schematicHandlers,
  ...navigationHandlers,
  ...exportHandlers,
  ...pcbHandlers,
  ...actionHandlers
};

bridgeConnection = createBridgeConnection({
  api: getApi,
  bridgeConfig,
  onMessage: (raw) => dispatchMessage(raw),
  getCapabilities: () => detectCapabilities(getApi, () => drcRules.capabilities()),
  onConnectionChanged: () => {
    drcRules.connectionChanged();
    extensionMutations.invalidateAll();
  }
});

const dispatchMessage = createDispatcher(handlers, (msg) => bridgeConnection.send(msg));

// SDK update/menu lazy loading may evaluate the entry without firing activate().
// Defer until handlers and dispatch are initialized; ensureConnected is idempotent.
void Promise.resolve()
  .then(() => bridgeConnection.ensureConnected({ reason: "entry-loaded", manual: false }))
  .catch((error) => log("error", "MCP bridge auto-connect failed", error));

export function activate(status?: "onStartupFinished", arg?: string): void {
  log("warn", `EasyEDA MCP Bridge activated: ${status ?? "manual"} ${arg ?? ""}`);
  void bridgeConnection.ensureConnected({ reason: "activation", manual: false, resetAttempts: true });
}

export function connect(): void {
  bridgeConnection.connect();
}

export function reconnect(): void {
  bridgeConnection.reconnect();
}

export async function showStatus(): Promise<void> {
  const diagnostics = await bridgeConnection.collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Status", formatStatusSummary(diagnostics, getBridgeUri(bridgeConfig)));
}

export async function runDiagnostics(): Promise<void> {
  const diagnostics = await bridgeConnection.collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Diagnostics", formatDiagnostics(diagnostics, getBridgeUri(bridgeConfig)));
}

export function deactivate(): void {
  bridgeConnection.dispose();
  drcRules.connectionChanged();
  extensionMutations.invalidateAll();
}
