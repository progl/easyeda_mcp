import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { collectNativeNetlist } from "../handlers/nativeNetlist.js";
import { getComponentPads, normalizePcbPad } from "../pcbGeometry.js";
import { getBoardInventory } from "./boardOperations.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const plain = <T>(value: T): T => JSON.parse(canonicalJson(value));
function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  )
    throw apiError("invalid_params", `Explicit ${label} required (max200, no control characters).`);
  return value;
}
function prop(raw: any, key: string) {
  const getter = `getState_${key[0].toUpperCase()}${key.slice(1)}`;
  return typeof raw?.[getter] === "function" ? raw[getter]() : raw?.[key];
}
function unique(items: any[], key: string, label: string) {
  const values = items.map((item) => text(item[key], `${label}.${key}`));
  if (new Set(values).size !== values.length) throw apiError("unverified_manifest", `Duplicate ${label}.${key}.`);
}
function operation(params: Record<string, any>) {
  return {
    action: "syncToPcb",
    guardedSync: true,
    projectId: text(params.projectId, "projectId"),
    boardName: text(params.boardName, "boardName"),
    schematicUuid: text(params.schematicUuid, "schematicUuid"),
    pcbUuid: text(params.pcbUuid, "pcbUuid"),
    protectedBoardName: text(params.protectedBoardName, "protectedBoardName")
  };
}
function validateInventory(inventory: any, op: ReturnType<typeof operation>) {
  const board = inventory.boards.find((b: any) => b.name === op.boardName);
  if (
    !board ||
    board.name === op.protectedBoardName ||
    !inventory.boards.some((b: any) => b.name === op.protectedBoardName) ||
    board.schematic.uuid !== op.schematicUuid ||
    board.pcb.uuid !== op.pcbUuid ||
    op.pcbUuid === op.schematicUuid
  )
    throw apiError(
      "invalid_target",
      "Explicit same-board SCH/PCB links and a distinct existing protected board required."
    );
  return board;
}
function schematicManifest(data: any) {
  if (!isRecord(data?.components))
    throw apiError("unverified_manifest", "Complete native EasyEDA component map required.");
  const result: any[] = [];
  for (const raw of Object.values(data.components) as any[]) {
    const p = raw?.props;
    if (!isRecord(p) || (p["Convert to PCB"] !== "yes" && p["Convert to PCB"] !== "no"))
      throw apiError("unverified_manifest", "Native Convert to PCB flag is unknown.");
    if (p["Convert to PCB"] === "no") continue;
    if (!isRecord(raw.pinInfoMap)) throw apiError("unverified_manifest", "Native physical pin map missing.");
    const pins = Object.values(raw.pinInfoMap)
      .map((pin: any) => {
        const number = text(pin?.number, "native pin number");
        if (typeof pin.net !== "string")
          throw apiError("unverified_manifest", "Pin net is unknown; never infer NC from absent data.");
        return { number, net: pin.net, membership: pin.net ? "native_assigned" : "native_unassigned" };
      })
      .sort((a, b) => a.number.localeCompare(b.number));
    unique(pins, "number", "schematic pin");
    if (!pins.length) throw apiError("unverified_manifest", "Physical component has no native pin map.");
    result.push({
      designator: text(p.Designator, "native designator"),
      uniqueId: text(p["Unique ID"], "native Unique ID"),
      device: text(p.Device, "native Device"),
      footprint: text(p.Footprint, "native Footprint"),
      pins
    });
  }
  unique(result, "designator", "schematic component");
  unique(result, "uniqueId", "schematic component");
  return result.sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}
