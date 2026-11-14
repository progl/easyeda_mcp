import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";
import type { EasyEdaApi } from "../types.js";
export type PcbPlacement = {
  primitiveId: string;
  designator?: string;
  x?: number;
  y?: number;
  rotation?: number;
  layer?: number | string;
};
const value = (item: any, key: string) =>
  typeof item?.[`getState_${key[0].toUpperCase() + key.slice(1)}`] === "function"
    ? item[`getState_${key[0].toUpperCase() + key.slice(1)}`]()
    : item?.[key];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export async function executePcbPlacements(
  api: () => EasyEdaApi,
  placements: PcbPlacement[],
  options: {
    target?: Partial<DocumentIdentity>;
    budgetMs?: number;
    deadline?: number;
    readbackMs?: number;
    expectedBefore?: Record<string, unknown>;
  } = {}
) {
  const sdk = api(),
    native = sdk.pcb_PrimitiveComponent,
    deadline = Math.min(options.deadline ?? Infinity, Date.now() + Math.min(40000, options.budgetMs ?? 40000));
  const ensure = () => {
    if (Date.now() >= deadline)
      throw apiError("execution_budget_expired", "PCB placement deadline expired; no further writes started.");
  };
  const bounded = async <T>(fn: () => Promise<T> | T, until = deadline): Promise<T> => {
    ensure();
    const callDeadline = Math.min(deadline, until);
    if (Date.now() >= callDeadline)
      throw apiError("execution_budget_expired", "PCB readback deadline expired; no further writes started.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                apiError(
                  "execution_budget_expired",
                  "PCB getter/write exceeded execution deadline; no further writes started."
                )
              ),
            Math.max(1, callDeadline - Date.now())
          );
        })
      ]);
      if (Date.now() >= callDeadline)
        throw apiError("execution_budget_expired", "PCB response arrived outside its readback deadline.");
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (typeof native?.modify !== "function" || (!native.get && !native.getAll))
    throw apiError("capability_unavailable", "PCB placement requires modify and independent component getters.");
  if (typeof native.getAllPinsByPrimitiveId !== "function")
    throw apiError(
      "capability_unavailable",
      "PCB pad netlink getter getAllPinsByPrimitiveId is required before placement."
    );
  if (typeof sdk.dmt_SelectControl?.getCurrentDocumentInfo !== "function")
    throw apiError("capability_unavailable", "PCB placement requires an active target getter.");
  if (
    !placements.length ||
    placements.some((p) => typeof p.primitiveId !== "string" || !p.primitiveId.trim()) ||
    new Set(placements.map((p) => p.primitiveId)).size !== placements.length
  )
    throw apiError("invalid_params", "Placement IDs must be nonempty and unique.");
  for (const placement of placements)
    for (const key of ["x", "y", "rotation"] as const)
      if (placement[key] !== undefined && !Number.isFinite(placement[key]))
        throw apiError("invalid_params", "PCB placement coordinates/rotation must be finite native mil/degrees.");
  const target = extractDocumentIdentity(await bounded(() => sdk.dmt_SelectControl.getCurrentDocumentInfo()));
  if (target.documentType !== "pcb" || !target.documentId || !target.projectId)
    throw apiError("invalid_target", "PCB placement requires identifiable active PCB and project.");
  if (options.target) assertDocumentTargetMatch(options.target, target);
  const guard = async () => {
    ensure();
    assertDocumentTargetMatch(
      target,
      extractDocumentIdentity(await bounded(() => sdk.dmt_SelectControl.getCurrentDocumentInfo()))
    );
    ensure();
  };
  const read = async (id: string, until = deadline) => {
    let component: any;
    if (native.get) component = await bounded(() => native.get(id), until);
    else {
      const list: any = await bounded(() => native.getAll(), until);
      component = Array.isArray(list) ? list.find((c) => String(value(c, "primitiveId")) === id) : undefined;
    }
    if (!component) throw apiError("component_not_found", `PCB component ${id} disappeared during placement.`);
    const identity = Object.fromEntries(
      ["primitiveId", "designator", "uniqueId", "footprint", "component", "value"].map((key) => [
        key,
        value(component, key)
      ])
    );
    if (String(identity.primitiveId) !== id)
      throw apiError("identity_mismatch", "PCB getter returned a different primitive ID.");
    if (identity.footprint === undefined)
      throw apiError("capability_unavailable", `Footprint identity is unavailable for ${id}; placement stopped.`);
    const position = Object.fromEntries(["x", "y", "rotation", "layer"].map((key) => [key, value(component, key)]));
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
      throw apiError("unverified_geometry", "PCB getter did not return finite native coordinates.");
    const rawPads: any = await bounded(() => native.getAllPinsByPrimitiveId(id), until);
    if (!Array.isArray(rawPads)) throw apiError("unverified_netlinks", "Pad netlink getter did not return an array.");
    const pads = rawPads
      .map((p) => {
        if (typeof p?.getState_Net !== "function" && !Object.prototype.hasOwnProperty.call(p ?? {}, "net"))
          throw apiError("unverified_netlinks", "A pad has no public net getter/value.");
        return {
          primitiveId: value(p, "primitiveId"),
          padNumber: value(p, "padNumber"),
          parentComponentPrimitiveId: value(p, "parentComponentPrimitiveId"),
          net: value(p, "net")
        };
      })
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    return JSON.parse(canonicalJson({ identity, position, pads }));
  };
  const before = new Map<string, any>();
  for (const p of placements) {
    const snapshot = await read(p.primitiveId);
    if (p.designator && String(snapshot.identity.designator).toUpperCase() !== p.designator.toUpperCase())
      throw apiError(
        "identity_mismatch",
        `PCB designator/primitiveId mapping changed for ${p.designator}; no writes started.`
      );
    before.set(p.primitiveId, snapshot);
  }
  if (options.expectedBefore && placements.length === 1)
    for (const key of ["x", "y", "rotation", "layer"])
      if (
        options.expectedBefore[key] !== undefined &&
        !same(before.get(placements[0].primitiveId).position[key], options.expectedBefore[key])
      )
        throw apiError("stale_mutation", "PCB placement baseline changed after preview.");
  const matchesPosition = (observed: any, expected: any) =>
    ["x", "y", "rotation", "layer"].every((key) => {
      if (key === "rotation" && typeof observed[key] === "number" && typeof expected[key] === "number")
        return Math.abs(((observed[key] - expected[key] + 540) % 360) - 180) <= 0.001;
      return typeof expected[key] === "number" && typeof observed[key] === "number"
        ? Math.abs(expected[key] - observed[key]) <= 0.001
        : same(expected[key], observed[key]);
    });
  const confirmed: string[] = [],
    results: any[] = [];
  let current: string | undefined,
    writeStarted = false;
  try {
    for (const placement of placements) {
      current = placement.primitiveId;
      const baseline = before.get(current),
        patch = Object.fromEntries(
          Object.entries(placement).filter(([key]) => key !== "primitiveId" && key !== "designator")
        );
      await guard();
      writeStarted = true;
      await bounded(() => native.modify(placement.primitiveId, patch));
      const readDeadline = Math.min(deadline, Date.now() + (options.readbackMs ?? 3000));
      let actual: any;
      while (true) {
        actual = await read(placement.primitiveId, readDeadline);
        if (!same(actual.identity, baseline.identity) || !same(actual.pads, baseline.pads))
          throw new Error(`PCB identity, footprint or pad netlinks changed for ${current}.`);
        const matches = matchesPosition(actual.position, { ...baseline.position, ...patch });
        if (matches) break;
        if (Date.now() >= readDeadline)
          throw new Error(`Move readback failed for ${current}; position/rotation/layer did not persist.`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, readDeadline - Date.now()))));
      }
      await guard();
      confirmed.push(current);
      results.push({ primitiveId: current, ...actual.position });
      current = undefined;
    }
    // Recheck the whole batch after the last write; later SDK edits must not have moved
    // an earlier part or changed its footprint/pad membership behind the executor.
    for (const placement of placements) {
      current = placement.primitiveId;
      const actual = await read(current),
        baseline = before.get(current);
      const expected = {
        ...baseline.position,
        ...Object.fromEntries(
          Object.entries(placement).filter(([key]) => key !== "primitiveId" && key !== "designator")
        )
      };
      if (
        !same(actual.identity, baseline.identity) ||
        !same(actual.pads, baseline.pads) ||
        !matchesPosition(actual.position, expected)
      )
        throw new Error(`Final PCB placement identity/netlink/position readback failed for ${current}.`);
    }
    await guard();
    current = undefined;
    return {
      verified: true,
      identityPreserved: true,
      footprintsPreserved: true,
      padNetlinksPreserved: true,
      confirmedCount: confirmed.length,
      placements: results,
      units: "mil",
      rotationUnits: "degree",
      visualRenderVerified: false
    };
  } catch (error) {
    if (!writeStarted) throw error;
    throw apiError(
      "write_readback_unknown",
      `PCB placement outcome unknown. Do not replay. ${JSON.stringify({ confirmedCount: confirmed.length, firstConfirmedIds: confirmed.slice(0, 8), currentComponent: current })}. ${String(error).slice(0, 500)}`
    );
  }
}
