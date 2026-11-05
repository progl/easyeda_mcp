import { apiError, isRecord } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { extensionMutations } from "../mutation/mutationManager.js";
import type { EasyEdaApi } from "../types.js";

const referenceSdk = "0.3.59.1ca9efb5";
// Semantics below were inspected in the installed SDK api.js, not inferred from async/function names.
const methodReferences = [
  {
    api: "sch_PrimitiveWire",
    referenceSemantics: "fire_and_forget_done",
    evidence: "modify calls n.isAsync() && n.done() without awaiting its promise"
  },
  {
    api: "pcb_PrimitivePad",
    referenceSemantics: "fire_and_forget_done",
    evidence: "modify calls t.isAsync() ? t.done() : t.toSync() and returns t without awaiting done"
  },
  {
    api: "sch_PrimitiveComponent",
    referenceSemantics: "awaited_rpc",
    evidence: "modify awaits SCH_PrimitiveComponent3.modify RPC and subsequent native readback"
  },
  {
    api: "pcb_PrimitiveComponent",
    referenceSemantics: "unknown",
    evidence: "No completion semantics asserted for this method"
  }
];
function sourceIdentity(value: unknown): Record<string, string> {
  if (
    !isRecord(value) ||
    !["projectId", "schematicName", "pageName"].every(
      (key) => typeof value[key] === "string" && String(value[key]).trim()
    )
  )
    throw apiError(
      "invalid_params",
      "Source ERC requires explicit sourceIdentity: projectId, schematicName, pageName."
    );
  return {
    projectId: String(value.projectId),
    schematicName: String(value.schematicName),
    pageName: String(value.pageName)
  };
}
async function sourceErc(
  eda: EasyEdaApi,
  params: Record<string, any>,
  currentProjectId?: string
): Promise<Record<string, unknown>> {
  if (params.includeSourceErc !== true)
    return {
      available: typeof eda.sch_SourceDrc?.check === "function",
      status: "not_requested",
      method: "sch_SourceDrc.check"
    };
  const identity = sourceIdentity(params.sourceIdentity);
  if (currentProjectId && identity.projectId !== currentProjectId)
    throw apiError("target_mismatch", "Source ERC projectId differs from the active project.");
  if (typeof eda.sch_SourceDrc?.check !== "function")
    return {
      available: false,
      status: "unavailable",
      method: "sch_SourceDrc.check",
      identity,
      reason: "Public source ERC API is unavailable; no private/internal substitute was invoked."
    };
  let raw: unknown;
  try {
    raw = await eda.sch_SourceDrc.check(identity);
  } catch (error) {
    return {
      available: true,
      status: "failed",
      passed: null,
      identity,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.value) ||
    !Array.isArray(raw.value.violations) ||
    typeof raw.value.passed !== "boolean"
  )
    return {
      available: true,
      status: isRecord(raw) && raw.ok === false ? "failed" : "inconclusive",
      passed: null,
      identity,
      error: isRecord(raw) && raw.ok === false ? raw.error : undefined
    };
  const violations = raw.value.violations;
  // Preserve public violation details rather than treating tree/group lengths as warning counts.
  if (
    !violations.every(
      (v) =>
        isRecord(v) &&
        typeof v.rule === "string" &&
        typeof v.message === "string" &&
        typeof v.severity === "string" &&
        Array.isArray(v.elements) &&
        v.elements.every(
          (e) =>
            isRecord(e) && typeof e.primitiveId === "string" && (e.pinId === undefined || typeof e.pinId === "string")
        )
    )
  )
    return {
      available: true,
      status: "inconclusive",
      passed: null,
      identity,
      reason: "Native source ERC violation shape does not match the public contract."
    };
  const errorsCount = violations.filter((v) => v.severity === "error").length;
  const warningsCount = violations.filter((v) => ["warning", "warn"].includes(v.severity)).length;
  const unknownSeverityCount = violations.length - errorsCount - warningsCount;
  const consistent = raw.value.passed === (errorsCount === 0) && unknownSeverityCount === 0;
  return {
    available: true,
    status: consistent ? "complete" : "inconclusive",
    method: "sch_SourceDrc.check",
    identity,
    passed: consistent ? raw.value.passed : null,
    nativePassed: raw.value.passed,
    errorsCount,
    warningsCount,
    unknownSeverityCount,
    total: violations.length,
    detailsComplete: violations.length <= 200 && violations.every((v) => v.elements.length <= 200),
    violations: violations.slice(0, 200).map((v) => ({
      rule: v.rule,
      severity: v.severity,
      message: v.message,
      elements: v.elements.slice(0, 200),
      elementsTruncated: v.elements.length > 200
    })),
    coverage: ["UNCONNECTED_PIN", "NEAR_BUT_NOT_CONNECTED"],
    coverageNote: "Source business checks are not a replacement for the editor native ERC rule set."
  };
}
export async function getNativePreflight(
  api: () => EasyEdaApi,
  params: Record<string, any> = {}
): Promise<Record<string, unknown>> {
  const eda = api();
  const target = extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  if (params.target) assertDocumentTargetMatch(params.target, target);
  const erc = await sourceErc(eda, params, target.projectId);
  const after = extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  if (target.documentId) assertDocumentTargetMatch(target, after);
  const lifecycle = extensionMutations.getExecutionState();
  return {
    target,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    // Presence is not invocation, compatibility proof, or permission to mutate.
    optionalCapabilities: {
      "sch_SourcePrimitiveComponent.replace": typeof eda.sch_SourcePrimitiveComponent?.replace === "function",
      "lib_Device.get": typeof eda.lib_Device?.get === "function",
      "lib_Footprint.get": typeof eda.lib_Footprint?.get === "function",
      "lib_Footprint.getDocumentSource": typeof eda.lib_Footprint?.getDocumentSource === "function"
    },
    pendingWrites: {
      bridgeLifecycle: lifecycle,
      nativeQueue: "unobservable",
      readyForNativeWrite: lifecycle.lockHeld || lifecycle.unresolvedCount > 0 ? false : null,
      reason:
        "Only bridge-managed writes are observable. An unlocked bridge does not prove that native fire-and-forget RPCs have settled. No flush/barrier is invoked."
    },
    methods: methodReferences.map((reference) => ({
      ...reference,
      referenceSdk,
      runtimeSemantics: "unverified",
      create: typeof eda[reference.api]?.create === "function",
      modify: typeof eda[reference.api]?.modify === "function",
      get: typeof eda[reference.api]?.get === "function",
      getAll: typeof eda[reference.api]?.getAll === "function",
      recommendation:
        "Verify independent getter readback before the next dependent operation; do not infer completion from a returned primitive."
    })),
    units: {
      schematicSourceCoordinates: "10mil",
      pcbCoordinates: "mil",
      pcbCoordinateSource: "Public PCB API coordinates; independent of UI display units",
      runtimePadHoleTuple: "requires_verification",
      referenceClient: {
        sdkVersion: referenceSdk,
        pcbXYUnit: "mil",
        padHoleTupleUnit: "10mil",
        padHoleTupleToMil: 10,
        evidence: "Physical drill diameter independently matched exported Excellon in the inspected client",
        runtimeMatch: "unverified"
      },
      rule: "Never apply the reference hole multiplier to a different runtime/version without independent verification; raw tuples are not rescaled by this report."
    },
    sourceErc: erc,
    nativeErc: {
      available: typeof eda.sch_Drc?.check === "function",
      method: "sch_Drc.check(strict,false,true)",
      executed: false,
      details:
        "Use the existing native ERC tool for editor rule checks; this preflight invokes only optional public source ERC."
    }
  };
}
