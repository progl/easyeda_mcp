import {
  encodePcbPreservationInventory,
  decodePcbPreservationInventory,
  samePcbPreservationInventory,
  PCB_PRESERVATION_ENCODING
} from "./pcbPreservationEncoding.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError, isRecord } from "../helpers.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
import { createPcbPreservationEnvironment } from "./mechanicalPadMutations.js";

type Row = Record<string, any>;
const ACTION = "deleteExplicitFreePcbTexts";
const layers = [3, 4, 13];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(v: T): T => JSON.parse(canonicalJson(v));
const validId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512 && v === v.trim();
const style = [
  "PrimitiveId",
  "PrimitiveType",
  "Layer",
  "X",
  "Y",
  "Text",
  "FontFamily",
  "FontSize",
  "LineWidth",
  "AlignMode",
  "Rotation",
  "Reverse",
  "Expansion",
  "Mirror",
  "PrimitiveLock"
];
function input(params: Row, deleting = false) {
  const keys = ["projectId", "pcbUuid", "expectedBoardName", "protectedBoardName"];
  if (
    keys.some((k) => !validId(params[k])) ||
    params.protectedBoardName !== "Board1" ||
    params.expectedBoardName.toLowerCase() === "board1"
  )
    throw apiError(
      "invalid_params",
      "Explicit project/PCB/non-protected board and protectedBoardName:Board1 required."
    );
  if (deleting) {
    keys.push("primitiveIds", "expectedTexts", "keepTextIds");
    for (const k of ["primitiveIds", "keepTextIds"])
      if (
        !Array.isArray(params[k]) ||
        params[k].length > 100 ||
        params[k].some((id: unknown) => !validId(id)) ||
        new Set(params[k]).size !== params[k].length
      )
        throw apiError("invalid_params", `Explicit unique ${k} array (at most100) required.`);
    if (
      !params.primitiveIds.length ||
      !Array.isArray(params.expectedTexts) ||
      params.expectedTexts.length !== params.primitiveIds.length ||
      params.expectedTexts.some((t: any) => !isRecord(t)) ||
      params.primitiveIds.some((id: string) => params.keepTextIds.includes(id))
    )
      throw apiError(
        "invalid_params",
        "Exact nonempty delete IDs/expectedTexts and disjoint mandatory keepTextIds required."
      );
  }
  if (Object.keys(params).some((k) => !keys.includes(k)))
    throw apiError("invalid_params", "Unsupported free-text input; only exact delete is supported.");
  return clone(params);
}
function environment(api: () => EasyEdaApi, scope: Row) {
  const env = createPcbPreservationEnvironment(api, scope);
  env.require(env.eda.sys_Environment, ["getEditorCurrentVersion"], "Reviewed String dispatch version");
  env.require(env.eda.pcb_PrimitiveString, ["getAll", "get"], "Independent free String inventory");
  env.require(env.eda.pcb_PrimitiveAttribute, ["getAll"], "Independent component Attribute exclusion");
  async function guard() {
    const target = await env.guard();
    if ((await env.read("editor version", () => env.eda.sys_Environment.getEditorCurrentVersion(true))) !== "3.2.209")
      throw apiError(
        "capability_unavailable",
        "Free String parentless membership source audit is pinned to editor3.2.209."
      );
    return target;
  }
  function selected(state: Row, id: string) {
    const rows = state.inventory.groups.String.filter((p: Row) => p.PrimitiveId === id);
    const text = rows[0];
    if (
      rows.length !== 1 ||
      style.some((k) => text[k] === undefined) ||
      text.PrimitiveType !== "String" ||
      typeof text.Text !== "string" ||
      typeof text.FontFamily !== "string" ||
      !["X", "Y", "FontSize", "LineWidth", "AlignMode", "Rotation", "Expansion"].every(
        (k) => typeof text[k] === "number" && Number.isFinite(text[k])
      ) ||
      !["Reverse", "Mirror", "PrimitiveLock"].every((k) => typeof text[k] === "boolean") ||
      Object.entries(state.inventory.groups).some(
        ([kind, rows]) => kind !== "String" && (rows as Row[]).some((p) => p.PrimitiveId === id)
      ) ||
      state.inventory.componentPads.some((p: Row) => p.PrimitiveId === id) ||
      !layers.includes(text.Layer) ||
      state.attributes.some((p: Row) => p.PrimitiveId === id)
    )
      throw apiError(
        "invalid_selection",
        "Exact independently typed parentless String on layer3/4/13 required; component Attributes forbidden."
      );
    return text;
  }
  async function independent(state: Row, id: string) {
    const text = selected(state, id);
    const native = await env.read("String.get", () => env.eda.pcb_PrimitiveString.get(id));
    if (!native || !same(env.row(native), text))
      throw apiError("stale_snapshot", "Independent native String type/style differs from parentless inventory.");
    return text;
  }
  async function snapshot() {
    await guard();
    const boards = clone(await env.read("board baseline", () => env.eda.dmt_Board.getAllBoardsInfo()));
    const inventory = await env.snapshot();
    const raw = await env.read("Attribute.getAll", () => env.eda.pcb_PrimitiveAttribute.getAll());
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", "Complete native Attribute array required.");
    const attributes = raw
      .map((p: any): Row => env.row(p))
      .sort((a: Row, b: Row) => a.PrimitiveId.localeCompare(b.PrimitiveId));
    if (
      new Set(attributes.map((p: Row) => p.PrimitiveId)).size !== attributes.length ||
      attributes.some((p: Row) => p.PrimitiveType !== "Attribute" || !validId(p.ParentPrimitiveId))
    )
      throw apiError("unverified_inventory", "Attribute ID/type/parent inventory is incomplete or ambiguous.");
    const finalBoards = clone(await env.read("board final", () => env.eda.dmt_Board.getAllBoardsInfo()));
    await guard();
    if (!same(boards, finalBoards))
      throw apiError("stale_snapshot", "Board inventory changed during free-text observation.");
    return { boards, inventory, attributes };
  }
  return { ...env, guard, snapshot, selected, independent };
}
const encodeBefore = (state: Row) => ({
  boards: state.boards,
  attributes: state.attributes,
  inventory: encodePcbPreservationInventory(state.inventory)
});
const decodeBefore = (state: Row) => ({
  boards: state.boards,
  attributes: state.attributes,
  inventory: decodePcbPreservationInventory(state.inventory)
});
const sameState = (a: Row, b: Row) =>
  same(a.boards, b.boards) &&
  same(a.attributes, b.attributes) &&
  samePcbPreservationInventory(a.inventory, b.inventory);
