import {
  encodePcbPreservationInventory,
  decodePcbPreservationInventory,
  samePcbPreservationInventory,
  PCB_PRESERVATION_ENCODING
} from "./pcbPreservationEncoding.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError } from "../helpers.js";
import { extractDocumentIdentity } from "../identity.js";
import { PCB_MIL_TO_MM } from "../pcbUnits.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";

const TOL = 0.05; // Independently observed SDK center/outer-pad rounding, in mil.
const GROUPS = ["Pad", "Component", "Line", "Via", "Pour", "Poured", "Region", "Polyline", "Arc", "String", "Fill"];
const ACTIONS: Record<string, string> = {
  create: "createStandaloneNpth",
  move: "moveStandaloneNpth",
  delete: "deleteStandaloneNpth"
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type Row = Record<string, any>;
type Inventory = { groups: Record<string, Row[]>; componentPads: Row[] };
function input(params: Row, mutation = false) {
  for (const k of ["projectId", "pcbUuid", "expectedBoardName", "protectedBoardName"])
    if (typeof params[k] !== "string" || !params[k].trim() || params[k] !== params[k].trim() || params[k].length > 200)
      throw apiError("invalid_params", `Explicit ${k} required.`);
  if (params.expectedBoardName.toLowerCase() === params.protectedBoardName.toLowerCase())
    throw apiError("protected_board", "Protected original board cannot be selected for mechanical pad operations.");
  const allowed = ["projectId", "pcbUuid", "expectedBoardName", "protectedBoardName", "timeoutMs"];
  if (mutation) {
    if (!ACTIONS[params.action]) throw apiError("invalid_params", "NPTH action must be create, move or delete.");
    allowed.push("action");
    if (params.action !== "create") {
      allowed.push("primitiveId");
      if (
        typeof params.primitiveId !== "string" ||
        !params.primitiveId.trim() ||
        params.primitiveId !== params.primitiveId.trim() ||
        params.primitiveId.length > 512
      )
        throw apiError("invalid_params", "One explicit standalone pad primitiveId required.");
    }
    if (params.action !== "delete") {
      allowed.push("x", "y");
      if (
        ![params.x, params.y].every(
          (v) => typeof v === "number" && Number.isFinite(v) && Number.isFinite(v / PCB_MIL_TO_MM)
        )
      )
        throw apiError("invalid_params", "Finite x/y in mm required.");
    }
    if (params.action === "create") {
      allowed.push("diameter_mm");
      if (
        typeof params.diameter_mm !== "number" ||
        !Number.isFinite(params.diameter_mm) ||
        params.diameter_mm <= 0 ||
        !Number.isFinite(params.diameter_mm / PCB_MIL_TO_MM)
      )
        throw apiError("invalid_params", "Explicit positive diameter_mm required; no inferred M3 size.");
    }
  }
  if (Object.keys(params).some((k) => !allowed.includes(k)))
    throw apiError("invalid_params", "Unsupported mechanical pad input property; exactly one pad per mutation.");
  return JSON.parse(canonicalJson(params));
}
function environment(api: () => EasyEdaApi, scope: Row) {
  const eda = api(),
    deadline = Date.now() + 40000;
  const ensure = () => {
    if (Date.now() >= deadline)
      throw apiError("execution_budget_expired", "Mechanical pad observation deadline expired; no further writes.");
  };
  const require = (owner: any, methods: string[], label: string) => {
    if (methods.some((k) => typeof owner?.[k] !== "function"))
      throw apiError("capability_unavailable", `${label} requires public ${methods.join(", ")}. Nothing dispatched.`);
  };
  async function read<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
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
            () => reject(apiError("native_timeout", `Mechanical pad read ${label} deadline expired; no write retry.`)),
            Math.max(1, Math.min(5000, deadline - Date.now()))
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  require(eda.dmt_SelectControl, ["getCurrentDocumentInfo"], "Document");
  require(eda.dmt_Project, ["getCurrentProjectInfo"], "Project");
  require(eda.dmt_Board, ["getCurrentBoardInfo", "getAllBoardsInfo"], "Board");
  async function guard() {
    const doc = extractDocumentIdentity(await read("document", () => eda.dmt_SelectControl.getCurrentDocumentInfo()));
    const project = await read<any>("project", () => eda.dmt_Project.getCurrentProjectInfo());
    const board = await read<any>("board", () => eda.dmt_Board.getCurrentBoardInfo());
    const boards = await read<any>("boards", () => eda.dmt_Board.getAllBoardsInfo());
    if (
      doc.documentType !== "pcb" ||
      doc.documentId !== scope.pcbUuid ||
      doc.projectId !== scope.projectId ||
      project?.uuid !== scope.projectId ||
      board?.name !== scope.expectedBoardName ||
      board?.pcb?.uuid !== scope.pcbUuid ||
      board?.parentProjectUuid !== scope.projectId ||
      board?.pcb?.parentProjectUuid !== scope.projectId ||
      !Array.isArray(boards)
    )
      throw apiError("target_mismatch", "Explicit active PCB/project/board differs; no further writes.");
    const matching = boards.filter(
      (b: any) =>
        b?.name === scope.expectedBoardName &&
        b?.pcb?.uuid === scope.pcbUuid &&
        b?.parentProjectUuid === scope.projectId &&
        b?.pcb?.parentProjectUuid === scope.projectId
    );
    const protectedBoards = boards.filter(
      (b: any) =>
        b?.name === scope.protectedBoardName &&
        b?.parentProjectUuid === scope.projectId &&
        typeof b?.pcb?.uuid === "string" &&
        b.pcb.uuid !== scope.pcbUuid
    );
    if (
      matching.length !== 1 ||
      protectedBoards.length !== 1 ||
      boards.filter((b: any) => b?.name === scope.expectedBoardName).length !== 1
    )
      throw apiError("protected_board", "Unique expected and separate protected board must exist in the project.");
    const finalDoc = extractDocumentIdentity(
      await read("document after board metadata", () => eda.dmt_SelectControl.getCurrentDocumentInfo())
    );
    if (
      finalDoc.documentType !== "pcb" ||
      finalDoc.documentId !== scope.pcbUuid ||
      finalDoc.projectId !== scope.projectId
    )
      throw apiError("target_mismatch", "Active PCB changed while reading board metadata; no further writes.");
    ensure();
    return finalDoc;
  }
  function stateError(message: string, path: string, context: Row, value?: unknown) {
    const nativeValue = typeof value === "number" && !Number.isFinite(value) ? String(value) : typeof value;
    return apiError(
      "unverified_inventory",
      `${message} at ${path.slice(0, 400)} (nativeType=${context.nativeType}, value=${nativeValue}).`,
      { ...context, path: path.slice(0, 400), valueType: typeof value, nativeValue }
    );
  }
  function plain(v: any, path: string, context: Row, depth = 0, seen = new Set<any>()): any {
    if (depth > 20) throw stateError("Native state nesting is unsupported", path, context, v);
    if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw stateError("Nonfinite native state", path, context, v);
      return v;
    }
    if (typeof v !== "object" || seen.has(v))
      throw stateError("Native state is not finite JSON geometry", path, context, v);
    seen.add(v);
    try {
      if (typeof v.getSource === "function")
        return plain(v.getSource(), `${path}.getSource()`, context, depth + 1, seen);
      if (Array.isArray(v)) return v.map((x, i) => plain(x, `${path}[${i}]`, context, depth + 1, seen));
      const out: Row = {};
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "function")
          throw stateError("Unsupported callable native state", `${path}.${k.slice(0, 80)}`, context, v[k]);
        out[k] = plain(v[k], `${path}.${k.slice(0, 80)}`, context, depth + 1, seen);
      }
      if (!Object.keys(out).length && Object.getPrototypeOf(v) !== Object.prototype)
        throw stateError("Opaque native state cannot prove preservation", path, context, v);
      return out;
    } finally {
      seen.delete(v);
    }
  }
  function row(p: any, group = "Pad"): Row {
    if (!p || typeof p.getState_PrimitiveId !== "function")
      throw apiError("unverified_inventory", "Native primitive ID getter required.");
    const primitiveId = p.getState_PrimitiveId();
    const nativeType = String(p?.constructor?.name ?? "unknown").slice(0, 80);
    const names = new Set<string>();
    for (let proto = p; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
      for (const name of Object.getOwnPropertyNames(proto))
        if (/^getState_[A-Za-z0-9]+$/.test(name) && typeof p[name] === "function") names.add(name);
    const out: Row = {};
    for (const name of [...names].sort()) {
      const path = `${group.slice(0, 40)}[${String(primitiveId).slice(0, 100)}].${name}`;
      const context = {
        group: group.slice(0, 40),
        primitiveId: String(primitiveId).slice(0, 100),
        nativeType,
        getter: name
      };
      let raw: unknown;
      try {
        raw = p[name]();
      } catch (error) {
        throw apiError("unverified_inventory", `Native getter failed at ${path}: ${String(error).slice(0, 200)}`, {
          ...context,
          path
        });
      }
      // Public Hole=null explicitly means no drill. Backend converts absent SMD
      // holeRotation to degrees anyway; preserve NaN as a tagged non-applicable
      // value, never zero. Geometry-bearing getters and real holes stay strict.
      if (
        name === "getState_HoleRotation" &&
        typeof raw === "number" &&
        Number.isNaN(raw) &&
        typeof p.getState_Hole === "function" &&
        p.getState_Hole() === null &&
        typeof p.getState_Layer === "function" &&
        [1, 2].includes(p.getState_Layer()) &&
        typeof p.getState_PrimitiveType === "function" &&
        ["Pad", "ComponentPad"].includes(p.getState_PrimitiveType())
      ) {
        out[name.slice(9)] = {
          encoding: "native_not_applicable_v1",
          reason: "pad_without_hole",
          rawNonFinite: "NaN",
          holeDiscriminant: null,
          layer: p.getState_Layer()
        };
      } else out[name.slice(9)] = plain(raw, path, context);
    }
    if (typeof out.PrimitiveId !== "string" || !out.PrimitiveId)
      throw apiError("unverified_inventory", "Native primitive ID missing.");
    return JSON.parse(canonicalJson(out));
  }
  function rows(raw: unknown, label: string): Row[] {
    if (!Array.isArray(raw)) throw apiError("unverified_inventory", `${label} must return a native array.`);
    const out = raw.map((p) => row(p, label)).sort((a, b) => a.PrimitiveId.localeCompare(b.PrimitiveId));
    if (new Set(out.map((p) => p.PrimitiveId)).size !== out.length)
      throw apiError("unverified_inventory", `${label} duplicate IDs.`);
    return out;
  }
  const required: Record<string, string[]> = {
    Pad: ["X", "Y", "Layer", "PadNumber", "Pad", "Net", "Hole", "Metallization"],
    Component: ["Designator", "UniqueId", "Footprint", "X", "Y", "Rotation", "Layer"],
    Line: ["Net", "Layer", "StartX", "StartY", "EndX", "EndY", "LineWidth"],
    Via: ["Net", "X", "Y", "Diameter", "HoleDiameter", "ViaType"],
    Pour: ["Net", "Layer", "ComplexPolygon", "LineWidth", "PourPriority"],
    Poured: ["PourFills", "PourPrimitiveId"],
    Region: ["Layer", "ComplexPolygon", "LineWidth", "RuleType"],
    Polyline: ["Net", "Layer", "Polygon", "LineWidth"],
    Arc: ["Net", "Layer", "StartX", "StartY", "EndX", "EndY", "ArcAngle", "LineWidth"],
    String: ["Layer", "X", "Y", "Text", "FontSize"],
    Fill: ["Net", "Layer", "ComplexPolygon", "LineWidth", "FillMode"]
  };
  async function snapshot(): Promise<Inventory> {
    await guard();
    const groups: Record<string, Row[]> = {};
    for (const kind of GROUPS) {
      const owner = eda[`pcb_Primitive${kind}`];
      require(owner, ["getAll"], kind);
      groups[kind] = rows(await read(`${kind}.getAll`, () => owner.getAll()), kind);
      for (const p of groups[kind]) {
        if (
          required[kind].some((k) => p[k] === undefined) ||
          ["X", "Y", "StartX", "StartY", "EndX", "EndY", "Rotation", "LineWidth", "Diameter", "HoleDiameter"].some(
            (k) => k in p && !Number.isFinite(p[k])
          )
        )
          throw apiError("unverified_inventory", `${kind} required native preservation geometry/properties missing.`);
      }
    }
    if (!groups.Component.length)
      throw apiError("unverified_inventory", "Nonempty physical component inventory required.");
    require(eda.pcb_PrimitiveComponent, ["getAllPinsByPrimitiveId"], "Physical component pads");
    const componentPads: Row[] = [];
    for (const component of groups.Component) {
      const pins = rows(
        await read("component physical pads", () =>
          eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(component.PrimitiveId)
        ),
        "Physical pads"
      );
      if (!pins.length)
        throw apiError("unverified_inventory", "Every physical component needs native pad geometry/net inventory.");
      for (const pin of pins) {
        if (
          typeof pin.Net !== "string" ||
          ![pin.X, pin.Y].every(Number.isFinite) ||
          typeof pin.PadNumber !== "string" ||
          pin.Layer === undefined ||
          (pin.Pad === undefined && pin.SpecialPad === undefined)
        )
          throw apiError("unverified_inventory", "Physical pad XY/number/net including NC required.");
        componentPads.push({ ...pin, OwnerComponentId: component.PrimitiveId });
      }
    }
    componentPads.sort((a, b) => a.PrimitiveId.localeCompare(b.PrimitiveId));
    if (new Set(componentPads.map((p) => p.PrimitiveId)).size !== componentPads.length)
      throw apiError("unverified_inventory", "Duplicate physical pad IDs.");
    await guard();
    return { groups, componentPads };
  }
  return { eda, read, guard, snapshot, require, row, ensure };
}
function isHole(p: Row, inventory: Inventory) {
  return (
    p.PrimitiveType === "Pad" &&
    !inventory.componentPads.some((pin) => pin.PrimitiveId === p.PrimitiveId) &&
    (p.ParentComponentPrimitiveId === undefined ||
      p.ParentComponentPrimitiveId === null ||
      p.ParentComponentPrimitiveId === "") &&
    p.Layer === 12 &&
    p.PadType === 0 &&
    p.Net === "" &&
    p.PadNumber === "" &&
    p.Metallization === false &&
    p.Hole?.[0] === "ROUND" &&
    p.Hole.length === 2 &&
    Number.isFinite(p.Hole[1]) &&
    p.Hole[1] > 0 &&
    p.Pad?.[0] === "ELLIPSE" &&
    p.Pad.length === 3 &&
    p.Pad.slice(1).every((n: any) => Number.isFinite(n) && Math.abs(n - p.Hole[1]) <= TOL) &&
    [p.X, p.Y, p.Rotation, p.HoleOffsetX, p.HoleOffsetY, p.HoleRotation].every(Number.isFinite) &&
    [p.Rotation, p.HoleOffsetX, p.HoleOffsetY, p.HoleRotation].every((n) => Math.abs(n) <= 1e-4)
  );
}
function selected(inventory: Inventory, id: string) {
  const p = inventory.groups.Pad.find((p) => p.PrimitiveId === id);
  if (!p || !isHole(p, inventory))
    throw apiError(
      "invalid_selection",
      "Exact ID is not a proven standalone empty-net NORMAL round zero-ring NPTH pad."
    );
  return p;
}
function presentHole(p: Row) {
  return {
    primitiveId: p.PrimitiveId,
    x: p.X * PCB_MIL_TO_MM,
    y: p.Y * PCB_MIL_TO_MM,
    diameter_mm: p.Hole[1] * PCB_MIL_TO_MM,
    native: p,
    ownerEvidence: "native_Pad_type_and_complete_component_pad_exclusion",
    manufactureDrillVerified: false
  };
}
function counts(before: Inventory) {
  return {
    groups: Object.fromEntries(Object.entries(before.groups).map(([k, v]) => [k, v.length])),
    physicalPads: before.componentPads.length
  };
}
function vacant(inventory: Inventory, x: number, y: number, ignore?: string) {
  for (const p of [...inventory.groups.Pad, ...inventory.componentPads]) {
    if (![p.X, p.Y].every(Number.isFinite))
      throw apiError("unverified_inventory", "Native pad XY required to exclude occupied center.");
    if (p.PrimitiveId !== ignore && Math.hypot(p.X - x, p.Y - y) <= TOL)
      throw apiError("occupied_center", "Requested center already contains a native pad; no create/replay.");
  }
}
export async function readMechanicalPads(api: () => EasyEdaApi, params: Row) {
  const scope = input(params),
    env = environment(api, scope),
    target = await env.guard(),
    inventory = await env.snapshot();
  return {
    target,
    scope,
    units: "mm",
    holes: inventory.groups.Pad.filter((p) => isHole(p, inventory)).map(presentHole),
    inventoryCounts: counts(inventory),
    manufactureDrillVerified: false,
    noCadWrite: true
  };
}
export async function prepareMechanicalPad(api: () => EasyEdaApi, params: Row) {
  const op = input(params, true),
    env = environment(api, op),
    target = await env.guard();
  env.require(
    env.eda.pcb_PrimitivePad,
    ["get", op.action === "create" ? "create" : op.action === "delete" ? "delete" : "get"],
    "Pad"
  );
  const before = await env.snapshot();
  if (op.action !== "create") selected(before, op.primitiveId);
  if (op.action !== "delete") vacant(before, op.x / PCB_MIL_TO_MM, op.y / PCB_MIL_TO_MM, op.primitiveId);
  if (op.action === "move") {
    const p = await env.read<any>("Pad.get", () => env.eda.pcb_PrimitivePad.get(op.primitiveId));
    env.require(p, ["toAsync", "setState_X", "setState_Y", "done"], "Public asynchronous Pad instance");
    if (!same(env.row(p), selected(before, op.primitiveId)))
      throw apiError("stale_snapshot", "Independent native pad get differs.");
  }
  await env.guard();
  const record = extensionMutations.prepare({
    domain: "pcb",
    action: ACTIONS[op.action],
    target,
    operation: op,
    before: encodePcbPreservationInventory(before),
    previewBefore: { ...counts(before), proofEncoding: PCB_PRESERVATION_ENCODING },
    requestedAfter: {
      action: op.action,
      units: "mm",
      ...(op.primitiveId ? { primitiveId: op.primitiveId } : {}),
      ...(op.action !== "delete" ? { x: op.x, y: op.y } : {}),
      ...(op.action === "create" ? { diameter_mm: op.diameter_mm } : {}),
      manufactureDrillVerified: false
    },
    changedKeys: ["standaloneNpth"],
    scope: `pcb:mechanical-npth:${op.projectId}:${op.pcbUuid}`,
    impact:
      "One standalone round NPTH only. Preserve physical parts/pad nets, all unrelated pads/copper/keepouts/outline. Excellon verification still required. No netlist/BOM writes.",
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
export async function executeMechanicalPad(
  api: () => EasyEdaApi,
  record: any
): Promise<{ executed: boolean; readback: Row }> {
  const op = input(record.operation, true),
    env = environment(api, op);
  if (
    record.domain !== "pcb" ||
    record.action !== ACTIONS[op.action] ||
    record.target.projectId !== op.projectId ||
    record.target.documentId !== op.pcbUuid
  )
    throw apiError("invalid_params", "Mechanical mutation identity mismatch.");
  env.require(
    env.eda.pcb_PrimitivePad,
    ["get", op.action === "create" ? "create" : op.action === "delete" ? "delete" : "get"],
    "Pad"
  );
  const fresh = await env.snapshot();
  const originalBefore = decodePcbPreservationInventory(record.before);
  if (!samePcbPreservationInventory(fresh, originalBefore))
    throw apiError("stale_snapshot", "Native protected inventory changed after preview; no write dispatched.");
  const old = op.action === "create" ? null : selected(fresh, op.primitiveId);
  if (op.action !== "delete") vacant(fresh, op.x / PCB_MIL_TO_MM, op.y / PCB_MIL_TO_MM, op.primitiveId);
  let move: any;
  if (op.action === "move") {
    move = await env.read<any>("Pad.get before move", () => env.eda.pcb_PrimitivePad.get(op.primitiveId));
    env.require(move, ["toAsync", "setState_X", "setState_Y", "done"], "Public asynchronous Pad instance");
    if (!same(env.row(move), old)) throw apiError("stale_snapshot", "Native selected pad changed before move.");
  }
  let started = false,
    sdkPending = false,
    primitiveId = op.primitiveId ?? null,
    phase = "preflight";
  const journal = () =>
    extensionMutations.recordExecutionEvidence(record.mutationId, {
      method: "public_standalone_npth",
      phase,
      action: op.action,
      primitiveId,
      sdkPending,
      nativeOriginalPromiseSettled: started && !sdkPending,
      automaticReplay: false
    });
  try {
    await env.guard();
    env.ensure();
    phase = "native_write";
    started = true;
    sdkPending = true;
    journal();
    try {
      if (op.action === "create") {
        const x = op.x / PCB_MIL_TO_MM,
          y = op.y / PCB_MIL_TO_MM,
          d = op.diameter_mm / PCB_MIL_TO_MM;
        const p = await env.eda.pcb_PrimitivePad.create(
          12,
          "",
          x,
          y,
          0,
          ["ELLIPSE", d, d],
          "",
          ["ROUND", d],
          0,
          0,
          0,
          false,
          0
        );
        primitiveId = p?.getState_PrimitiveId?.() ?? null;
        if (typeof primitiveId !== "string" || !primitiveId)
          throw apiError("readback_failed", "Created standalone NPTH returned no native ID.");
      } else if (op.action === "delete") {
        const result = await env.eda.pcb_PrimitivePad.delete([primitiveId]);
        if (result !== true) throw apiError("readback_failed", "Native delete acknowledgment unavailable.");
      } else {
        move.toAsync();
        move.setState_X(op.x / PCB_MIL_TO_MM);
        move.setState_Y(op.y / PCB_MIL_TO_MM);
        // Public Pad.modify drops this promise in bundled SDK. Await original public instance.done instead.
        await move.done();
      }
    } finally {
      sdkPending = false;
      phase = "native_settled";
      journal();
    }
    env.ensure();
    phase = "independent_readback";
    journal();
    const pollUntil = Date.now() + 3000;
    let actual: Row | null = null;
    while (true) {
      await env.guard();
      const p = await env.read<any>("Pad.get after write", () => env.eda.pcb_PrimitivePad.get(primitiveId));
      actual = p ? env.row(p) : null;
      let verified =
        op.action === "delete"
          ? !actual
          : !!actual &&
            isHole(actual, fresh) &&
            Math.abs(actual.X - op.x / PCB_MIL_TO_MM) <= TOL &&
            Math.abs(actual.Y - op.y / PCB_MIL_TO_MM) <= TOL;
      if (verified && actual && op.action === "create")
        verified = Math.abs(actual.Hole[1] - op.diameter_mm / PCB_MIL_TO_MM) <= 1e-4;
      if (verified && actual && op.action === "move") {
        const unchanged = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !["X", "Y"].includes(k)));
        verified = same(unchanged(actual), unchanged(old!));
      }
      if (verified) break;
      if (Date.now() >= pollUntil)
        throw apiError("readback_failed", "Independent NPTH ID/geometry readback not verified; do not repeat write.");
      await env.read("readback poll", () => new Promise<void>((r) => setTimeout(r, 100)));
    }
    const after = await env.snapshot();
    if (op.action === "delete") {
      if (after.groups.Pad.some((p) => p.PrimitiveId === primitiveId))
        throw apiError("readback_failed", "Deleted pad remains in independent getAll.");
    } else if (!same(selected(after, primitiveId), actual))
      throw apiError("readback_failed", "Independent Pad.getAll differs from fresh Pad.get.");
    const without = (inventory: Inventory, id: string | null) => ({
      ...inventory,
      groups: { ...inventory.groups, Pad: inventory.groups.Pad.filter((p) => p.PrimitiveId !== id) }
    });
    if (
      !samePcbPreservationInventory(
        without(after, primitiveId),
        without(fresh, op.action === "create" ? null : primitiveId)
      )
    )
      throw apiError("readback_failed", "Protected physical part/pad-net/copper/keepout/outline inventory changed.");
    await env.guard();
    phase = "verified";
    journal();
    return {
      executed: true,
      readback: {
        verified: true,
        primitiveId,
        action: op.action,
        units: "mm",
        hole: actual ? presentHole(actual) : null,
        deletedIdAbsent: op.action === "delete",
        protectedInventoryUnchanged: true,
        inventoryCounts: counts(after),
        manufactureDrillVerified: false,
        noBomMutation: true,
        noNetlistMutation: true,
        drcVerified: false
      }
    };
  } catch (error) {
    if (!started) throw error;
    phase = "unknown";
    journal();
    throw apiError(
      "write_readback_unknown",
      `Standalone NPTH ${op.action} outcome unknown; do not replay. ${String(error)}`,
      { primitiveId, sdkPending, nativeOriginalPromiseSettled: !sdkPending }
    );
  }
}

// Shared read-only preservation reader; no CAD mutation or lifecycle transition.
export { environment as createPcbPreservationEnvironment };
