import { canonicalJson } from "../../../src/mutation/contracts.js";
import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { collectNativeNetlist } from "../handlers/nativeNetlist.js";
import type { EasyEdaApi } from "../types.js";
import { extensionMutations } from "./mutationManager.js";
const prop = (v: any, k: string) =>
  typeof v?.[`getState_${k}`] === "function" ? v[`getState_${k}`]() : v?.[k[0].toLowerCase() + k.slice(1)];
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export async function reconcileSchematicCreate(api: () => EasyEdaApi, params: Record<string, any>) {
  const expected = params.expectedPins,
    fp = params.expectedFootprint;
  if (
    typeof params.mutationId !== "string" ||
    !params.mutationId ||
    typeof params.primitiveId !== "string" ||
    !params.primitiveId ||
    !Array.isArray(expected) ||
    !expected.length ||
    expected.length > 500 ||
    new Set(expected.map((p) => p.pinNumber)).size !== expected.length ||
    expected.some(
      (p) =>
        typeof p.pinNumber !== "string" ||
        !p.pinNumber ||
        typeof p.net !== "string" ||
        ![p.x, p.y].every(Number.isFinite)
    ) ||
    !fp ||
    ![fp.uuid, fp.libraryUuid, fp.name].every((v) => typeof v === "string" && v.length > 0)
  )
    throw apiError(
      "invalid_params",
      "Original mutationId/created primitiveId, complete reviewed expectedPins including NC/positions and exact expectedFootprint required."
    );
  const eda = api(),
    deadline = Date.now() + 40000;
  let expired = false;
  const read = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    if (expired || Date.now() >= deadline)
      throw apiError("native_read_timeout", `Reconcile budget expired before ${name}; no retry.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (expired) throw new Error("Read budget expired");
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(apiError("native_read_timeout", `Reconcile ${name} timed out; no retry.`));
            },
            Math.min(5000, deadline - Date.now())
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return extensionMutations.reconcileSettledUnknown({
    mutationId: params.mutationId,
    domain: "schematic",
    action: "createComponent",
    originalRecord: params.originalRecord,
    verify: async (record) => {
      const op: any = record.operation;
      if (
        op?.action !== "createComponent" ||
        typeof op.uniqueId !== "string" ||
        !op.uniqueId ||
        !op.designator ||
        typeof op.device !== "object" ||
        !op.device?.name ||
        !op.device.libraryUuid ||
        !String(record.error ?? "")
          .toLowerCase()
          .includes(`component ${params.primitiveId} `.toLowerCase())
      )
        throw apiError(
          "reconciliation_unproven",
          "Original receipt must identify the returned created primitive ID, explicit uniqueId/designator and catalog device."
        );
      for (const [owner, name] of [
        [eda.dmt_Project, "getCurrentProjectInfo"],
        [eda.dmt_Board, "getCurrentBoardInfo"],
        [eda.dmt_Schematic, "getCurrentSchematicInfo"],
        [eda.dmt_SelectControl, "getCurrentDocumentInfo"],
        [eda.sch_PrimitiveComponent, "getAll"],
        [eda.sch_PrimitiveComponent, "getAllPinsByPrimitiveId"],
        [eda.sch_ManufactureData, "getNetlistFile"]
      ] as const)
        if (typeof owner?.[name] !== "function")
          throw apiError("capability_unavailable", `Independent public ${name} required.`);
      const guard = async () => {
        const target = extractDocumentIdentity(
          await read("current document", () => eda.dmt_SelectControl.getCurrentDocumentInfo())
        );
        assertDocumentTargetMatch(record.target, target);
        const project = await read("current project", () => eda.dmt_Project.getCurrentProjectInfo());
        const board = await read("current board", () => eda.dmt_Board.getCurrentBoardInfo());
        const sch = await read("current schematic", () => eda.dmt_Schematic.getCurrentSchematicInfo());
        if (
          target.documentType !== "schematic" ||
          project?.uuid !== target.projectId ||
          board?.parentProjectUuid !== target.projectId ||
          board?.schematic?.uuid !== sch?.uuid ||
          !sch?.uuid ||
          !board.schematic.page?.some((p: any) => p.uuid === target.documentId && p.parentSchematicUuid === sch.uuid)
        )
          throw apiError("target_mismatch", "Independent current project/board/schematic/page links required.");
        return {
          projectId: project.uuid,
          boardName: board.name,
          schematicUuid: sch.uuid,
          documentId: target.documentId
        };
      };
      const context = await guard();
      const rows = await read("Component.getAll current page", () =>
        eda.sch_PrimitiveComponent.getAll(undefined, false)
      );
      if (!Array.isArray(rows))
        throw apiError("reconciliation_unproven", "Native current-page component array unavailable.");
      const hits = rows.filter((c: any) => prop(c, "PrimitiveId") === params.primitiveId);
      if (hits.length !== 1)
        throw apiError("reconciliation_unproven", "Created native primitive ID is missing/duplicated.");
      const raw = hits[0],
        designator = prop(raw, "Designator"),
        uniqueId = prop(raw, "UniqueId"),
        component = prop(raw, "Component"),
        footprint = prop(raw, "Footprint");
      const x = prop(raw, "X"),
        y = prop(raw, "Y"),
        rotation = prop(raw, "Rotation"),
        mirror = prop(raw, "Mirror");
      if (
        prop(raw, "ComponentType") !== "part" ||
        designator !== op.designator ||
        uniqueId !== op.uniqueId ||
        rows.some(
          (c: any) => c !== raw && (prop(c, "Designator") === designator || prop(c, "UniqueId") === uniqueId)
        ) ||
        x !== op.x ||
        y !== op.y ||
        rotation !== op.rotation ||
        mirror !== op.mirror ||
        prop(raw, "AddIntoBom") !== op.addIntoBom ||
        prop(raw, "AddIntoPcb") !== op.addIntoPcb ||
        component?.name !== op.device.name ||
        component?.libraryUuid !== op.device.libraryUuid ||
        !equal({ uuid: footprint?.uuid, libraryUuid: footprint?.libraryUuid, name: footprint?.name }, fp)
      )
        throw apiError(
          "reconciliation_unproven",
          "Native identity/pose/catalog name/library/flags or reviewed footprint mismatch."
        );
      const rawPins = await read("Component.getAllPinsByPrimitiveId", () =>
        eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId)
      );
      if (!Array.isArray(rawPins) || rawPins.length !== expected.length)
        throw apiError("reconciliation_unproven", "Complete native pin count differs from reviewed pins.");
      const pins = rawPins.map((p: any) => ({
        primitiveId: prop(p, "PrimitiveId"),
        pinNumber: String(prop(p, "PinNumber") ?? ""),
        x: prop(p, "X"),
        y: prop(p, "Y")
      }));
      if (
        new Set(pins.map((p) => p.pinNumber)).size !== pins.length ||
        pins.some((p) => !p.primitiveId || ![p.x, p.y].every(Number.isFinite))
      )
        throw apiError("reconciliation_unproven", "Pin numbers/geometry missing or ambiguous.");
      const native = await collectNativeNetlist(
        eda,
        false,
        Math.max(1, Math.min(10000, deadline - Date.now())),
        "EasyEDA"
      );
      if (
        expired ||
        Date.now() >= deadline ||
        native.status !== "available" ||
        native.format !== "EasyEDA" ||
        !native.text ||
        !native.scope?.verified ||
        native.scope.projectId !== context.projectId ||
        native.scope.schematicUuid !== context.schematicUuid ||
        native.ambiguousDesignators?.length
      )
        throw apiError("reconciliation_unproven", "Full native scoped EasyEDA net/NC evidence unavailable.");
      const data = JSON.parse(native.text),
        entries = Object.entries(data.components ?? {}) as [string, any][];
      const matches = entries.filter(([, c]) => c.props?.Designator === designator);
      if (matches.length !== 1 || matches[0][0] !== uniqueId)
        throw apiError("reconciliation_unproven", "Native schematic designator/uniqueId binding differs.");
      const map = Object.entries(matches[0][1].pinInfoMap ?? {}).map(([key, p]: [string, any]) => ({
        pinNumber: String(p.number ?? p.props?.["Pin Number"] ?? key),
        net: p.net
      }));
      if (
        map.length !== pins.length ||
        new Set(map.map((p) => p.pinNumber)).size !== map.length ||
        map.some((p) => typeof p.net !== "string")
      )
        throw apiError("reconciliation_unproven", "Native full pin membership/NC map incomplete.");
      const verifiedPins = pins.map((p) => ({ ...p, net: map.find((m) => m.pinNumber === p.pinNumber)?.net }));
      if (
        !verifiedPins.every((p) =>
          expected.some(
            (e) =>
              e.pinNumber === p.pinNumber &&
              e.net === p.net &&
              Math.abs(e.x - p.x) <= 1e-6 &&
              Math.abs(e.y - p.y) <= 1e-6
          )
        )
      )
        throw apiError("reconciliation_unproven", "Reviewed pin position/net/NC mismatch.");
      if (!equal(await guard(), context))
        throw apiError("target_mismatch", "Active public scope changed during reconciliation.");
      return {
        verified: true,
        reconciledReadOnly: true,
        primitiveId: params.primitiveId,
        designator,
        uniqueId,
        x,
        y,
        rotation,
        mirror,
        footprint,
        pins: verifiedPins,
        context,
        proofScope: "created_component_identity_pose_and_reviewed_pin_map",
        catalogOriginVerified: false,
        otherPrimitivesUnchangedVerified: false,
        pcbSyncVerified: false,
        modelGeometryVerified: false,
        nativeCreateReplayed: false
      };
    }
  });
}