async function pcbManifest(api: () => EasyEdaApi, ensure: () => void = () => {}) {
  ensure();
  const raw = await api().pcb_PrimitiveComponent.getAll();
  if (!Array.isArray(raw)) throw apiError("unverified_manifest", "Complete PCB component array required.");
  ensure();
  const result = [];
  for (const c of raw) {
    ensure();
    const footprint = prop(c, "footprint");
    const pads = [];
    const componentPads = await getComponentPads(c, api);
    ensure();
    for (const pad of componentPads) {
      ensure();
      const normalized = normalizePcbPad(pad, c);
      const observedNet = prop(pad, "net");
      const net = observedNet === undefined && typeof (pad as any)?.getState_Net === "function" ? "" : observedNet;
      if (typeof net !== "string") throw apiError("unverified_manifest", "PCB pad net is unavailable.");
      pads.push({
        ...normalized,
        primitiveId: text(normalized.primitiveId, "pad primitiveId"),
        padNumber: normalized.padNumber ?? "",
        net
      });
    }
    if (!pads.length) throw apiError("unverified_manifest", "PCB component has no independently readable pads.");
    unique(pads, "primitiveId", "PCB pad");
    result.push({
      primitiveId: text(prop(c, "primitiveId"), "PCB primitiveId"),
      uniqueId: text(prop(c, "uniqueId"), "PCB uniqueId"),
      designator: text(prop(c, "designator"), "PCB designator"),
      footprint: text(typeof footprint === "string" ? footprint : footprint?.uuid, "PCB footprint UUID"),
      x: prop(c, "x") ?? null,
      y: prop(c, "y") ?? null,
      rotation: prop(c, "rotation") ?? null,
      layer: prop(c, "layer") ?? null,
      pads: pads.sort((a, b) => a.primitiveId.localeCompare(b.primitiveId))
    });
  }
  unique(result, "uniqueId", "PCB component");
  unique(result, "designator", "PCB component");
  unique(result, "primitiveId", "PCB component");
  unique(
    result.flatMap((c) => c.pads),
    "primitiveId",
    "PCB pad"
  );
  return result.sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}
async function focus(api: () => EasyEdaApi, id: string, projectId: string, documentType: "pcb" | "schematic") {
  await api().dmt_EditorControl.openDocument(id);
  assertDocumentTargetMatch(
    { projectId, documentId: id, documentType },
    extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo())
  );
}
// Reads every board separately so copied primitive IDs never select another board.
// Opening documents is focus navigation only; no source/import/save/cleanup writes.
export async function readScopedPcbSyncState(api: () => EasyEdaApi, params: Record<string, any>) {
  const op = operation(params);
  const expectedTarget = { projectId: op.projectId, documentId: op.pcbUuid, documentType: "pcb" as const };
  const inventory = await getBoardInventory(api, { projectId: op.projectId, target: expectedTarget });
  validateInventory(inventory, op);
  if (inventory.currentBoardName !== op.boardName)
    throw apiError("invalid_target", "Explicit target PCB board must be active.");
  const manifests: Record<string, any> = {};
  try {
    for (const board of inventory.boards) {
      await focus(api, board.schematic.pages[0].uuid, op.projectId, "schematic");
      const native = await collectNativeNetlist(api(), true, 10000, "EasyEDA");
      if (
        native.status !== "available" ||
        native.format !== "EasyEDA" ||
        !native.text ||
        !native.scope?.verified ||
        native.scope.schematicUuid !== board.schematic.uuid ||
        native.scope.projectId !== op.projectId ||
        native.scope.boardName !== board.name
      )
        throw apiError(
          "unverified_manifest",
          "Native schematic export is unavailable or outside the explicitly inventoried board."
        );
      const schematic = schematicManifest(JSON.parse(native.text));
      await focus(api, board.pcb.uuid, op.projectId, "pcb");
      const pcb = await pcbManifest(api);
      assertDocumentTargetMatch(
        { projectId: op.projectId, documentId: board.pcb.uuid, documentType: "pcb" },
        extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo())
      );
      manifests[board.name] = { schematic, pcb };
    }
  } finally {
    await focus(api, op.pcbUuid, op.projectId, "pcb");
  }
  const final = await getBoardInventory(api, { projectId: op.projectId, target: expectedTarget });
  if (!equal(inventory.boards, final.boards) || final.currentBoardName !== op.boardName)
    throw apiError("unverified_manifest", "Native board/page ownership changed during manifest observation.");
  if (!manifests[op.boardName].schematic.length)
    throw apiError(
      "unverified_manifest",
      "An empty physical source is refused; this tool must not silently clear a PCB."
    );
  return plain({ projectId: op.projectId, boards: inventory.boards, manifests });
}
function discrepancies(before: any, after: any, op: ReturnType<typeof operation>) {
  const failures: string[] = [];
  if (!equal(before.boards, after.boards)) failures.push("Board/page ownership changed");
  for (const name of Object.keys(before.manifests)) {
    if (!equal(before.manifests[name].schematic, after.manifests[name]?.schematic))
      failures.push(`Schematic changed: ${name}`);
    if (name !== op.boardName && !equal(before.manifests[name].pcb, after.manifests[name]?.pcb))
      failures.push(`Other PCB changed: ${name}`);
  }
  failures.push(...targetDiscrepancies(before.manifests[op.boardName].schematic, after.manifests[op.boardName].pcb));
  return failures;
}
function targetDiscrepancies(expected: any[], actual: any[]) {
  const failures: string[] = [];
  if (expected.length !== actual.length) failures.push("Physical component set/count differs");
  for (const s of expected) {
    const p = actual.find((c: any) => c.uniqueId === s.uniqueId);
    if (!p || p.designator !== s.designator || p.footprint !== s.footprint) {
      failures.push(`Identity/footprint mismatch: ${s.designator}`);
      continue;
    }
    for (const pin of s.pins) {
      const pads = p.pads.filter((pad: any) => pad.padNumber === pin.number);
      if (!pads.length || pads.some((pad: any) => pad.net !== pin.net))
        failures.push(`Pin/pad net mismatch: ${s.designator}.${pin.number}`);
    }
    for (const pad of p.pads) {
      if (!pad.padNumber && pad.net === "") continue; // Explicit unnumbered, unassigned mechanical pad only.
      if (!s.pins.some((pin: any) => pin.number === pad.padNumber))
        failures.push(`Unexpected numbered/netted pad: ${s.designator}.${pad.padNumber}`);
    }
  }
  return failures;
}
// The complete observed component/pin/pad manifests remain in record.before, not full CAD snapshots.

