import { canonicalJson, type MutationRecord } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";
import { getBoardInventory } from "./boardOperations.js";
import { extensionMutations } from "./mutationManager.js";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
function explicitId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  )
    throw apiError(
      "invalid_params",
      `Explicit ${label} must be a nonempty identifier without whitespace or control characters.`
    );
  return value;
}
function inventoryState(inventory: any) {
  return { projectId: inventory.projectId, currentBoardName: inventory.currentBoardName, boards: inventory.boards };
}
type Snapshot = {
  projectId: string;
  currentBoardName: string | null;
  boards: any[];
  pageMetadata: Record<string, any>;
};
type Operation = {
  pageAction: "copy" | "delete";
  projectId: string;
  pageUuid: string;
  owningSchematicUuid: string;
  destinationSchematicUuid?: string;
  protectedBoardName?: string;
};
function environment(api: () => EasyEdaApi) {
  const eda = api(),
    deadline = Date.now() + 40_000;
  function requireMethod(name: string) {
    if (typeof eda.dmt_Schematic?.[name] !== "function")
      throw apiError("capability_unavailable", `Public legacy dmt_Schematic.${name} is required; no fallback.`);
  }
  requireMethod("getSchematicPageInfo");
  async function call<T>(label: string, fn: () => T | Promise<T>, budgetMs = 8_000): Promise<T> {
    const remaining = Math.min(budgetMs, deadline - Date.now());
    if (remaining <= 0) throw apiError("native_timeout", `Schematic-page total budget exhausted before ${label}.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(apiError("native_timeout", `${label} exceeded its budget; SDK cancellation is unavailable.`)),
            remaining
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function read(projectId: string, expectedTarget?: any) {
    const inventory = await call("native board/page inventory", () =>
      getBoardInventory(api, { projectId, target: expectedTarget })
    );
    const ids: string[] = [],
      pages: any[] = [];
    for (const board of inventory.boards) {
      ids.push(board.schematic.uuid, board.pcb.uuid);
      for (const page of board.schematic.pages) {
        ids.push(page.uuid);
        pages.push(page);
      }
    }
    if (!inventory.currentBoardName || new Set(ids).size !== ids.length || !ids.includes(inventory.target.documentId!))
      throw apiError(
        "unverified_inventory",
        "Unique native board/SCH/PCB/page identities and an inventoried current board/document are required."
      );
    const pageMetadata: Record<string, any> = Object.create(null);
    for (const page of pages) {
      const raw = await call("getSchematicPageInfo", () => eda.dmt_Schematic.getSchematicPageInfo(page.uuid));
      if (
        !isRecord(raw) ||
        raw.uuid !== page.uuid ||
        raw.parentSchematicUuid !== page.parentSchematicUuid ||
        raw.name !== page.name ||
        (raw.parentProjectUuid !== undefined && raw.parentProjectUuid !== projectId)
      )
        throw apiError(
          "unverified_inventory",
          "Native page metadata UUID/name/ownership does not match the project inventory."
        );
      try {
        pageMetadata[page.uuid] = clone(raw);
      } catch {
        throw apiError(
          "unverified_inventory",
          "Page metadata must be finite plain JSON; no guessed metadata fallback."
        );
      }
    }
    const final = await call("final native board/page inventory", () =>
      getBoardInventory(api, { projectId, target: inventory.target })
    );
    if (!equal(inventoryState(inventory), inventoryState(final)))
      throw apiError("unverified_inventory", "Board/page inventory changed while metadata was read.");
    return { target: inventory.target, snapshot: clone({ ...inventoryState(inventory), pageMetadata }) as Snapshot };
  }
  const wait = (poll: number) =>
    call(
      "read-only propagation wait",
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(1000, 250 * poll, Math.max(1, deadline - Date.now())));
        })
    );
  return { eda, deadline, call, read, wait, requireMethod };
}
function owner(snapshot: Snapshot, pageUuid: string) {
  const found = snapshot.boards.filter((b) => b.schematic.pages.some((p: any) => p.uuid === pageUuid));
  if (found.length !== 1)
    throw apiError("page_not_found", "Explicit page UUID must resolve uniquely in verified project metadata.");
  return found[0];
}
function validateOperation(op: Operation, snapshot: Snapshot) {
  const source = owner(snapshot, op.pageUuid);
  if (source.schematic.uuid !== op.owningSchematicUuid)
    throw apiError("invalid_target", "Explicit page UUID belongs to a different owning schematic.");
  if (op.pageAction === "copy") {
    const dest = snapshot.boards.filter((b) => b.schematic.uuid === op.destinationSchematicUuid);
    if (dest.length !== 1 || dest[0].schematic.uuid === source.schematic.uuid)
      throw apiError(
        "invalid_target",
        "Copy requires a distinct, uniquely verified destination schematic in the same project."
      );
  } else {
    const protectedBoardName = explicitId(op.protectedBoardName, "protectedBoardName");
    const protectedBoard = snapshot.boards.find((b) => b.name === protectedBoardName);
    if (!protectedBoard)
      throw apiError("unverified_inventory", "Explicit protected board must exist in the verified project inventory.");
    if (source.schematic.uuid === protectedBoard.schematic.uuid)
      throw apiError("protected_board", "Deleting any page belonging to the explicit protected board is forbidden.");
    if (source.schematic.pages.length <= 1)
      throw apiError("last_page", "Deleting the last page of a schematic is forbidden.");
  }
}
async function prepare(api: () => EasyEdaApi, params: Record<string, any>, action: "copy" | "delete") {
  const projectId = explicitId(params.projectId, "projectId");
  const pageUuid = explicitId(
    action === "copy" ? params.sourcePageId : params.pageUuid,
    action === "copy" ? "sourcePageId" : "pageUuid"
  );
  const destinationSchematicUuid =
    action === "copy" ? explicitId(params.destinationSchematicUuid, "destinationSchematicUuid") : undefined;
  const requestedOwner =
    action === "delete" ? explicitId(params.owningSchematicUuid, "owningSchematicUuid") : undefined;
  const protectedBoardName =
    action === "delete" ? explicitId(params.protectedBoardName, "protectedBoardName") : undefined;
  const env = environment(api);
  env.requireMethod(action === "copy" ? "copySchematicPage" : "deleteSchematicPage");
  const { target, snapshot } = await env.read(projectId, params.target);
  const owningSchematicUuid = requestedOwner ?? owner(snapshot, pageUuid).schematic.uuid;
  const operation: Operation = {
    pageAction: action,
    projectId,
    pageUuid,
    owningSchematicUuid,
    ...(destinationSchematicUuid ? { destinationSchematicUuid } : {}),
    ...(protectedBoardName ? { protectedBoardName } : {})
  };
  validateOperation(operation, snapshot);
  const destructive = action === "delete";
  const record = extensionMutations.prepare({
    domain: "schematic",
    action: destructive ? "deleteSchematicPage" : "copySchematicPage",
    target,
    operation: operation as unknown as Record<string, unknown>,
    before: snapshot,
    requestedAfter: destructive
      ? {
          deletedPageUuid: pageUuid,
          owningSchematicUuid,
          protectedBoardName,
          nativeReturnMustBeTrue: true,
          otherPagesUnchanged: true
        }
      : { sourcePageId: pageUuid, destinationSchematicUuid, exactlyOneNewPage: true, sourceUnchanged: true },
    changedKeys: ["schematicPages"],
    scope: `project:${projectId}:schematicPages`,
    ttlMs: 300_000,
    impact: destructive
      ? "DESTRUCTIVE: delete exactly the explicitly identified non-last page after exact confirmation. Full page contents are removed; backup/working-copy status and contents are not independently verified. No implicit cleanup."
      : "Copy one page to an explicit other schematic in this project after exact confirmation. Prove metadata delta/source preservation only; symbol/wire/net contents are not verified. No cleanup, rename, write fallback or replay."
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: record.action,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt,
    destructive,
    nativeMetadataVerified: true,
    contentsVerified: false
  };
}
export function prepareSchematicPageCopy(api: () => EasyEdaApi, params: Record<string, any>) {
  return prepare(api, params, "copy");
}
export function prepareSchematicPageDelete(api: () => EasyEdaApi, params: Record<string, any>) {
  return prepare(api, params, "delete");
}
// Only native-derived leaf values in the changed schematic may propagate.
// All UUIDs, names, ownership, field settings and unrelated pages remain exact.
function derivedMetadata(expected: Snapshot, after: Snapshot, op: Operation) {
  const schematicUuid = op.pageAction === "delete" ? op.owningSchematicUuid : op.destinationSchematicUuid;
  const board = after.boards.find((b) => b.schematic.uuid === schematicUuid);
  if (!board) return;
  const changes: { pageUuid: string; field: string; before: unknown; after: unknown }[] = [];
  for (const page of board.schematic.pages) {
    const old = expected.pageMetadata[page.uuid]?.titleBlockData;
    const next = after.pageMetadata[page.uuid]?.titleBlockData;
    if (!old || !next) continue;
    for (const field of ["@Page Count", "@Page No", "@Update Date", "@Update Time"]) {
      if (!isRecord(old[field]) || !isRecord(next[field]) || equal(old[field].value, next[field].value)) continue;
      const value = next[field].value;
      if (field === "@Page Count" && Number(value) !== board.schematic.pageCount) return;
      if (field === "@Page No") {
        const numbers = board.schematic.pages.map((p: any) =>
          Number(after.pageMetadata[p.uuid]?.titleBlockData?.[field]?.value)
        );
        if (
          numbers.some((n: number) => !Number.isInteger(n) || n < 1 || n > numbers.length) ||
          new Set(numbers).size !== numbers.length
        )
          return;
        const survivors = board.schematic.pages.filter(
          (p: any) => expected.pageMetadata[p.uuid]?.titleBlockData?.[field]
        );
        const oldOrder = [...survivors]
          .sort(
            (a: any, b: any) =>
              Number(expected.pageMetadata[a.uuid].titleBlockData[field].value) -
              Number(expected.pageMetadata[b.uuid].titleBlockData[field].value)
          )
          .map((p: any) => p.uuid);
        const newOrder = [...survivors]
          .sort(
            (a: any, b: any) =>
              Number(after.pageMetadata[a.uuid].titleBlockData[field].value) -
              Number(after.pageMetadata[b.uuid].titleBlockData[field].value)
          )
          .map((p: any) => p.uuid);
        if (!equal(oldOrder, newOrder)) return;
      }
      if (
        (field === "@Update Date" || field === "@Update Time") &&
        (typeof value !== "string" || !value.trim() || value.length > 100)
      )
        return;
      changes.push({ pageUuid: page.uuid, field, before: old[field].value, after: value });
    }
  }
  for (const change of changes)
    expected.pageMetadata[change.pageUuid].titleBlockData[change.field].value = clone(change.after);
  return changes;
}
function proof(before: Snapshot, after: Snapshot, op: Operation, nativeResult: unknown, observedDelete = false) {
  if (before.projectId !== after.projectId) return;
  const expected = clone(before);
  if (op.pageAction === "copy") {
    if (
      typeof nativeResult !== "string" ||
      !nativeResult ||
      nativeResult !== nativeResult.trim() ||
      before.pageMetadata[nativeResult]
    )
      return;
    const dest = after.boards.find((b) => b.schematic.uuid === op.destinationSchematicUuid);
    const created = dest?.schematic.pages.find((p: any) => p.uuid === nativeResult);
    if (!created || !after.pageMetadata[nativeResult]) return;
    const expectedDest = expected.boards.find((b) => b.schematic.uuid === op.destinationSchematicUuid)!;
    expectedDest.schematic.pages.push(clone(created));
    expectedDest.schematic.pages.sort((a: any, b: any) => a.uuid.localeCompare(b.uuid));
    expectedDest.schematic.pageCount++;
    expected.pageMetadata[nativeResult] = clone(after.pageMetadata[nativeResult]);
    const allowedDerivedChanges = derivedMetadata(expected, after, op);
    if (
      !allowedDerivedChanges ||
      !equal(expected.boards, after.boards) ||
      !equal(expected.pageMetadata, after.pageMetadata)
    )
      return;
    return {
      allowedDerivedChanges,
      pageUuid: nativeResult,
      owningSchematicUuid: op.destinationSchematicUuid,
      sourcePageId: op.pageUuid,
      sourcePreserved: true,
      exactlyOneNewPage: true,
      otherPagesPreserved: true
    };
  }
  if ((!observedDelete && nativeResult !== true) || after.pageMetadata[op.pageUuid]) return;
  const expectedOwner = expected.boards.find((b) => b.schematic.uuid === op.owningSchematicUuid)!;
  expectedOwner.schematic.pages = expectedOwner.schematic.pages.filter((p: any) => p.uuid !== op.pageUuid);
  expectedOwner.schematic.pageCount--;
  delete expected.pageMetadata[op.pageUuid];
  const allowedDerivedChanges = derivedMetadata(expected, after, op);
  if (
    !allowedDerivedChanges ||
    !equal(expected.boards, after.boards) ||
    !equal(expected.pageMetadata, after.pageMetadata)
  )
    return;
  return {
    allowedDerivedChanges,
    pageUuid: op.pageUuid,
    owningSchematicUuid: op.owningSchematicUuid,
    pageAbsent: true,
    otherPagesPreserved: true
  };
}
async function execute(api: () => EasyEdaApi, record: MutationRecord, action: "copy" | "delete") {
  const op = record.operation as unknown as Operation;
  if (
    record.domain !== "schematic" ||
    record.action !== (action === "copy" ? "copySchematicPage" : "deleteSchematicPage") ||
    op.pageAction !== action ||
    record.target.projectId !== op.projectId ||
    !isRecord(record.before) ||
    record.before.projectId !== op.projectId ||
    !isRecord(record.before.pageMetadata)
  )
    throw apiError("invalid_params", "A matching original staged page-copy/delete record is required.");
  const env = environment(api);
  const method = action === "copy" ? "copySchematicPage" : "deleteSchematicPage";
  env.requireMethod(method);
  const { snapshot } = await env.read(op.projectId, record.target);
  if (!equal(snapshot, record.before))
    throw apiError("stale_snapshot", "Exact native board/page metadata changed since preview; no write.");
  validateOperation(op, snapshot);
  let nativeResult: unknown, lastSnapshot: Snapshot | undefined, lastReadError: string | undefined;
  let polls = 0;
  try {
    // Do not race an uncancellable write: MutationLifecycle owns the caller deadline
    // and keeps its execution lock until this original SDK promise settles.
    nativeResult =
      action === "copy"
        ? await env.eda.dmt_Schematic.copySchematicPage(op.pageUuid, op.destinationSchematicUuid)
        : await env.eda.dmt_Schematic.deleteSchematicPage(op.pageUuid);
    if (action === "copy") {
      try {
        explicitId(nativeResult, "native copied page UUID");
      } catch {
        throw new Error("Copy returned no valid page UUID; retain any observed page and inspect it.");
      }
      if (snapshot.pageMetadata[nativeResult as string]) throw new Error("Copy returned an existing page UUID.");
    } else if (nativeResult !== true) throw new Error("Delete did not return native boolean true.");
    while (Date.now() < env.deadline) {
      polls++;
      try {
        const after = await env.read(op.projectId);
        lastSnapshot = after.snapshot;
        const evidence = proof(snapshot, after.snapshot, op, nativeResult);
        if (evidence)
          return {
            executed: true,
            readback: {
              action,
              projectId: op.projectId,
              ...evidence,
              inventoryVerified: true,
              metadataVerified: true,
              verified: action === "delete",
              contentsVerified: false,
              saved: false,
              nativeReturned: nativeResult,
              readbackPolls: polls,
              ...(lastReadError ? { lastTransientInventoryError: lastReadError } : {}),
              inventory: after.snapshot,
              limitations: [
                "Only native inventory and page metadata are compared; symbol/wire/net contents are not inspected.",
                "SDK cancellation is unavailable; no write fallback, rollback, cleanup or automatic replay."
              ]
            }
          };
      } catch (error) {
        if ((error as any)?.code !== "unverified_inventory") throw error;
        lastReadError = String(error);
      }
      await env.wait(polls);
    }
    throw new Error(
      "Expected exact page delta, ownership and preservation were not confirmed within the total budget."
    );
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Schematic page ${action} outcome unknown; never replay automatically or delete an inconclusive copy. mutationId=${record.mutationId}; ${String(error)}`,
      { mutationId: record.mutationId, nativeResult, lastSnapshot, lastReadError, sdkCancellationAvailable: false }
    );
  }
}
export function executeSchematicPageCopy(api: () => EasyEdaApi, record: MutationRecord) {
  return execute(api, record, "copy");
}
export function executeSchematicPageDelete(api: () => EasyEdaApi, record: MutationRecord) {
  return execute(api, record, "delete");
}