const counts = (state: Row) => ({
  groups: Object.fromEntries(Object.entries(state.inventory.groups).map(([k, rows]) => [k, (rows as any[]).length])),
  componentPads: state.inventory.componentPads.length,
  attributes: state.attributes.length
});
const parentEvidence =
  "Reviewed3.2.209 public String.getAll membership filters !getParent(); String.get independently verifies type/style. No public String parent getter exists.";
export async function readPcbFreeTexts(api: () => EasyEdaApi, params: Row) {
  const scope = input(params),
    env = environment(api, scope),
    state = await env.snapshot();
  const texts = state.inventory.groups.String.filter((p: Row) => layers.includes(p.Layer));
  if (texts.length > 1000)
    throw apiError("inventory_too_large", "Free text inventory exceeds bounded1000 rows; no partial inventory.");
  for (const text of texts) await env.independent(state, text.PrimitiveId);
  await env.guard();
  return {
    scope,
    texts,
    counts: counts(state),
    units: "mil",
    readOnly: true,
    parentEvidence,
    persistenceVerified: false
  };
}
export async function preparePcbFreeTextDelete(api: () => EasyEdaApi, params: Row) {
  const op = input(params, true),
    env = environment(api, op),
    target = await env.guard();
  env.require(env.eda.pcb_PrimitiveString, ["delete"], "Exact free String delete");
  const before = await env.snapshot();
  const expectedIds = op.expectedTexts.map((p: Row) => p.PrimitiveId);
  if (new Set(expectedIds).size !== expectedIds.length || !same([...expectedIds].sort(), [...op.primitiveIds].sort()))
    throw apiError("invalid_params", "expectedTexts must uniquely cover exactly the selected IDs.");
  for (const id of op.primitiveIds) {
    const text = await env.independent(before, id);
    if (
      !same(
        text,
        op.expectedTexts.find((p: Row) => p.PrimitiveId === id)
      )
    )
      throw apiError("stale_snapshot", "Reviewed expected text differs; no adoption or write.");
  }
  for (const id of op.keepTextIds) await env.independent(before, id);
  await env.guard();
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: ACTION,
    target,
    operation: op,
    before: encodeBefore(before),
    previewBefore: {
      counts: counts(before),
      texts: op.expectedTexts,
      keepTextIds: op.keepTextIds,
      proofEncoding: PCB_PRESERVATION_ENCODING
    },
    requestedAfter: { deletedTextIds: op.primitiveIds, keepTextIds: op.keepTextIds, persistenceVerified: false },
    changedKeys: ["explicitFreeTexts"],
    scope: `pcb:free-text:${op.projectId}:${op.pcbUuid}`,
    impact:
      "Delete only reviewed parentless String IDs on layers3/4/13; preserve all other native primitives, component attributes, pads/nets and board scope. No ownership adoption, copper writes, automatic cleanup or replay. Separate saved Epro proof required.",
    ttlMs: 300000
  });
  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}
