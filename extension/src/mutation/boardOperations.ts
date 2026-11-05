import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function name(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  )
    throw apiError("invalid_params", "Explicit nonempty board name required (max200, no control characters).");
  return value;
}
function environment(api: () => EasyEdaApi) {
  const eda = api(),
    deadline = Date.now() + 40000;
  const call = async <T>(step: string, fn: () => Promise<T> | T, budgetMs = 5000): Promise<T> => {
    const remaining = Math.min(budgetMs, deadline - Date.now());
    if (remaining <= 0)
      throw apiError("native_timeout", `Board operation total budget expired before ${step}. No retry.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                apiError(
                  "native_timeout",
                  `Board step ${step} exceeded ${remaining}ms. SDK cancellation unavailable; no retry.`
                )
              ),
            remaining
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const require = (owner: any, method: string) => {
    if (typeof owner?.[method] !== "function")
      throw apiError("capability_unavailable", `Public legacy method ${method} is required.`);
  };
  require(eda.dmt_Project, "getCurrentProjectInfo");
  require(eda.dmt_SelectControl, "getCurrentDocumentInfo");
  require(eda.dmt_Board, "getAllBoardsInfo");
  require(eda.dmt_Board, "getCurrentBoardInfo");
  const text = (v: any, label: string) => {
    if (typeof v !== "string" || !v) throw apiError("unverified_inventory", `Native board inventory ${label} missing.`);
    return v;
  };
  const normalize = (raw: any, projectId: string) => {
    if (
      !isRecord(raw) ||
      raw.parentProjectUuid !== projectId ||
      !isRecord(raw.schematic) ||
      !isRecord(raw.pcb) ||
      raw.schematic.parentProjectUuid !== projectId ||
      raw.pcb.parentProjectUuid !== projectId ||
      !Array.isArray(raw.schematic.page)
    )
      throw apiError("unverified_inventory", "Native board/SCH/PCB/page links do not belong to the expected project.");
    const schId = text(raw.schematic.uuid, "schematic uuid");
    const pages = raw.schematic.page
      .map((p: any) => {
        if (p?.parentSchematicUuid !== schId)
          throw apiError("unverified_inventory", "Page belongs to another schematic.");
        return { uuid: text(p.uuid, "page uuid"), name: text(p.name, "page name"), parentSchematicUuid: schId };
      })
      .sort((a: any, b: any) => a.uuid.localeCompare(b.uuid));
    if (!pages.length || new Set(pages.map((p: any) => p.uuid)).size !== pages.length)
      throw apiError("unverified_inventory", "Nonempty unique native schematic pages required.");
    return {
      ...(typeof raw.uuid === "string" && raw.uuid ? { uuid: raw.uuid } : {}),
      name: text(raw.name, "name"),
      projectId,
      schematic: { uuid: schId, name: text(raw.schematic.name, "schematic name"), pageCount: pages.length, pages },
      pcb: { uuid: text(raw.pcb.uuid, "pcb uuid"), name: text(raw.pcb.name, "pcb name") }
    };
  };
  const read = async (expectedProjectId?: string, expectedTarget?: any, includeActiveCounts = false) => {
    const project = await call("dmt_Project.getCurrentProjectInfo", () => eda.dmt_Project.getCurrentProjectInfo());
    const projectId = text(project?.uuid, "project uuid");
    if (expectedProjectId && projectId !== expectedProjectId)
      throw apiError("target_mismatch", "Active project differs from the explicit projectId.");
    const target = extractDocumentIdentity(
      await call("dmt_SelectControl.getCurrentDocumentInfo", () => eda.dmt_SelectControl.getCurrentDocumentInfo())
    );
    if (target.projectId !== projectId || !target.documentId)
      throw apiError("target_mismatch", "An identifiable active document in the expected project is required.");
    if (expectedTarget) assertDocumentTargetMatch(expectedTarget, target);
    const raw = await call("dmt_Board.getAllBoardsInfo", () => eda.dmt_Board.getAllBoardsInfo());
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", "Native boards getter did not return an array.");
    const boards = raw.map((b) => normalize(b, projectId)).sort((a, b) => a.name.localeCompare(b.name));
    if (new Set(boards.map((b) => b.name.toLowerCase())).size !== boards.length)
      throw apiError("unverified_inventory", "Duplicate board names make addressing ambiguous.");
    const current = await call("dmt_Board.getCurrentBoardInfo", () => eda.dmt_Board.getCurrentBoardInfo());
    const currentBoard = current ? normalize(current, projectId) : null;
    if (currentBoard && !boards.some((b) => equal(b, currentBoard)))
      throw apiError("unverified_inventory", "Current board is absent or differs from inventory.");
    let activeCounts: Record<string, unknown> | null = null;
    if (includeActiveCounts) {
      const native =
        target.documentType === "schematic"
          ? eda.sch_PrimitiveComponent
          : target.documentType === "pcb"
            ? eda.pcb_PrimitiveComponent
            : undefined;
      if (typeof native?.getAll === "function") {
        const all = await call("active legacy Component.getAll", () =>
          target.documentType === "schematic" ? native.getAll(undefined, false) : native.getAll()
        );
        if (!Array.isArray(all)) throw apiError("unverified_inventory", "Active component inventory is not an array.");
        activeCounts = {
          scope: target.documentType === "schematic" ? "active_page" : "active_pcb",
          documentId: target.documentId,
          componentCount: all.length
        };
      }
    }
    const finalProject = await call("dmt_Project.getCurrentProjectInfo final", () =>
      eda.dmt_Project.getCurrentProjectInfo()
    );
    const finalTarget = extractDocumentIdentity(
      await call("dmt_SelectControl.getCurrentDocumentInfo final", () => eda.dmt_SelectControl.getCurrentDocumentInfo())
    );
    if (finalProject?.uuid !== projectId) throw apiError("target_mismatch", "Project changed while reading inventory.");
    assertDocumentTargetMatch(target, finalTarget);
    return {
      projectId,
      currentBoardName: currentBoard?.name ?? null,
      target,
      boards,
      activeCounts,
      capturedAt: new Date().toISOString(),
      readOnly: true
    };
  };
  return { eda, call, require, read, deadline };
}
export async function getBoardInventory(api: () => EasyEdaApi, params: Record<string, any> = {}) {
  return environment(api).read(params.projectId, params.target, params.includeActiveCounts === true);
}
const state = (inventory: any) => ({
  projectId: inventory.projectId,
  currentBoardName: inventory.currentBoardName,
  boards: inventory.boards
});
export async function prepareBoardOperation(api: () => EasyEdaApi, params: Record<string, any>) {
  if (!["copy", "rename"].includes(params.action) || typeof params.projectId !== "string" || !params.projectId)
    throw apiError("invalid_params", "Explicit action copy/rename and projectId required.");
  const sourceBoardName = name(params.sourceBoardName),
    env = environment(api);
  if (params.action === "copy" && params.newName !== undefined)
    throw apiError(
      "invalid_params",
      "copyBoard accepts only source name; choose a new name in a separate rename mutation after native copy readback."
    );
  const newName = params.action === "rename" ? name(params.newName) : undefined;
  env.require(env.eda.dmt_Board, params.action === "copy" ? "copyBoard" : "modifyBoardName");
  const inventory = await env.read(params.projectId, params.target);
  if (!inventory.currentBoardName)
    throw apiError("invalid_target", "An independently identified current board is required.");
  const source = inventory.boards.find((b) => b.name === sourceBoardName);
  if (!source) throw apiError("not_found", "Explicit source board does not exist in this project.");
  if (newName && inventory.boards.some((b) => b.name.toLowerCase() === newName.toLowerCase()))
    throw apiError("destination_exists", "Board rename cannot overwrite any existing name, including itself.");
  const record = extensionMutations.prepare({
    domain: "project",
    action: params.action === "copy" ? "copyBoard" : "renameBoard",
    target: inventory.target,
    operation: { action: params.action, projectId: params.projectId, sourceBoardName, ...(newName ? { newName } : {}) },
    before: state(inventory),
    requestedAfter:
      params.action === "copy"
        ? {
            oneAdditionalBoard: true,
            originalPreserved: true,
            nativeGeneratedName: true,
            componentCountsVerified: false
          }
        : { oldName: sourceBoardName, newName, preserveLinkedDocumentUuids: true },
    changedKeys: params.action === "copy" ? ["boards"] : ["boardName"],
    scope: `project:${params.projectId}:boards`,
    impact:
      params.action === "copy"
        ? "Copy one whole board through public legacy copyBoard(sourceName), preserving the original. No overwrite, implicit rename, cleanup, deletion or source API. Copied component/net/3D contents require independent subsequent inspection."
        : "Rename exactly one existing board through public modifyBoardName(old,new), without replacing its linked SCH/PCB documents.",
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt,
    sourceBoard: source
  };
}
function copyEvidence(
  before: any,
  sourceBoardName: string,
  inventory: any,
  reportedName?: string
): Record<string, unknown> | undefined {
  const boards = inventory.boards,
    source = before.boards.find((b: any) => b.name === sourceBoardName);
  if (!source || inventory.projectId !== before.projectId) return;
  const added = boards.filter((b: any) => !before.boards.some((old: any) => old.name === b.name));
  const created = added[0];
  const oldIds = new Set(
    before.boards.flatMap((b: any) => [b.schematic.uuid, b.pcb.uuid, ...b.schematic.pages.map((p: any) => p.uuid)])
  );
  const newIds = created
    ? [created.schematic.uuid, created.pcb.uuid, ...created.schematic.pages.map((p: any) => p.uuid)]
    : [];
  if (
    boards.length !== before.boards.length + 1 ||
    added.length !== 1 ||
    (reportedName !== undefined && created.name !== reportedName) ||
    !before.boards.every((old: any) => boards.some((b: any) => equal(b, old))) ||
    new Set(newIds).size !== newIds.length ||
    !newIds.every((id) => !oldIds.has(id)) ||
    !equal(
      created.schematic.pages.map((p: any) => p.name).sort(),
      source.schematic.pages.map((p: any) => p.name).sort()
    )
  )
    return;
  return {
    action: "copy",
    projectId: before.projectId,
    inventoryVerified: true,
    verified: false,
    sourcePreserved: true,
    newBoard: created,
    ...(reportedName !== undefined ? { nativeReturnedName: reportedName } : {}),
    pageCountsVerified: true,
    componentCountsVerified: false,
    padNetMapsVerified: false,
    modelGeometryVerified: false,
    inventory,
    limitations: [
      "SCH/PCB/page links and page counts verified; component/pad/net/3D contents are not observed.",
      "No copied document was opened, deleted or silently renamed."
    ]
  };
}
export async function reconcileBoardCopy(api: () => EasyEdaApi, params: Record<string, any>) {
  if (typeof params.mutationId !== "string" || !params.mutationId || params.mutationId.length > 128)
    throw apiError("invalid_params", "Explicit original copy mutationId required.");
  return extensionMutations.reconcileSettledUnknown({
    mutationId: params.mutationId,
    domain: "project",
    action: "copyBoard",
    originalRecord: params.originalRecord,
    verify: async (record) => {
      const op = record.operation;
      if (
        op?.action !== "copy" ||
        typeof op.projectId !== "string" ||
        typeof op.sourceBoardName !== "string" ||
        record.before?.projectId !== op.projectId ||
        record.target?.projectId !== op.projectId ||
        !Array.isArray(record.before.boards)
      )
        throw apiError("reconciliation_invalid", "Original board-copy before/operation/target evidence is incomplete.");
      const inventory = await environment(api).read(op.projectId, params.target);
      const proof = copyEvidence(record.before, op.sourceBoardName, inventory);
      if (!proof)
        throw apiError(
          "reconciliation_unproven",
          "Copy proof requires exactly one additional complete board, distinct links/page counts and every original board unchanged; no status promotion or write."
        );
      return {
        ...proof,
        reconciledReadOnly: true,
        proofMethod: "original_before_plus_fresh_native_inventory_delta",
        nativeCopyReplayed: false,
        contentsVerified: false
      };
    }
  });
}

export async function executeBoardOperation(
  api: () => EasyEdaApi,
  record: any
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const op = record.operation,
    env = environment(api);
  env.require(env.eda.dmt_Board, op.action === "copy" ? "copyBoard" : "modifyBoardName");
  const before = await env.read(op.projectId, record.target);
  if (!equal(state(before), record.before))
    throw apiError("stale_snapshot", "Board/project/current-board inventory changed since preview; no write.");
  const source = before.boards.find((b) => b.name === op.sourceBoardName)!;
  if (op.action === "rename" && before.boards.some((b) => b.name.toLowerCase() === op.newName.toLowerCase()))
    throw apiError("destination_exists", "Rename destination exists; no write.");
  let nativeResult: unknown;
  let lastInventory: any;
  try {
    nativeResult =
      op.action === "copy"
        ? await env.call("dmt_Board.copyBoard", () => env.eda.dmt_Board.copyBoard(op.sourceBoardName), 30000)
        : await env.call(
            "dmt_Board.modifyBoardName",
            () => env.eda.dmt_Board.modifyBoardName(op.sourceBoardName, op.newName),
            30000
          );
    const until = env.deadline;
    let polls = 0,
      lastInventoryError: string | undefined;
    let problem = "Native board inventory not yet confirmed.";
    do {
      try {
        lastInventory = await env.read(op.projectId);
        polls++;
      } catch (error) {
        if ((error as any)?.code !== "unverified_inventory") throw error;
        polls++;
        lastInventoryError = String(error);
        if (Date.now() >= until) throw error;
        await env.call(
          "transient copied metadata propagation wait",
          () => new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, 250 * polls)))
        );
        continue;
      }
      const after = lastInventory.boards;
      if (op.action === "copy") {
        if (typeof nativeResult === "string" && nativeResult) {
          const proof = copyEvidence(state(before), op.sourceBoardName, lastInventory, nativeResult);
          if (proof)
            return {
              executed: true,
              readback: {
                ...proof,
                readbackPolls: polls,
                ...(lastInventoryError ? { lastTransientInventoryError: lastInventoryError } : {})
              }
            };
        }
        problem =
          "copyBoard return/new-name/document links/page counts or original inventory preservation did not match.";
        if (nativeResult === undefined || nativeResult === null)
          throw new Error(problem + " Native returned no name; keep any observed copy and inspect it.");
      } else {
        const renamed = after.find((b: any) => b.name === op.newName),
          others = before.boards.filter((b) => b.name !== op.sourceBoardName);
        if (
          nativeResult === true &&
          renamed &&
          !after.some((b: any) => b.name === op.sourceBoardName) &&
          after.length === before.boards.length &&
          renamed.schematic.uuid === source.schematic.uuid &&
          renamed.pcb.uuid === source.pcb.uuid &&
          equal(renamed.schematic.pages, source.schematic.pages) &&
          others.every((old) => after.some((b: any) => equal(b, old)))
        )
          return {
            executed: true,
            readback: {
              action: "rename",
              projectId: op.projectId,
              inventoryVerified: true,
              verified: true,
              renamedBoard: renamed,
              linkedDocumentUuidsPreserved: true,
              inventory: lastInventory
            }
          };
        problem = "modifyBoardName return/name/document links did not match.";
      }
      if (Date.now() >= until) throw new Error(problem);
      await env.call(
        "read-only board propagation wait",
        () => new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, 250 * polls)))
      );
    } while (true);
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Board ${op.action} outcome unknown; never repeat automatically and never delete an inconclusive copy. mutationId=${record.mutationId}; ${String(error)}`,
      { mutationId: record.mutationId, nativeResult, lastInventory }
    );
  }
}
