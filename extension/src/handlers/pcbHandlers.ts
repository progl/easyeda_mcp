import { fetchRoutingSummary } from "../mutation/pcbRoutingMutations.js";
import { preparePcbAnnotationMutation } from "../mutation/pcbAnnotationMutations.js";
import { getComponentPads, normalizePcbPad } from "../pcbGeometry.js";
export { normalizePcbPad } from "../pcbGeometry.js";
import {
  apiError,
  ensureApi,
  numeric,
  optionalCall,
  sanitize,
  simplifyPrimitive,
  stringOrUndefined,
  toArray
} from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { getBoardOutlineSummary } from "../mutation/pcbOutlineMutations.js";
import {
  fetchPcbCopperZones,
  fetchPcbKeepouts,
  preparePcbCopperKeepoutMutation
} from "../mutation/pcbCopperKeepoutMutations.js";
import {
  fetchPcbNetClasses,
  fetchPcbDifferentialPairs,
  fetchPcbLengthGroups,
  preparePcbNetConstraintMutation
} from "../mutation/pcbNetConstraintMutations.js";
import { preparePcbExternalImportMutation } from "../mutation/pcbExternalImportMutations.js";
import { fetchPcbTracks, fetchPcbVias, preparePcbTrackViaMutation } from "../mutation/pcbTrackViaMutations.js";
import {
  generatePcbAirwiresReport,
  generatePcbPlacementReport,
  generatePcbNetReport
} from "../reporting/pcbBoardReports.js";
import { inspectPcb3d, fetchPcb3dView } from "../reporting/pcb3dInspection.js";
import type { EasyEdaApi, RpcHandler } from "../types.js";
import {
  filterAndLimitViolations,
  flattenNativeDrcGroups,
  normalizeDrcViolation,
  summarizeDrcViolations,
  type EditorDrcComparison
} from "./pcbDrcNormalizer.js";

function getProp(obj: any, getterName: string, propNames: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj[getterName] === "function") {
    try {
      const val = obj[getterName]();
      if (val !== undefined && val !== null) return val;
    } catch {
      // ignore getter error
    }
  }
  for (const prop of propNames) {
    if (obj[prop] !== undefined && obj[prop] !== null) {
      return obj[prop];
    }
  }
  return undefined;
}

export async function getPcbComponents(api: () => EasyEdaApi): Promise<unknown[]> {
  ensureApi("pcb_PrimitiveComponent", "getAll", api());
  return toArray(await api().pcb_PrimitiveComponent.getAll());
}

export async function getPcbNetNames(api: () => EasyEdaApi): Promise<unknown[]> {
  const eda = api();
  ensureApi("pcb_Net", "getAllNetsName", eda);
  if (eda.pcb_Net.getAllNetsName) {
    return toArray(await eda.pcb_Net.getAllNetsName());
  }
  return toArray(await eda.pcb_Net.getAllNetName());
}

