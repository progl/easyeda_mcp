import { prepareExplicitUnroute, executeExplicitUnroute } from "./pcbExplicitUnroute.js";
import { apiError, isRecord, optionalCall, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";

export type RoutingSummary = {
  totalNets: number | null;
  routedNets: null;
  unroutedNets: null;
  completionPercent: null;
  unroutedNetNames: null;
  netNames: string[];
  status: "inconclusive";
  verified: false;
  evidence: Record<string, unknown>;
  target: Record<string, unknown>;
};

const NATIVE_ROUTE_CONTRACT = {
  method: "pcb_Document.autoRouting",
  nativeHardLimitMs: 900_000,
  observationDeadlineDoesNotCancel: true,
  jobControl: "unsupported",
  retryable: false,
  recovery:
    "Query this mutationId with easyeda_get_mutation_result. An unknown outcome may still be running; never replay automatically. Check routing evidence and native DRC separately."
} as const;
const routingTasks = new Map<string, Record<string, unknown>>();
export function getNativeRoutingObservation(mutationId: string, status?: string): Record<string, unknown> {
  const task = routingTasks.get(mutationId);
  return JSON.parse(
    JSON.stringify(
      task ?? {
        ...NATIVE_ROUTE_CONTRACT,
        observed: false,
        phase: status === "prepared" ? "not_dispatched" : "observation_unavailable",
        nativeReportedSuccess: null,
        note: "This is bridge-observed call state, not native job status. No native job polling or cancellation API is invoked."
      }
    )
  );
}
function routingOptions(op: Record<string, any>) {
  const names = (value: unknown, key: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim()))
      throw apiError("invalid_params", `${key} must be an array of nonempty net names.`);
    return [...new Set<string>(value.map((name) => name.trim()))];
  };
  if (op.keepExistingRoutes !== undefined && typeof op.keepExistingRoutes !== "boolean")
    throw apiError("invalid_params", "keepExistingRoutes must be boolean.");
  return {
    RoutingNets: names(op.nets, "nets"),
    ignoreNets: names(op.ignoreNets, "ignoreNets"),
    existingPrimitiveMode: op.keepExistingRoutes === false ? "remove" : "keep"
  };
}

export type LayoutSummary = {
  totalComponents: number;
  components: Array<{
    primitiveId: string;
    designator: string;
    x: number;
    y: number;
    layer: number | string;
    locked: boolean;
  }>;
  target: Record<string, unknown>;
};

function getProp(obj: any, getterName: string, propNames: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj[getterName] === "function") {
    try {
      const val = obj[getterName]();
      if (val !== undefined && val !== null) return val;
    } catch {
      // ignore
    }
  }
  for (const prop of propNames) {
    if (obj[prop] !== undefined && obj[prop] !== null) {
      return obj[prop];
    }
  }
  return undefined;
}

export async function fetchRoutingSummary(
  api: () => EasyEdaApi,
  expectedTarget?: Record<string, unknown>
): Promise<RoutingSummary> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo);
  if (expectedTarget) assertDocumentTargetMatch(expectedTarget, currentTarget);
  let netNames: string[] = [],
    namesObserved = false;
  const warnings: string[] = [];
  if (typeof eda.pcb_Net?.getAllNetsName === "function") {
    const names = await optionalCall(() => eda.pcb_Net.getAllNetsName());
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
      netNames = names.filter(Boolean);
      namesObserved = true;
    } else warnings.push("Native net-name enumeration failed or returned an unsupported shape.");
  }
  if (typeof eda.pcb_Net?.getAllNets === "function") {
    const details = await optionalCall(() => eda.pcb_Net.getAllNets());
    if (Array.isArray(details)) {
      // Public IPCB_NetInfo contains net/color/length only. Length and synthetic isRouted
      // fields are not independent proof of pad connectivity or missing airwires.
      const names = details
        .filter(isRecord)
        .map((net) => net.net)
        .filter((net): net is string => typeof net === "string" && Boolean(net));
      if (!namesObserved && (details.length === 0 || names.length === details.length)) {
        netNames = names;
        namesObserved = true;
      }
    } else warnings.push("Native net-info enumeration failed.");
  }
  netNames = [...new Set(netNames)].sort();
  const count = async (owner: string): Promise<number | null> => {
    if (typeof eda[owner]?.getAll !== "function") return null;
    const primitives = await optionalCall(() => eda[owner].getAll());
    if (!Array.isArray(primitives)) {
      warnings.push(`${owner}.getAll did not return an array.`);
      return null;
    }
    return primitives.length;
  };
  const trackCount = await count("pcb_PrimitiveLine"),
    viaCount = await count("pcb_PrimitiveVia");
  return {
    totalNets: namesObserved ? netNames.length : null,
    routedNets: null,
    unroutedNets: null,
    completionPercent: null,
    unroutedNetNames: null,
    netNames,
    status: "inconclusive",
    verified: false,
    evidence: {
      netNamesObserved: namesObserved,
      trackCount,
      viaCount,
      nativeConnectivityProof: "unavailable",
      drcChecked: false,
      reason:
        "Installed public net info provides names/color/length, not complete pad connectivity. Track/via counts and nonzero length do not prove completion. No unverified ratsnest/job API or inferred topology is treated as native proof.",
      warnings
    },
    target: currentTarget as Record<string, unknown>
  };
}