function syncBeforeSummary(before: any) {
  if (!isRecord(before?.manifests) || !Array.isArray(before.boards))
    throw apiError("invalid_params", "Complete scoped before proof required.");
  return {
    schema: "scoped_sync_before_summary_v1",
    fullProofReference: "record.before",
    projectId: before.projectId,
    boards: before.boards.map((b: any) => ({ name: b.name, schematicUuid: b.schematic.uuid, pcbUuid: b.pcb.uuid })),
    manifests: Object.fromEntries(
      Object.entries(before.manifests).map(([name, m]: [string, any]) => [
        name,
        {
          schematicComponents: m.schematic.length,
          nativePins: m.schematic.reduce((n: number, c: any) => n + c.pins.length, 0),
          nativeUnassignedPins: m.schematic.reduce(
            (n: number, c: any) => n + c.pins.filter((p: any) => p.net === "").length,
            0
          ),
          pcbComponents: m.pcb.length,
          nativePads: m.pcb.reduce((n: number, c: any) => n + c.pads.length, 0)
        }
      ])
    )
  };
}
/** Lossless encoding of compared manifests, not unobserved CAD groups, via references to record.before. */
export function expandScopedPcbSyncInventory(before: any, inventory: any) {
  if (
    inventory?.encoding !== "scoped_sync_inventory_delta_v1" ||
    inventory.projectId !== before.projectId ||
    !Array.isArray(inventory.targetPcbAfter) ||
    !before.manifests[inventory.boardName] ||
    !equal(inventory.unchangedSchematicBoards, Object.keys(before.manifests).sort()) ||
    !equal(
      inventory.unchangedPcbBoards,
      Object.keys(before.manifests)
        .filter((n) => n !== inventory.boardName)
        .sort()
    )
  )
    throw apiError("invalid_params", "Complete scoped before plus exact lossless inventory delta required.");
  return plain({
    projectId: before.projectId,
    boards: before.boards,
    manifests: Object.fromEntries(
      Object.entries(before.manifests).map(([name, m]: [string, any]) => [
        name,
        {
          schematic: m.schematic,
          pcb: name === inventory.boardName ? inventory.targetPcbAfter : m.pcb
        }
      ])
    )
  });
}
function evidence(before: any, after: any, op: ReturnType<typeof operation>) {
  const failures = discrepancies(before, after, op);
  if (failures.length)
    throw apiError(
      "sync_readback_unconfirmed",
      `Import/apply remains unproven; no automatic retry. ${failures.slice(0, 20).join("; ")}`,
      { pending: true, appliedVerified: false, discrepancies: failures }
    );
  return {
    action: "syncToPcb",
    boardName: op.boardName,
    schematicUuid: op.schematicUuid,
    pcbUuid: op.pcbUuid,
    appliedVerified: true,
    verified: true,
    uniqueIdsVerified: true,
    physicalComponentsVerified: true,
    pinPadNetsVerified: true,
    otherBoardsComponentPadManifestPreserved: true,
    schematicPhysicalPinManifestPreserved: true,
    fullNativePreservation: false,
    otherBoardsUnverifiedGroups: ["tracks", "vias", "copperAreas", "freePrimitives", "models", "OtherProperty"],
    schematicUnverifiedGroups: ["nonPhysicalComponents", "wires", "graphics", "annotations", "OtherProperty"],
    inventory: {
      encoding: "scoped_sync_inventory_delta_v1",
      projectId: after.projectId,
      boardName: op.boardName,
      boardsReference: "record.before.boards",
      unchangedSchematicBoards: Object.keys(after.manifests).sort(),
      unchangedPcbBoards: Object.keys(after.manifests)
        .filter((n) => n !== op.boardName)
        .sort(),
      unchangedManifestsReference: "record.before.manifests",
      targetPcbAfter: after.manifests[op.boardName].pcb
    },
    saved: false,
    limitations: [
      "Explicit empty native pin nets are unassigned, not proof of intentional NC.",
      "Preservation verifies only observed component/pin/pad manifests, not complete schematic or PCB contents.",
      "Other-board tracks, vias, copper areas, free primitives, models and OtherProperty are not compared.",
      "Does not verify routed copper connectivity, DRC, model geometry or manufacturing readiness."
    ]
  };
}
function assertNoPendingSyncNavigation(exceptMutationId?: string) {
  const state = extensionMutations.getExecutionState();
  if (
    state.unresolvedCount > state.unresolved.length ||
    state.unresolved.some((r) => r.mutationId !== exceptMutationId && r.domain === "sync" && r.action === "syncToPcb")
  )
    throw apiError(
      "native_apply_pending",
      "A prior sync remains unresolved; no preflight document navigation. Reconcile its target-only state without import replay."
    );
}
export async function prepareScopedPcbSync(api: () => EasyEdaApi, params: Record<string, any>) {
  const op = operation(params);
  assertNoPendingSyncNavigation();
  const before = await readScopedPcbSyncState(api, op);
  const target = extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo());
  const source = before.manifests[op.boardName].schematic,
    pcb = before.manifests[op.boardName].pcb;
  const record = extensionMutations.prepare({
    domain: "sync",
    action: "syncToPcb",
    target,
    operation: op,
    before,
    previewBefore: syncBeforeSummary(before),
    requestedAfter: {
      physicalComponents: source.map((s: any) => ({ uniqueId: s.uniqueId, designator: s.designator }))
    },
    changedKeys: ["components", "pads", "nets"],
    scope: `project:${op.projectId}:pcb:${op.pcbUuid}`,
    impact: `Request one native import from ${op.schematicUuid} into ${op.pcbUuid}; may open an unapplied confirmation dialog. Includes explicit removals from the target copy only.`,
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: record.action,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt,
    destructive: true,
    appliedVerified: false,
    delta: {
      add: source.filter((s: any) => !pcb.some((p: any) => p.uniqueId === s.uniqueId)).map((s: any) => s.designator),
      remove: pcb.filter((p: any) => !source.some((s: any) => s.uniqueId === p.uniqueId)).map((p: any) => p.designator)
    }
  };
}
function validateRecord(record: MutationRecord) {
  const op = operation(record.operation);
  if (
    record.preview.beforeReference === "record.before" &&
    !equal(record.preview.before, syncBeforeSummary(record.before))
  )
    throw apiError("invalid_params", "Compact preview does not match the complete scoped before proof.");
  if (
    record.domain !== "sync" ||
    record.action !== "syncToPcb" ||
    record.operation.guardedSync !== true ||
    record.target.projectId !== op.projectId ||
    record.target.documentId !== op.pcbUuid ||
    !isRecord((record.before as any)?.manifests)
  )
    throw apiError("invalid_params", "Complete guarded sync preview required; old unscoped receipts are refused.");
  return op;
}
async function observeSyncTargetOnly(api: () => EasyEdaApi, op: ReturnType<typeof operation>, before: any) {
  const deadline = Date.now() + 15000;
  let expired = false;
  const ensure = () => {
    if (expired || Date.now() >= deadline)
      throw apiError(
        "native_target_read_timeout",
        "Target-only read deadline; no document navigation or import replay."
      );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    ensure();
    const target = { projectId: op.projectId, documentId: op.pcbUuid, documentType: "pcb" as const };
    const inventory = await getBoardInventory(api, { projectId: op.projectId, target });
    ensure();
    validateInventory(inventory, op);
    if (inventory.currentBoardName !== op.boardName)
      throw apiError("invalid_target", "Target PCB must already be active; observer never opens documents.");
    const pcb = await pcbManifest(api, ensure);
    ensure();
    assertDocumentTargetMatch(target, extractDocumentIdentity(await api().dmt_SelectControl.getCurrentDocumentInfo()));
    ensure();
    const failures = targetDiscrepancies(before.manifests[op.boardName].schematic, pcb);
    return {
      targetManifestReady: failures.length === 0,
      awaitingNativeApply: failures.length !== 0,
      componentCount: pcb.length,
      expectedComponentCount: before.manifests[op.boardName].schematic.length,
      discrepancies: failures.slice(0, 20),
      documentNavigationPerformed: false,
      uiClosedVerified: false,
      importUiState: "not_observable_by_public_sdk"
    };
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(apiError("native_target_read_timeout", "Target-only observation timed out; no navigation or replay."));
        }, 15000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function executeScopedPcbSync(
  record: MutationRecord,
  api: () => EasyEdaApi
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const op = validateRecord(record),
    journal: any = {
      phase: "preflight",
      nativeImportCalls: 0,
      sdkPending: false,
      awaitingNativeApply: false,
      targetManifestReady: false,
      fullReadbackPending: true,
      uiClosedVerified: false
    };
  const progress = () => {
    const state = extensionMutations.getExecutionState();
    if (state.lockHeld && state.activeMutationId === record.mutationId)
      extensionMutations.recordExecutionEvidence(record.mutationId, journal);
  };
  progress();
  assertNoPendingSyncNavigation(record.mutationId);
  const before = await readScopedPcbSyncState(api, op);
  if (!equal(before, record.before))
    throw apiError("stale_snapshot", "Exact scoped SCH/PCB manifests changed after preview; no import.");
  if (typeof api().pcb_Document?.importChanges !== "function")
    throw apiError("capability_unavailable", "Public pcb_Document.importChanges required; no fallback.");
  const state = extensionMutations.getExecutionState();
  if (state.activeMutationId === record.mutationId && state.activeStatus !== "running")
    throw apiError("execution_budget_expired", "Lifecycle expired during preflight; native import was not dispatched.");
  try {
    journal.phase = "native_import_dispatched";
    journal.nativeImportCalls = 1;
    journal.sdkPending = true;
    journal.awaitingNativeApply = true;
    progress();
    let nativeReturned: unknown;
    try {
      nativeReturned = await api().pcb_Document.importChanges(op.schematicUuid);
    } finally {
      journal.sdkPending = false;
      journal.phase = "native_import_request_settled";
      progress();
    }
    journal.nativeReturned = nativeReturned;
    // Legacy true means asynchronous import UI was requested. Never switch documents here.
    const observation = await observeSyncTargetOnly(api, op, before);
    Object.assign(journal, observation);
    journal.phase = observation.targetManifestReady ? "awaiting_independent_full_readback" : "awaiting_native_apply";
    progress();
    throw apiError(
      "write_readback_unknown",
      "Native import was requested once; acknowledgment is not Apply proof. Target-only observation retained; full independent reconcile required. No post-request document navigation or replay.",
      journal
    );
  } catch (error) {
    journal.sdkPending = false;
    progress();
    if ((error as any)?.code === "write_readback_unknown") throw error;
    throw apiError(
      "write_readback_unknown",
      `Native import request outcome remains unknown: ${String(error)} No document navigation/replay.`,
      journal
    );
  }
}
export async function reconcileSchematicPcbSync(api: () => EasyEdaApi, params: Record<string, any>) {
  return extensionMutations.reconcileSettledUnknown({
    mutationId: text(params.mutationId, "mutationId"),
    domain: "sync",
    action: "syncToPcb",
    originalRecord: params.originalRecord,
    summarizeBefore: syncBeforeSummary,
    verify: async (record) => {
      const op = validateRecord(record);
      const observation = await observeSyncTargetOnly(api, op, record.before);
      if (!observation.targetManifestReady)
        throw apiError(
          "native_apply_pending",
          `Target PCB manifest not applied (${observation.componentCount}/${observation.expectedComponentCount} components): ${observation.discrepancies.slice(0, 3).join("; ")}. Existing import UI state is unobservable. No document navigation or replay.`,
          observation
        );
      const after = await readScopedPcbSyncState(api, op);
      return {
        ...evidence(record.before, after, op),
        reconciledReadOnly: true,
        nativeImportReplayed: false,
        nativeAcknowledgmentRetained: false
      };
    }
  });
}