export function createPcbHandlers(api: () => EasyEdaApi): Record<string, RpcHandler> {
  async function runDrc(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }

    if (
      documentInfo &&
      ![3, "pcb"].includes(documentInfo?.documentType ?? documentInfo?.doctype ?? documentInfo?.type)
    ) {
      throw apiError("wrong_document", "Open a PCB document before running DRC checks.");
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Open a PCB document before running DRC checks.");
    }

    ensureApi("pcb_Drc", "check", eda);
    const strict = params.strict !== false;
    const compareWithEditor = params.compareWithEditor !== false;
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 500) : 100;
    const executionId = `drc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const executedAt = new Date().toISOString();

    const startedAt = Date.now();
    let rawResult: unknown;
    try {
      rawResult = await eda.pcb_Drc.check(strict, false, true);
    } catch (err) {
      throw apiError("drc_failed", `Native PCB DRC check failed: ${(err as Error)?.message || String(err)}`);
    }
    let booleanControl: unknown;
    let controlError: string | undefined;
    if (Array.isArray(rawResult) && flattenNativeDrcGroups(rawResult).length === 0) {
      try {
        assertDocumentTargetMatch(
          currentTarget,
          extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
        );
        booleanControl = await eda.pcb_Drc.check(strict, false, false);
      } catch (error) {
        controlError = String(error);
      }
    }
    assertDocumentTargetMatch(
      currentTarget,
      extractDocumentIdentity(await eda.dmt_SelectControl?.getCurrentDocumentInfo?.())
    );
    const durationMs = Date.now() - startedAt;
    const detailsAvailable = Array.isArray(rawResult);
    const nativeEvidence = {
      verboseRequested: true,
      detailsAvailable,
      legacyBooleanResult: typeof rawResult === "boolean" ? rawResult : undefined,
      booleanControl,
      controlError,
      detailsUnavailable:
        !detailsAvailable ||
        (flattenNativeDrcGroups(Array.isArray(rawResult) ? rawResult : []).length === 0 && booleanControl !== true),
      note: "Native verbose groups omit failedItems; empty details require a successful boolean control. Boolean failure does not identify a violation count."
    };

    let rawViolations: unknown[] = [];
    let passed = true;
    let nativeReportedErrors = 0;
    let nativeReportedWarnings = 0;

    if (Array.isArray(rawResult)) {
      rawViolations = flattenNativeDrcGroups(rawResult);
      passed = rawViolations.length === 0 && booleanControl === true;
    } else if (rawResult && typeof rawResult === "object") {
      const rawObj = rawResult as Record<string, any>;
      if (Array.isArray(rawObj.errors)) {
        rawViolations.push(...rawObj.errors);
        nativeReportedErrors = rawObj.errors.length;
      }
      if (Array.isArray(rawObj.warnings)) {
        rawViolations.push(...rawObj.warnings);
        nativeReportedWarnings = rawObj.warnings.length;
      }
      if (Array.isArray(rawObj.violations)) {
        rawViolations = rawObj.violations;
        nativeReportedErrors = rawViolations.length;
      }
      if (typeof rawObj.passed === "boolean") {
        passed = rawObj.passed;
      } else if (typeof rawObj.success === "boolean") {
        passed = rawObj.success;
      } else {
        passed = nativeReportedErrors === 0;
      }
    } else if (typeof rawResult === "boolean") {
      // A legacy boolean supplies no violation records or reliable count.
      passed = false;
    }

    const normalizedViolations = rawViolations.map((v, i) => normalizeDrcViolation(v, i));
    const summary = summarizeDrcViolations(normalizedViolations);

    const totalErrors = Math.max(summary.errors, nativeReportedErrors);
    const totalWarnings = Math.max(summary.warnings, nativeReportedWarnings);
    if (totalErrors > 0 || nativeEvidence.detailsUnavailable) {
      passed = false;
    }

    // Optional comparison against editor-side live DRC error list or state
    let editorApiQueried = false;
    let editorErrorCount: number | undefined = undefined;
    let ruleConfigName: string | undefined = undefined;
    let matched: boolean | null = null;
    let editorNote = "Editor live DRC query not available in connected version.";

    if (compareWithEditor) {
      try {
        const drcApi = (eda.pcb_Drc ?? {}) as Record<string, any>;
        if (typeof drcApi.getDrcErrors === "function") {
          const list = toArray(await drcApi.getDrcErrors());
          editorErrorCount = list.length;
          editorApiQueried = true;
        } else if (typeof drcApi.getErrors === "function") {
          const list = toArray(await drcApi.getErrors());
          editorErrorCount = list.length;
          editorApiQueried = true;
        } else if (typeof drcApi.getLastResult === "function") {
          const last = await drcApi.getLastResult();
          if (Array.isArray(last)) {
            editorErrorCount = last.length;
            editorApiQueried = true;
          } else if (last && typeof last === "object" && Array.isArray((last as any).errors)) {
            editorErrorCount = (last as any).errors.length;
            editorApiQueried = true;
          }
        }

        const activeConfig = await optionalCall(() => drcApi.getCurrentRuleConfiguration?.());
        if (activeConfig && typeof activeConfig === "object") {
          ruleConfigName = stringOrUndefined((activeConfig as any).name ?? (activeConfig as any).ruleName);
        }

        if (editorApiQueried && editorErrorCount !== undefined) {
          matched = editorErrorCount === totalErrors;
          editorNote = matched
            ? `DRC check results match editor live error state (${totalErrors} error(s)).`
            : `Discrepancy: check returned ${totalErrors} error(s) vs editor reported ${editorErrorCount} error(s).`;
        }
      } catch {
        // Non-fatal if editor error query is not implemented
      }
    }

    const editorComparison: EditorDrcComparison = {
      editorApiQueried,
      editorErrorCount,
      checkErrorCount: totalErrors,
      matched,
      ruleConfigName,
      note: editorNote
    };

    const { filtered, warnings: filterWarnings } = filterAndLimitViolations(normalizedViolations, {
      severity: params.severity,
      rule: params.rule,
      limit
    });

    return {
      executionId,
      executedAt,
      status: nativeEvidence.detailsUnavailable ? "inconclusive" : passed ? "passed" : "violations_found",
      passed,
      violationsCount: normalizedViolations.length,
      errorsCount: totalErrors,
      warningsCount: totalWarnings,
      violationsReturned: filtered.length,
      violations: filtered,
      errors: filtered.filter((v) => v.severity === "error").map((v) => v.raw),
      summary,
      editorComparison,
      target: currentTarget,
      capturedAt: currentTarget.capturedAt,
      durationMs,
      strict,
      warnings: filterWarnings,
      nativeEvidence,
      rawResult: sanitize(rawResult)
    };
  }

  async function getPcbLayers(): Promise<Record<string, unknown>> {
    const eda = api();
    ensureApi("pcb_Layer", "getAllLayers", eda);
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const rawLayers = toArray(await eda.pcb_Layer.getAllLayers());
    const layers = rawLayers.map((layer: any) => {
      if (!layer || typeof layer !== "object") return layer;
      const typeStr = String(layer.type ?? layer.layerType ?? "").toLowerCase();
      const isSignal = Boolean(
        layer.isSignal ??
        layer.isCopper ??
        (typeStr === "signal" || typeStr === "copper" || layer.type === 1 || layer.type === 2)
      );
      return {
        id: layer.id ?? layer.layerId ?? layer.layerNo,
        name: layer.name ?? layer.layerName,
        type: layer.type ?? layer.layerType,
        color: layer.color,
        visible: layer.visible ?? layer.isVisible,
        isSignal,
        copperThickness: layer.copperThickness ?? layer.thickness
      };
    });
    const copperLayers = layers.filter(
      (l: any) => l && (l.isSignal || ["signal", "copper", "plane"].includes(String(l.type).toLowerCase()))
    );
    return {
      target: extractDocumentIdentity(documentInfo),
      layerCount: layers.length,
      copperLayerCount: copperLayers.length,
      layers: sanitize(layers),
      rawLayers: sanitize(rawLayers)
    };
  }

  async function getRoutingStatus(params: Record<string, any>): Promise<Record<string, unknown>> {
    const summary = await fetchRoutingSummary(api, params.target);
    if (params.target) assertDocumentTargetMatch(params.target, summary.target);
    let netLengths: Record<string, number> | undefined;
    if (params.includeNetLengths && typeof api().pcb_Net?.getNetLength === "function") {
      netLengths = {};
      for (const name of summary.netNames) {
        const length = await optionalCall(() => api().pcb_Net.getNetLength(name));
        if (typeof length === "number" && Number.isFinite(length)) netLengths[name] = length;
      }
    }
    return { ...summary, ...(netLengths ? { netLengths } : {}) };
  }

  async function listPcbComponents(params: Record<string, any>): Promise<Record<string, unknown>> {
    const query = String(params.query ?? "")
      .trim()
      .toLowerCase();
    const layerFilter = String(params.layer ?? "all").toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(params.limit ?? 100)));
    const includeRaw = Boolean(params.includeRaw);
    const includePads = Boolean(params.includePads);
    const includeProperties = Boolean(params.includeProperties);

    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");
    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }

    const rawComponents = await getPcbComponents(api);
    const all = [];
    for (const item of toArray(rawComponents)) {
      const comp = item as Record<string, any>;
      const simplified = simplifyPrimitive(comp);
      const layerId =
        comp?.layer ??
        comp?.layerId ??
        (comp?.layer === 1 ? "TopLayer" : comp?.layer === 2 ? "BottomLayer" : undefined);
      const layerStr = String(layerId ?? "").toLowerCase();
      const side =
        layerStr.includes("top") || layerId === 1
          ? "top"
          : layerStr.includes("bot") || layerId === 2
            ? "bottom"
            : "unknown";
      const rotation = numeric(comp?.rotation ?? comp?.angle ?? 0) ?? 0;
      const locked = Boolean(getProp(comp, "getState_PrimitiveLock", ["locked", "primitiveLock"]));

      let compPads: Record<string, unknown>[] | undefined;
      let padCount: number | undefined;
      if (includePads || comp.pins || comp.pads) {
        const rawPins = await getComponentPads(comp, api);
        padCount = rawPins.length;
        if (includePads) {
          compPads = rawPins.map((pin) => normalizePcbPad(pin, comp, includeRaw));
        }
      }

      let properties: Record<string, unknown> | undefined;
      if (includeProperties) {
        properties = sanitize(comp?.properties ?? comp?.attributes ?? comp?.customProperties) as
          Record<string, unknown> | undefined;
      }

      all.push({
        primitiveId: simplified.primitiveId,
        designator: simplified.designator,
        footprint: simplified.footprint,
        value: simplified.value,
        x: simplified.x,
        y: simplified.y,
        rotation,
        layer: layerId,
        side,
        locked,
        ...(padCount !== undefined ? { padCount } : {}),
        ...(compPads ? { pads: compPads } : {}),
        ...(properties ? { properties } : {}),
        ...(includeRaw ? { raw: item } : {})
      });
    }

    let filtered = all;
    if (layerFilter === "top") {
      filtered = filtered.filter((c) => c.side === "top");
    } else if (layerFilter === "bottom") {
      filtered = filtered.filter((c) => c.side === "bottom");
    }

    if (query) {
      filtered = filtered.filter((c) =>
        [c.designator, c.footprint, c.value, c.primitiveId].some((field) =>
          String(field ?? "")
            .toLowerCase()
            .includes(query)
        )
      );
    }

    const items = filtered.slice(0, limit);
    return {
      target: currentTarget,
      total: all.length,
      count: items.length,
      layerFilter,
      components: items,
      units: "mil",
      betaApi: true
    };
  }

  async function getPcbPads(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");
    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }

    const componentFilter = params.component ? String(params.component).trim().toLowerCase() : undefined;
    const netFilter = params.net ? String(params.net).trim().toLowerCase() : undefined;
    const layerFilter = String(params.layer ?? "all")
      .trim()
      .toLowerCase();
    const padNumberFilter = params.padNumber ? String(params.padNumber).trim() : undefined;
    const includeComponentPads = params.includeComponentPads !== false;
    const includeStandalonePads = params.includeStandalonePads !== false;
    const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 200)));
    const includeRaw = Boolean(params.includeRaw);

    const pads: Record<string, unknown>[] = [];

    // Collect pads from components
    if (includeComponentPads && eda.pcb_PrimitiveComponent?.getAll) {
      const rawComponents = await getPcbComponents(api);
      for (const comp of toArray(rawComponents)) {
        const compDesignator = String(getProp(comp, "getState_Designator", ["designator", "name"]) ?? "").toLowerCase();
        const compId = String(getProp(comp, "getState_PrimitiveId", ["primitiveId", "id", "uuid"]) ?? "").toLowerCase();

        if (componentFilter && compDesignator !== componentFilter && compId !== componentFilter) {
          continue;
        }

        const rawPins = await getComponentPads(comp, api);
        for (const pin of rawPins) {
          pads.push(normalizePcbPad(pin, comp, includeRaw));
        }
      }
    }

    // Collect standalone pads
    if (includeStandalonePads && !componentFilter && eda.pcb_PrimitivePad?.getAll) {
      const rawStandalone = toArray(await optionalCall(() => eda.pcb_PrimitivePad.getAll()));
      for (const pad of rawStandalone) {
        pads.push(normalizePcbPad(pad, undefined, includeRaw));
      }
    }

    let filtered = pads;
    if (netFilter) {
      filtered = filtered.filter(
        (p) =>
          String(p.net ?? "").toLowerCase() === netFilter ||
          String(p.net ?? "")
            .toLowerCase()
            .includes(netFilter)
      );
    }
    if (layerFilter !== "all") {
      filtered = filtered.filter((p) => p.side === layerFilter || String(p.layer ?? "").toLowerCase() === layerFilter);
    }
    if (padNumberFilter) {
      filtered = filtered.filter((p) => String(p.padNumber ?? "") === padNumberFilter);
    }

    const items = filtered.slice(0, limit);
    return {
      target: currentTarget,
      totalPads: pads.length,
      count: items.length,
      pads: items,
      units: "mil",
      componentFilter: params.component,
      netFilter: params.net,
      layerFilter,
      padNumberFilter: params.padNumber,
      betaApi: true
    };
  }

  async function highlightNet(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const net = params.net ? String(params.net).trim() : undefined;
    const clear = Boolean(params.clear) || !net;

    if (clear) {
      if (eda.pcb_Net?.unhighlightAllNets) {
        await eda.pcb_Net.unhighlightAllNets();
      }
      return { cleared: true, message: "Cleared all net highlights." };
    }

    ensureApi("pcb_Net", "highlightNet", eda);
    await eda.pcb_Net.highlightNet(net);
    return {
      highlighted: true,
      net,
      message: `Highlighted net "${net}" on PCB.`
    };
  }

  async function getBoardOutline(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    return (await getBoardOutlineSummary(api, {
      expectedTarget: params.target,
      includeSegments: params.includeSegments,
      includeRaw: params.includeRaw
    })) as unknown as Record<string, unknown>;
  }

  async function getPcbTracks(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB tracks requires an active PCB document.");
    }

    const { total, count, tracks } = await fetchPcbTracks(eda, {
      net: params.net,
      layer: params.layer,
      primitiveId: params.primitiveId ?? params.trackId,
      limit: params.limit,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      units: "mil",
      totalTracks: total,
      count,
      tracks
    };
  }

  async function getPcbVias(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB vias requires an active PCB document.");
    }

    const { total, count, vias } = await fetchPcbVias(eda, {
      net: params.net,
      primitiveId: params.primitiveId ?? params.viaId,
      limit: params.limit,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      units: "mil",
      totalVias: total,
      count,
      vias
    };
  }

  async function getCopperZones(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB copper zones requires an active PCB document.");
    }

    const { total, count, zones } = await fetchPcbCopperZones(eda, {
      net: params.net,
      layer: params.layer,
      primitiveId: params.primitiveId ?? params.zoneId,
      limit: params.limit,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      totalZones: total,
      count,
      zones
    };
  }

  async function getKeepouts(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB keepouts requires an active PCB document.");
    }

    const { total, count, keepouts } = await fetchPcbKeepouts(eda, {
      layer: params.layer,
      primitiveId: params.primitiveId ?? params.keepoutId,
      limit: params.limit,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      totalKeepouts: total,
      count,
      keepouts
    };
  }

  async function getPcbNetClasses(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB net classes requires an active PCB document.");
    }

    const { total, classes } = await fetchPcbNetClasses(eda, {
      name: params.name,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      totalClasses: total,
      classes
    };
  }

  async function getPcbDifferentialPairs(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB differential pairs requires an active PCB document.");
    }

    const { total, pairs } = await fetchPcbDifferentialPairs(eda, {
      name: params.name,
      toleranceMm: params.toleranceMm,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      totalPairs: total,
      pairs
    };
  }

  async function getPcbLengthGroups(params: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const eda = api();
    const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(documentInfo, undefined, "native_api");

    const expectedTarget = params.expectedTarget ?? params.target;
    if (expectedTarget) {
      assertDocumentTargetMatch(expectedTarget, currentTarget);
    }
    if (
      currentTarget.documentType &&
      currentTarget.documentType !== "pcb" &&
      currentTarget.documentType !== "unknown"
    ) {
      throw apiError("wrong_document", "Getting PCB length groups requires an active PCB document.");
    }

    const { total, groups } = await fetchPcbLengthGroups(eda, {
      name: params.name,
      toleranceMm: params.toleranceMm,
      includeRaw: params.includeRaw
    });

    return {
      target: currentTarget,
      totalGroups: total,
      groups
    };
  }

  return {
    runDrc,
    getPcbLayers,
    getRoutingStatus,
    listPcbComponents,
    getPcbPads,
    getPcbPadsTool: getPcbPads,
    highlightNet,
    getBoardOutline,
    getPcbTracks,
    getPcbVias,
    preparePcbAnnotation: (params: Record<string, any>) => preparePcbAnnotationMutation(api, params),
    preparePcbTrackVia: (params: Record<string, any>) => preparePcbTrackViaMutation(api, params),
    getCopperZones,
    getKeepouts,
    prepareCopperKeepout: (params: Record<string, any>) => preparePcbCopperKeepoutMutation(api, params),
    getPcbAirwires: (params: Record<string, any>) => generatePcbAirwiresReport(api, params),
    getPcbPlacementReport: (params: Record<string, any>) => generatePcbPlacementReport(api, params),
    getPcbNetReport: (params: Record<string, any>) => generatePcbNetReport(api, params),
    getPcbNetClasses,
    getPcbDifferentialPairs,
    getPcbLengthGroups,
    prepareNetConstraint: (params: Record<string, any>) => preparePcbNetConstraintMutation(api, params),
    getPcb3dInspection: (params: Record<string, any>) => inspectPcb3d(api, params),
    getPcb3dView: (params: Record<string, any>) => fetchPcb3dView(api, params),
    preparePcbExternalImport: (params: Record<string, any>) => preparePcbExternalImportMutation(api, params)
  };
}