export async function getSchematicPageInventory(api: () => EasyEdaApi, params: Record<string, any>) {
  return environment(api).read(explicitId(params.projectId, "projectId"), params.target);
}
export async function reconcileSchematicPageDelete(api: () => EasyEdaApi, params: Record<string, any>) {
  return extensionMutations.reconcileSettledUnknown({
    mutationId: explicitId(params.mutationId, "mutationId"),
    domain: "schematic",
    action: "deleteSchematicPage",
    originalRecord: params.originalRecord,
    verify: async (record) => {
      const op = record.operation as unknown as Operation;
      if (
        op?.pageAction !== "delete" ||
        record.target?.projectId !== op.projectId ||
        !isRecord(record.before?.pageMetadata)
      )
        throw apiError("reconciliation_invalid", "Original native page deletion receipt required.");
      validateOperation(op, record.before as Snapshot);
      const after = await environment(api).read(op.projectId, params.target);
      const evidence = proof(record.before as Snapshot, after.snapshot, op, undefined, true);
      if (!evidence)
        throw apiError(
          "reconciliation_unproven",
          "Exact deletion and preservation of all other native page metadata are not proven; no replay or status change."
        );
      return {
        ...evidence,
        inventory: after.snapshot,
        reconciledReadOnly: true,
        observedDesiredState: true,
        nativeDeleteReplayed: false,
        nativeBooleanAcknowledgmentRetained: false,
        verified: false,
        inventoryVerified: true,
        metadataVerified: true,
        contentsVerified: false,
        limitations: [
          "Original SDK boolean acknowledgment was not retained. Reconciliation proves the observed metadata delta only, not symbol/wire contents."
        ]
      };
    }
  });
}
