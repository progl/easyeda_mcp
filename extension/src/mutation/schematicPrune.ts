import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { collectNativeNetlist } from "../handlers/nativeNetlist.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const prop = (raw: any, key: string) =>
  typeof raw?.[`getState_${key}`] === "function"
    ? raw[`getState_${key}`]()
    : raw?.[key[0].toLowerCase() + key.slice(1)];
function options(params: Record<string, any>) {
  for (const key of ["projectId", "documentId", "expectedBoardName", "protectedBoardName"])
    if (
      typeof params[key] !== "string" ||
      !params[key] ||
      params[key] !== params[key].trim() ||
      params[key].length > 512
    )
      throw apiError("invalid_params", `Explicit ${key} required.`);
  if (params.expectedBoardName === params.protectedBoardName)
    throw apiError("protected_board", "Expected board cannot be the protected original board.");
  const ids = (value: any, limit: number) => {
    if (value === undefined) return [] as string[];
    if (
      !Array.isArray(value) ||
      value.length > limit ||
      value.some((v) => typeof v !== "string" || !v || v !== v.trim() || v.length > 512) ||
      new Set(value).size !== value.length
    )
      throw apiError("invalid_params", `Explicit unique primitive IDs required, limit${limit}.`);
    return value as string[];
  };
  const componentIds = ids(params.componentIds, 100),
    wireIds = ids(params.wireIds, 500);
  if (
    (!componentIds.length && !wireIds.length) ||
    new Set([...componentIds, ...wireIds]).size !== componentIds.length + wireIds.length
  )
    throw apiError("invalid_params", "Select nonempty, disjoint explicit componentIds/wireIds only.");
  return {
    projectId: params.projectId as string,
    documentId: params.documentId as string,
    expectedBoardName: params.expectedBoardName as string,
    protectedBoardName: params.protectedBoardName as string,
    componentIds,
    wireIds
  };
}
export function schematicLegacySnapshotEnvironment(
  api: () => EasyEdaApi,
  op: ReturnType<typeof options>,
  includeNativeBindings = false
) {
  const eda = api(),
    deadline = Date.now() + 40000;
  for (const [owner, method] of [
    [eda.dmt_Project, "getCurrentProjectInfo"],
    [eda.dmt_SelectControl, "getCurrentDocumentInfo"],
    [eda.dmt_Board, "getCurrentBoardInfo"],
    [eda.dmt_Board, "getAllBoardsInfo"],
    [eda.dmt_Schematic, "getCurrentSchematicInfo"],
    [eda.sch_PrimitiveComponent, "getAll"],
    [eda.sch_PrimitiveComponent, "getAllPinsByPrimitiveId"],
    [eda.sch_PrimitiveWire, "getAll"],
    [eda.sch_ManufactureData, "getNetlistFile"]
  ] as const)
    if (typeof owner?.[method] !== "function")
      throw apiError("capability_unavailable", `Prune requires independent public legacy ${method} readback.`);
  if (
    (op.componentIds.length && typeof eda.sch_PrimitiveComponent?.delete !== "function") ||
    (op.wireIds.length && typeof eda.sch_PrimitiveWire?.delete !== "function")
  )
    throw apiError("capability_unavailable", "Explicit native batch delete capability unavailable.");
  const ensure = () => {
    if (Date.now() >= deadline)
      throw apiError("execution_budget_expired", "Prune observation budget expired; no later delete will start.");
  };
  const read = async <T>(step: string, fn: () => T | Promise<T>): Promise<T> => {
    ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          ensure();
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                apiError(
                  "native_read_timeout",
                  `Prune read ${step} timed out; no later calls or retry. Native read cancellation unavailable.`
                )
              ),
            Math.min(5000, deadline - Date.now())
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const links = (b: any) => {
    if (
      !b ||
      b.parentProjectUuid !== op.projectId ||
      !b.schematic?.uuid ||
      !b.pcb?.uuid ||
      !Array.isArray(b.schematic.page)
    )
      throw apiError("unverified_inventory", "Native protected/active board links unavailable.");
    return {
      name: b.name,
      uuid: b.uuid ?? null,
      schematicUuid: b.schematic.uuid,
      pcbUuid: b.pcb.uuid,
      pages: b.schematic.page
        .map((p: any) => ({ uuid: p.uuid, name: p.name, parentSchematicUuid: p.parentSchematicUuid }))
        .sort((a: any, b: any) => String(a.uuid).localeCompare(String(b.uuid)))
    };
  };
  const guard = async () => {
    const target = extractDocumentIdentity(
      await read("active document", () => eda.dmt_SelectControl.getCurrentDocumentInfo())
    );
    assertDocumentTargetMatch(
      { projectId: op.projectId, documentId: op.documentId, documentType: "schematic" },
      target
    );
    const project = await read("current project", () => eda.dmt_Project.getCurrentProjectInfo());
    if (project?.uuid !== op.projectId) throw apiError("target_mismatch", "Prune project changed.");
    const current = await read("current board", () => eda.dmt_Board.getCurrentBoardInfo());
    if (current?.name !== op.expectedBoardName || current.name === op.protectedBoardName)
      throw apiError("protected_board", "Active board differs from explicit expected board or is protected.");
    const active = links(current),
      boards = await read("all boards", () => eda.dmt_Board.getAllBoardsInfo());
    if (!Array.isArray(boards)) throw apiError("unverified_inventory", "Native board list unavailable.");
    const originals = boards.filter((b) => b.name === op.protectedBoardName);
    if (originals.length !== 1) throw apiError("protected_board", "Protected original board must be uniquely present.");
    const protectedBoard = links(originals[0]),
      schematic = await read("current schematic", () => eda.dmt_Schematic.getCurrentSchematicInfo());
    if (
      schematic?.uuid !== active.schematicUuid ||
      !active.pages.some((p: any) => p.uuid === op.documentId && p.parentSchematicUuid === active.schematicUuid) ||
      protectedBoard.schematicUuid === active.schematicUuid ||
      protectedBoard.pcbUuid === active.pcbUuid ||
      protectedBoard.pages.some((p: any) => p.uuid === op.documentId)
    )
      throw apiError(
        "protected_board",
        "Prune page must belong only to the explicitly expected non-original schematic/board."
      );
    return { target, active, protectedBoard };
  };
  const rows = (raw: any, keys: string[], label: string) => {
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", `${label} getter must return a native array.`);
    const list = raw.map((p) => Object.fromEntries(keys.map((k) => [k, prop(p, k)])));
    if (
      list.some((p) => typeof p.PrimitiveId !== "string" || !p.PrimitiveId) ||
      new Set(list.map((p) => p.PrimitiveId)).size !== list.length
    )
      throw apiError("unverified_inventory", `${label} native IDs missing/duplicated.`);
    return list.sort((a, b) => String(a.PrimitiveId).localeCompare(String(b.PrimitiveId)));
  };
  const componentRows = async () => {
    const raw = await read("Component.getAll current page", () => eda.sch_PrimitiveComponent.getAll(undefined, false));
    const list = rows(
      raw,
      [
        "PrimitiveId",
        "ComponentType",
        "Component",
        "Symbol",
        "Footprint",
        "UniqueId",
        "Designator",
        "Name",
        "X",
        "Y",
        "Rotation",
        "Mirror",
        "SubPartName",
        "AddIntoBom",
        "AddIntoPcb",
        "Manufacturer",
        "ManufacturerId",
        "Supplier",
        "SupplierId",
        "OtherProperty",
        "Net"
      ],
      "Components"
    );
    for (const c of list)
      if (
        typeof c.ComponentType !== "string" ||
        (c.ComponentType === "part" &&
          (typeof c.UniqueId !== "string" ||
            !c.UniqueId ||
            typeof c.Designator !== "string" ||
            !c.Designator ||
            !isRecord(c.Component) ||
            !isRecord(c.Footprint) ||
            ![c.X, c.Y, c.Rotation].every(Number.isFinite) ||
            typeof c.Mirror !== "boolean"))
      )
        throw apiError("unverified_inventory", "Part identity/uniqueId/public properties unavailable.");
    return list;
  };
  const snapshot = async () => {
    const context = await guard(),
      components = await componentRows();
    const rawWires = await read("Wire.getAll current page", () => eda.sch_PrimitiveWire.getAll());
    const wires = rows(rawWires, ["PrimitiveId", "Line", "Net", "Color", "LineWidth", "LineType"], "Wires");
    if (wires.some((w) => !Array.isArray(w.Line) || !(w.Line as any[]).flat().every(Number.isFinite)))
      throw apiError("unverified_inventory", "Native wire geometry unavailable.");
    let freeTexts: Record<string, unknown>[] | null = null;
    if (typeof eda.sch_PrimitiveText?.getAll === "function")
      freeTexts = rows(
        await read("Text.getAll", () => eda.sch_PrimitiveText.getAll()),
        [
          "PrimitiveId",
          "X",
          "Y",
          "Content",
          "Rotation",
          "TextColor",
          "FontName",
          "FontSize",
          "Bold",
          "Italic",
          "UnderLine",
          "AlignMode"
        ],
        "Free texts"
      );
    const timeout = Math.max(1, Math.min(10000, deadline - Date.now()));
    ensure();
    const native = await collectNativeNetlist(eda, false, timeout, "EasyEDA");
    ensure();
    if (
      native.status !== "available" ||
      native.format !== "EasyEDA" ||
      !native.text ||
      !native.scope?.verified ||
      native.scope.schematicUuid !== context.active.schematicUuid ||
      native.ambiguousDesignators?.length
    )
      throw apiError(
        "unverified_native_membership",
        `Prune requires a full unambiguous, verified-scope native EasyEDA pin map including NC: ${native.reason ?? native.status}`
      );
    const data = JSON.parse(native.text),
      assignments = new Map<string, string>(),
      nativeDesignators: string[] = [];
    for (const c of Object.values(data.components) as any[]) {
      const ref = c.props.Designator;
      nativeDesignators.push(ref);
      for (const [key, p] of Object.entries(c.pinInfoMap) as any) {
        const number = p.number ?? p.props?.["Pin Number"] ?? key,
          member = `${ref}\u0000${number}`;
        if (assignments.has(member) || typeof p.net !== "string")
          throw apiError("unverified_native_membership", "Native pin assignments ambiguous/missing.");
        assignments.set(member, p.net);
      }
    }
    const pins: any[] = [];
    for (const c of components.filter((c) => c.ComponentType === "part")) {
      const partPins = rows(
        await read(`Component.getAllPins ${c.PrimitiveId}`, () =>
          eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.PrimitiveId)
        ),
        ["PrimitiveId", "PinNumber", "PinName", "X", "Y", "Rotation", "PinLength", "PinShape", "PinType"],
        "Pins"
      );
      if (!partPins.length || new Set(partPins.map((p) => String(p.PinNumber))).size !== partPins.length)
        throw apiError("unverified_native_membership", "A part has missing/duplicate native pin numbers.");
      for (const p of partPins) {
        const number = String(p.PinNumber ?? ""),
          key = `${c.Designator}\u0000${number}`;
        if (!number || !assignments.has(key) || ![p.X, p.Y].every(Number.isFinite))
          throw apiError(
            "unverified_native_membership",
            `Native pin map/position incomplete for ${String(c.Designator)}#${number}; no geometric inference permitted.`
          );
        pins.push({ ...p, componentId: c.PrimitiveId, pinNumber: number, net: assignments.get(key) });
      }
    }
    const after = await guard();
    if (!equal(after.active, context.active) || !equal(after.protectedBoard, context.protectedBoard))
      throw apiError("target_mismatch", "Board links changed during prune snapshot.");
    return JSON.parse(
      canonicalJson({
        context: { active: context.active, protectedBoard: context.protectedBoard },
        components,
        wires,
        pins,
        freeTexts,
        nativeDesignators: nativeDesignators.sort(),
        ...(includeNativeBindings
          ? {
              nativeUniqueIds: Object.keys(data.components).sort(),
              nativeMembership: Object.entries(data.components)
                .map(([uniqueId, c]: [string, any]) => ({
                  uniqueId,
                  designator: c.props.Designator,
                  pins: Object.entries(c.pinInfoMap)
                    .map(([key, p]: [string, any]) => ({
                      pinNumber: String(p.number ?? p.props?.["Pin Number"] ?? key),
                      net: p.net
                    }))
                    .sort((a, b) => a.pinNumber.localeCompare(b.pinNumber))
                }))
                .sort((a, b) => a.uniqueId.localeCompare(b.uniqueId))
            }
          : {}),
        nativeScope: native.scope
      })
    );
  };
  return { eda, ensure, read, guard, snapshot, componentRows, deadline };
}
function selected(before: any, op: ReturnType<typeof options>) {
  for (const id of op.componentIds)
    if (!before.components.some((c: any) => c.PrimitiveId === id && c.ComponentType === "part"))
      throw apiError(
        "invalid_selection",
        `Selected component ${id} is not a current-page part; netflags/sheets/ports are not supported.`
      );
  for (const id of op.wireIds)
    if (!before.wires.some((w: any) => w.PrimitiveId === id))
      throw apiError("invalid_selection", `Selected wire ${id} is absent from this page.`);
}
export async function prepareSchematicPrune(api: () => EasyEdaApi, params: Record<string, any>) {
  const op = options(params),
    env = schematicLegacySnapshotEnvironment(api, op),
    context = await env.guard(),
    before = await env.snapshot();
  selected(before, op);
  const removed = new Set(op.componentIds);
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: "prunePage",
    target: context.target,
    operation: op,
    before,
    requestedAfter: {
      deletedComponentIds: op.componentIds,
      deletedWireIds: op.wireIds,
      keptPinNetMap: before.pins
        .filter((p: any) => !removed.has(p.componentId))
        .map((p: any) => ({ componentId: p.componentId, pinNumber: p.pinNumber, net: p.net })),
      protectedBoardUnchanged: op.protectedBoardName,
      freeTextsUntouched: true
    },
    changedKeys: ["deletedComponentIds", "deletedWireIds"],
    scope: `schematic:prune:${op.projectId}:${op.documentId}`,
    impact:
      "Delete only reviewed explicit component/wire IDs on the explicitly named copied board. Protected original, every unselected public component/pin/net/wire and free text snapshot must stay unchanged. Exactly one SDK delete per selected type; no fallback, rollback or replay.",
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executeSchematicPrune(
  api: () => EasyEdaApi,
  record: any
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const op = options(record.operation),
    env = schematicLegacySnapshotEnvironment(api, op),
    journal: Record<string, any> = {
      phase: "preflight",
      componentIds: op.componentIds,
      wireIds: op.wireIds,
      componentDeleteCalls: 0,
      wireDeleteCalls: 0,
      sdkPending: false
    };
  const progress = (phase: string, patch: Record<string, any> = {}) => {
    Object.assign(journal, patch, { phase });
    const state = extensionMutations.getExecutionState();
    if (state.lockHeld && state.activeMutationId === record.mutationId)
      extensionMutations.recordExecutionEvidence(record.mutationId, journal);
  };
  const continueWrite = () => {
    env.ensure();
    const current = extensionMutations.getExecutionState();
    if (current.activeMutationId === record.mutationId && current.activeStatus !== "running")
      throw new Error("Original lifecycle is unknown; no later delete is permitted after late SDK settlement.");
  };
  progress("preflight");
  const before = await env.snapshot();
  selected(before, op);
  if (!equal(before, record.before))
    throw apiError(
      "stale_snapshot",
      "Full native page/public properties/pin nets changed since prune preview; no delete."
    );
  const components = new Set(op.componentIds),
    wires = new Set(op.wireIds),
    keptComponents = before.components.filter((c: any) => !components.has(c.PrimitiveId)),
    keptWires = before.wires.filter((w: any) => !wires.has(w.PrimitiveId)),
    keptPins = before.pins.filter((p: any) => !components.has(p.componentId));
  let writeStarted = false;
  try {
    if (op.componentIds.length) {
      continueWrite();
      await env.guard();
      continueWrite();
      writeStarted = true;
      progress("component_delete_dispatched", { componentDeleteCalls: 1, sdkPending: true });
      // Deliberately await the original non-cancellable SDK promise. Lifecycle timeout
      // must retain the lock until this executor settles; never race native writes.
      const result = await env.eda.sch_PrimitiveComponent.delete(op.componentIds);
      progress("component_delete_acknowledged", { sdkPending: false, componentDeleteReturnedTrue: result === true });
      continueWrite();
      if (result !== true) throw new Error("Native component delete did not acknowledge true; wire batch is blocked.");
      const until = Math.min(env.deadline, Date.now() + 3000);
      let componentReadPolls = 0;
      while (true) {
        continueWrite();
        await env.guard();
        const after = await env.componentRows();
        componentReadPolls++;
        if (equal(after, keptComponents)) break;
        if (Date.now() >= until)
          throw new Error("Component delete absence/kept-property readback mismatch; no wire delete.");
        await env.read(
          "component absence propagation wait",
          () => new Promise<void>((resolve) => setTimeout(resolve, 100))
        );
      }
      progress("component_absence_verified", { componentReadPolls });
    }
    if (op.wireIds.length) {
      continueWrite();
      await env.guard();
      continueWrite();
      writeStarted = true;
      progress("wire_delete_dispatched", { wireDeleteCalls: 1, sdkPending: true });
      const result = await env.eda.sch_PrimitiveWire.delete(op.wireIds);
      progress("wire_delete_acknowledged", { sdkPending: false, wireDeleteReturnedTrue: result === true });
      continueWrite();
      if (result !== true) throw new Error("Native wire delete did not acknowledge true.");
    }
    progress("readback");
    const after = await env.snapshot();
    if (
      !equal(after.context, before.context) ||
      !equal(after.components, keptComponents) ||
      !equal(after.wires, keptWires) ||
      !equal(after.pins, keptPins) ||
      !equal(after.freeTexts, before.freeTexts) ||
      op.componentIds.some((id) =>
        after.nativeDesignators.includes(before.components.find((c: any) => c.PrimitiveId === id).Designator)
      )
    )
      throw new Error(
        "Deleted absence or protected board/kept public properties/pins/native nets/wires/free text readback mismatch."
      );
    progress("applied");
    return {
      executed: true,
      readback: {
        verified: true,
        projectId: op.projectId,
        documentId: op.documentId,
        boardName: op.expectedBoardName,
        protectedBoardName: op.protectedBoardName,
        deletedComponents: op.componentIds.length,
        deletedWires: op.wireIds.length,
        keptComponents: after.components.length,
        keptWires: after.wires.length,
        keptPinNetMap: after.pins.map((p: any) => ({ componentId: p.componentId, pinNumber: p.pinNumber, net: p.net })),
        freeTextUnchanged: after.freeTexts !== null,
        freeTextObservation: after.freeTexts === null ? "reader_unavailable" : "native_snapshot_equal",
        deletedIdsAbsent: true,
        protectedBoardLinksUnchanged: true,
        nativeScope: after.nativeScope,
        journal
      }
    };
  } catch (error) {
    if (!writeStarted) throw error;
    progress("unknown", { sdkPending: false, error: String(error) });
    throw apiError(
      "write_readback_unknown",
      `Explicit schematic prune unknown; keep journal and inspect native state; never replay. mutationId=${record.mutationId}; ${String(error)}`,
      { journal }
    );
  }
}