export async function executePcbFreeTextDelete(api: () => EasyEdaApi, record: any) {
  const op = input(record.operation, true),
    env = environment(api, op);
  if (
    record.domain !== "pcb" ||
    record.action !== ACTION ||
    record.target?.projectId !== op.projectId ||
    record.target?.documentId !== op.pcbUuid
  )
    throw apiError("invalid_params", "Free text mutation identity mismatch.");
  env.require(env.eda.pcb_PrimitiveString, ["delete"], "Exact free String delete");
  const before = await env.snapshot();
  if (!sameState(before, decodeBefore(record.before)))
    throw apiError("stale_snapshot", "Complete native PCB/board/Attribute baseline changed; no write.");
  const expected = decodeBefore(encodeBefore(before)),
    journal: Row[] = [];
  try {
    for (const id of op.primitiveIds) {
      await env.guard();
      await env.independent(expected, id);
      env.ensure();
      const entry: Row = { primitiveId: id, dispatched: true };
      journal.push(entry);
      // Never race a native write promise; lifecycle lock must outlive SDK settlement.
      const acknowledgment = await env.eda.pcb_PrimitiveString.delete([id]);
      entry.acknowledged = acknowledgment === true;
      if (!entry.acknowledged) throw new Error("Exact String delete acknowledgment unconfirmed.");
      expected.inventory.groups.String = expected.inventory.groups.String.filter((p: Row) => p.PrimitiveId !== id);
      const actual = await env.snapshot();
      if (!sameState(actual, expected))
        throw new Error("Exact removal or complete kept-primitives preservation unconfirmed.");
      entry.verified = true;
    }
    return {
      executed: true,
      readback: {
        verified: true,
        journal,
        counts: counts(expected),
        keepTextIds: op.keepTextIds,
        parentEvidence,
        saved: false,
        persistenceVerified: false,
        allOtherNativePrimitivesPreserved: true
      }
    };
  } catch (error) {
    throw apiError(
      "write_readback_unknown",
      `Free String delete incomplete; never replay or auto-cleanup. Journal=${JSON.stringify(journal)}. ${String(error)}`,
      { journal }
    );
  }
}