export async function fetchLayoutSummary(api: () => EasyEdaApi): Promise<LayoutSummary> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo);

  let rawComponents: any[] = [];
  if (eda.pcb_PrimitiveComponent?.getAll) {
    rawComponents = toArray(await optionalCall(() => eda.pcb_PrimitiveComponent.getAll()));
  }

  const components = rawComponents.filter(isRecord).map((raw) => {
    const primitiveId = String(getProp(raw, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "");
    const designator = String(getProp(raw, "getState_Designator", ["designator", "name", "displayName"]) ?? "");
    const x = Number(getProp(raw, "getState_X", ["x", "centerX"]) ?? 0);
    const y = Number(getProp(raw, "getState_Y", ["y", "centerY"]) ?? 0);
    const layer = getProp(raw, "getState_Layer", ["layer", "layerId"]) ?? 1;
    const locked = Boolean(getProp(raw, "getState_PrimitiveLock", ["locked", "primitiveLock"]));
    return { primitiveId, designator, x, y, layer, locked };
  });

  return {
    totalComponents: components.length,
    components,
    target: currentTarget as Record<string, unknown>
  };
}

export async function preparePcbRoutingMutation(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  if (String(params.action ?? "autoroute").toLowerCase() === "unroute") return prepareExplicitUnroute(api, params);
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo);

  if (params.target) {
    assertDocumentTargetMatch(params.target, currentTarget);
  }

  if (currentTarget.documentType && currentTarget.documentType !== "pcb") {
    throw apiError(
      "invalid_target_type",
      `Active document is '${currentTarget.documentType}'. PCB routing operations require an active PCB document.`
    );
  }

  const action = String(params.action ?? "autoroute").toLowerCase();
  const nativeOptions = routingOptions(params);
  const nets = nativeOptions.RoutingNets;
  const ignoreNets = nativeOptions.ignoreNets;
  const keepExistingRoutes = nativeOptions.existingPrimitiveMode === "keep";

  const currentSummary = await fetchRoutingSummary(api);

  if (action === "autoroute") {
    const targetDesc =
      nets && nets.length > 0 ? `${nets.length} specified nets (${nets.join(", ")})` : "all unrouted nets";
    const impact = `Executes native PCB auto-routing for ${targetDesc} (preserving existing routes: ${keepExistingRoutes}). Native routing can run up to 900 seconds; a bridge/lifecycle deadline does not cancel it. Query the mutationId after unknown; never replay automatically. Completion and native DRC require separate evidence.`;

    const preview = {
      impact,
      scope: `document:${currentTarget.documentId ?? "active_pcb"}`,
      before: {
        totalNets: currentSummary.totalNets,
        routedNets: currentSummary.routedNets,
        unroutedNets: currentSummary.unroutedNets,
        completionPercent: currentSummary.completionPercent
      },
      requestedAfter: {
        action: "autoroute",
        targetNets: nets.length ? nets : "all",
        keepExistingRoutes,
        completionGuaranteed: false,
        nativeTask: NATIVE_ROUTE_CONTRACT
      },
      changedKeys: ["routing", "routedNets", "completionPercent"]
    };

    const record = extensionMutations.prepare({
      domain: "pcb",
      action: "autoroute",
      target: currentTarget,
      operation: {
        action: "autoroute",
        nets,
        ignoreNets,
        keepExistingRoutes,
        nativeTaskContract: NATIVE_ROUTE_CONTRACT
      },
      before: preview.before,
      requestedAfter: preview.requestedAfter,
      changedKeys: preview.changedKeys,
      scope: preview.scope,
      impact: preview.impact,
      ttlMs: 5 * 60_000
    });

    return {
      mutationId: record.mutationId,
      confirmation: record.confirmation,
      action: "autoroute",
      target: record.target,
      preview: record.preview,
      expiresAt: record.expiresAt
    };
  }

  throw apiError("unsupported_action", `Unsupported routing action '${action}'. Expected autoroute or unroute.`);
}

export async function executePcbRoutingMutation(
  api: () => EasyEdaApi,
  op: Record<string, any>,
  _expectedBefore?: unknown
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  if (op.action === "unroute") return executeExplicitUnroute(api, op);
  const eda = api();

  if (op.action === "autoroute") {
    if (typeof eda.pcb_Document?.autoRouting !== "function")
      throw apiError(
        "unsupported_api",
        "Public pcb_Document.autoRouting is unavailable; undocumented autoRoute aliases and unsupported native job stubs are not invoked."
      );
    const props = routingOptions(op);
    if (op.target)
      assertDocumentTargetMatch(
        op.target,
        extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
      );
    const task: Record<string, unknown> = {
      ...NATIVE_ROUTE_CONTRACT,
      observed: true,
      phase: "running",
      dispatchedAt: new Date().toISOString(),
      nativeReportedSuccess: null,
      nativeCallSettled: false,
      completionVerified: false,
      drcVerified: false,
      note: "Bridge-observed native call only; native job status/progress/cancel are unavailable in the inspected dispatcher."
    };
    if (typeof op.mutationId === "string") {
      routingTasks.set(op.mutationId, task);
      if (routingTasks.size > 256) {
        const old = [...routingTasks].find(([id, value]) => id !== op.mutationId && value.phase !== "running");
        if (old) routingTasks.delete(old[0]);
      }
    }
    try {
      // Preserve the receiver: the public SDK method calls this.getAutoRoutingUserConfig().
      const result: unknown = await eda.pcb_Document.autoRouting(props);
      task.nativeCallSettled = true;
      task.settledAt = new Date().toISOString();
      if (!isRecord(result) || typeof result.success !== "boolean")
        throw new Error("Native autoRouting returned no documented success flag; outcome unverified.");
      task.phase = "settled";
      task.nativeReportedSuccess = result.success;
      const reported = Object.fromEntries(
        ["totalNetsCount", "successNetsCount", "duration"]
          .filter((key) => typeof result[key] === "number" && Number.isFinite(result[key]) && Number(result[key]) >= 0)
          .map((key) => [key, result[key]])
      );
      if (Array.isArray(result.failedNets) && result.failedNets.every((name) => typeof name === "string"))
        reported.failedNets = result.failedNets.slice(0, 1000);
      task.reported = reported;
      if (op.target)
        assertDocumentTargetMatch(
          op.target,
          extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
        );
      const readback = await fetchRoutingSummary(api, op.target);
      if (op.target)
        assertDocumentTargetMatch(
          op.target,
          extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
        );
      return {
        executed: result.success,
        readback: {
          ...readback,
          method: "native",
          nativeCallSettled: true,
          nativeReportedSuccess: result.success,
          nativeReported: reported,
          status: result.success ? "inconclusive" : "native_failed",
          verified: false,
          completionVerified: false,
          drcVerified: false,
          nativeTask: JSON.parse(JSON.stringify(task)),
          reportedMetricsNote:
            "Native result counts are reported metadata, not independent proof that all pads are connected."
        }
      };
    } catch (error) {
      task.phase = "unknown";
      task.nativeCallSettled = true;
      task.settledAt = new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);
      throw apiError(
        "write_readback_unknown",
        `Native autoRouting outcome is unverified. Do not replay automatically; query this mutationId and inspect independent routing/native DRC evidence. ${String(task.error)}`
      );
    }
  }

  throw apiError("unsupported_action", `Unsupported execution action '${op.action}'.`);
}

export async function preparePcbLayoutMutation(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo);

  if (params.target) {
    assertDocumentTargetMatch(params.target, currentTarget);
  }

  if (currentTarget.documentType && currentTarget.documentType !== "pcb") {
    throw apiError(
      "invalid_target_type",
      `Active document is '${currentTarget.documentType}'. PCB layout operations require an active PCB document.`
    );
  }

  const components = Array.isArray(params.components) ? params.components.map(String).filter(Boolean) : undefined;
  const currentLayout = await fetchLayoutSummary(api);

  const targetDesc =
    components && components.length > 0
      ? `${components.length} components (${components.join(", ")})`
      : "all unlocked components";
  const impact = `Executes native PCB auto-layout to arrange ${targetDesc} inside the board outline.`;

  const preview = {
    impact,
    scope: `document:${currentTarget.documentId ?? "active_pcb"}`,
    before: {
      totalComponents: currentLayout.totalComponents
    },
    requestedAfter: {
      action: "autolayout",
      targetComponents: components ?? "all",
      arranged: true
    },
    changedKeys: ["layout", "componentPositions"]
  };

  const record = extensionMutations.prepare({
    domain: "pcb",
    action: "autolayout",
    target: currentTarget,
    operation: {
      action: "autolayout",
      components
    },
    before: preview.before,
    requestedAfter: preview.requestedAfter,
    changedKeys: preview.changedKeys,
    scope: preview.scope,
    impact: preview.impact,
    ttlMs: 5 * 60_000
  });

  return {
    mutationId: record.mutationId,
    confirmation: record.confirmation,
    action: "autolayout",
    target: record.target,
    preview: record.preview,
    expiresAt: record.expiresAt
  };
}

export async function executePcbLayoutMutation(
  api: () => EasyEdaApi,
  op: Record<string, any>,
  _expectedBefore?: unknown
): Promise<{ executed: true; readback: Record<string, unknown> }> {
  const eda = api();
  const layoutFn = eda.pcb_Document?.autoLayout ?? eda.pcb_Document?.autoPlace;

  if (!layoutFn) {
    throw apiError(
      "unsupported_api",
      "EasyEDA Pro native autoLayout API method is unavailable on the current platform."
    );
  }

  await layoutFn({ components: op.components });

  const readback = await fetchLayoutSummary(api);
  return {
    executed: true,
    readback: {
      method: "native",
      totalComponents: readback.totalComponents,
      arranged: true,
      verified: true
    }
  };
}
