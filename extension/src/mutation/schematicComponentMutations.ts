import { prepareSchematicPage } from "./schematicPages.js";
import { prepareBlockTransfer } from "./schematicBlockTransfer.js";
import { preparePinNets, executePinNets } from "./schematicPinNets.js";
import {
  prepareSchematicAnnotation,
  executeSchematicAnnotation,
  prepareSchematicLayout,
  executeSchematicLayout,
  prepareSchematicAttributeLayout,
  executeSchematicAttributeLayout
} from "./schematicLayout.js";
import { apiError, ensureApi, isNumber, isRecord, numeric, optionalCall, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity } from "../identity.js";
import { extensionMutations } from "./mutationManager.js";
import type { EasyEdaApi } from "../types.js";
import type { MutationRecord } from "../../../src/mutation/contracts.js";
import { canonicalJson } from "../../../src/mutation/contracts.js";

// Only fields documented by the public SCH_PrimitiveComponent.modify contract.
// In particular a footprint library reference is not a supported generic setter.
const NUMBER_PROPERTIES = new Set(["x", "y", "rotation"]);
const BOOLEAN_PROPERTIES = new Set(["mirror", "addIntoBom", "addIntoPcb"]);
const STRING_PROPERTIES = new Set([
  "designator",
  "name",
  "uniqueId",
  "manufacturer",
  "manufacturerId",
  "supplier",
  "supplierId"
]);

function nativeProperty(raw: Record<string, any>, key: string): unknown {
  const getter = raw[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
  return typeof getter === "function" ? getter.call(raw) : raw[key];
}

function validatedUpdateProperties(input: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(input) || Array.isArray(input) || !Object.keys(input).length)
    throw apiError("invalid_params", "No properties provided to update.");
  const properties = { ...input };
  if (Object.prototype.hasOwnProperty.call(properties, "value")) {
    if (typeof properties.value !== "string" || Object.prototype.hasOwnProperty.call(properties, "name"))
      throw apiError("invalid_params", "value must be a string alias for native name; do not also provide name.");
    properties.name = properties.value;
    delete properties.value;
  }
  for (const [key, value] of Object.entries(properties)) {
    if (NUMBER_PROPERTIES.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw apiError("invalid_params", `${key} must be a finite number.`);
    } else if (BOOLEAN_PROPERTIES.has(key)) {
      if (typeof value !== "boolean") throw apiError("invalid_params", `${key} must be a boolean.`);
    } else if (STRING_PROPERTIES.has(key)) {
      if (typeof value !== "string" && value !== null)
        throw apiError("invalid_params", `${key} must be a string or null.`);
    } else if (key === "subPartName") {
      if (typeof value !== "string") throw apiError("invalid_params", "subPartName must be a string.");
    } else if (key === "otherProperty") {
      if (
        !isRecord(value) ||
        Array.isArray(value) ||
        !Object.keys(value).length ||
        Object.values(value).some(
          (v) => !["string", "boolean"].includes(typeof v) && !(typeof v === "number" && Number.isFinite(v))
        )
      )
        throw apiError("invalid_params", "otherProperty requires nonempty finite scalar properties.");
    } else {
      throw apiError(
        "unsupported_property",
        `Generic schematic update does not support '${key}'. Footprint/device references require a separately supported replacement workflow.`
      );
    }
  }
  // Reject unsafe keys, non-plain objects and non-JSON values before any write,
  // including execution of a record prepared by an older extension.
  return JSON.parse(canonicalJson(properties));
}

// Cached schematic component UUIDs may be project-local 16-character IDs.
// Public catalog placement requires the 32-character device AND library identifiers.
function assertCatalogDeviceReference(device: unknown): asserts device is Record<string, unknown> {
  if (
    !isRecord(device) ||
    typeof device.uuid !== "string" ||
    !/^[a-z0-9]{32}$/i.test(device.uuid) ||
    typeof device.libraryUuid !== "string" ||
    !/^[a-z0-9]{32}$/i.test(device.libraryUuid)
  )
    throw apiError(
      "invalid_device_reference",
      "Placement requires a public catalog device item with 32-character uuid and libraryUuid. Do not pass cached schematic.component references; resolve through lib_Device.search first."
    );
}

export type ResolvedComponent = {
  primitiveId: string;
  designator: string;
  value?: string;
  footprint?: string | Record<string, unknown>;
  x: number;
  y: number;
  rotation?: number;
  mirror?: boolean;
  raw: Record<string, unknown>;
};

export async function findComponentInSchematic(api: () => EasyEdaApi, identifier: string): Promise<ResolvedComponent> {
  const eda = api();
  ensureApi("sch_PrimitiveComponent", "getAll", eda);
  const rawComponents = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, false));

  const trimmed = identifier.trim();
  const upper = trimmed.toUpperCase();

  for (const raw of rawComponents) {
    if (!isRecord(raw)) continue;
    const primitiveId = String(nativeProperty(raw, "primitiveId") ?? raw.id ?? raw.uuid ?? "").trim();
    const designator = String(
      nativeProperty(raw, "designator") ?? raw.name ?? raw.displayName ?? raw.prefix ?? ""
    ).trim();

    if (primitiveId === trimmed || designator.toUpperCase() === upper) {
      const x = numeric(nativeProperty(raw, "x")) ?? 0;
      const y = numeric(nativeProperty(raw, "y")) ?? 0;
      const rawValue = raw.value ?? raw.comment ?? raw.title ?? nativeProperty(raw, "name");
      const value = typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue) : undefined;
      const rawFootprint = nativeProperty(raw, "footprint") ?? raw.package;
      const footprint =
        typeof rawFootprint === "string"
          ? rawFootprint
          : isRecord(rawFootprint)
            ? JSON.parse(canonicalJson(rawFootprint))
            : undefined;
      const rotation = numeric(nativeProperty(raw, "rotation"));
      const rawMirror = nativeProperty(raw, "mirror");
      const mirror = typeof rawMirror === "boolean" ? rawMirror : undefined;

      return {
        primitiveId,
        designator,
        value,
        footprint,
        x,
        y,
        rotation,
        mirror,
        raw
      };
    }
  }

  throw apiError("component_not_found", `Schematic component "${identifier}" was not found in the active schematic.`);
}

export async function prepareSchematicComponentMutation(
  api: () => EasyEdaApi,
  params: Record<string, any>
): Promise<Record<string, unknown>> {
  const eda = api();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
  const currentTarget = extractDocumentIdentity(documentInfo);

  if (params.target) {
    assertDocumentTargetMatch(params.target, currentTarget);
  }

  if (currentTarget.documentType !== "schematic") {
    throw apiError(
      "invalid_target_type",
      `Active document is '${currentTarget.documentType}'. Schematic component mutations require an active schematic document.`
    );
  }

  const action = String(params.action ?? "").toLowerCase();

  // Compatibility transport for clients whose running MCP catalog predates page tools.
  if (action === "update" && params.component === "@schematic") {
    const properties = params.properties;
    if (!isRecord(properties) || Object.keys(properties).length !== 1)
      throw apiError(
        "invalid_params",
        "@schematic accepts exactly one page, transfer, annotation, layout or attributeLayout object."
      );
    if (isRecord(properties.page)) return prepareSchematicPage(api, { ...properties.page, target: currentTarget });
    if (isRecord(properties.transfer))
      return prepareBlockTransfer(api, { ...properties.transfer, target: currentTarget });
    if (isRecord(properties.annotation)) return prepareSchematicAnnotation(api, properties.annotation, currentTarget);
    if (isRecord(properties.layout)) return prepareSchematicLayout(api, properties.layout, currentTarget);
    if (isRecord(properties.attributeLayout))
      return prepareSchematicAttributeLayout(api, properties.attributeLayout, currentTarget);
    throw apiError(
      "invalid_params",
      "@schematic requires page, transfer, annotation, layout or attributeLayout properties."
    );
  }
  if (action === "update" && isRecord(params.properties) && params.properties.pinNets !== undefined) {
    return preparePinNets(api, params, currentTarget);
  }

  if (action === "create") {
    if (!params.device) {
      throw apiError(
        "invalid_params",
        "Field 'device' (search query or device object) is required to create a component."
      );
    }
    if (typeof params.device !== "string") assertCatalogDeviceReference(params.device);
    else if (!params.device.trim()) throw apiError("invalid_params", "Device search query must not be empty.");
    if (!isNumber(params.x) || !isNumber(params.y)) {
      throw apiError("invalid_params", "Numeric coordinates 'x' and 'y' are required to place a component.");
    }

    const x = Number(params.x);
    const y = Number(params.y);
    const designator = params.designator ? String(params.designator).trim() : undefined;
    const rotation = isNumber(params.rotation) ? Number(params.rotation) : 0;
    const mirror = Boolean(params.mirror);
    if (
      params.uniqueId !== undefined &&
      (typeof params.uniqueId !== "string" || !params.uniqueId.trim() || params.uniqueId !== params.uniqueId.trim())
    )
      throw apiError("invalid_params", "uniqueId must be a nonempty string without surrounding whitespace.");
    const uniqueId = params.uniqueId as string | undefined;

    const operation = {
      action: "createComponent",
      device: params.device,
      x,
      y,
      designator,
      uniqueId,
      subPartName: params.subPartName ? String(params.subPartName) : undefined,
      rotation,
      mirror,
      addIntoBom: params.addIntoBom !== false,
      addIntoPcb: params.addIntoPcb !== false
    };

    const before = {
      target: currentTarget,
      timestamp: new Date().toISOString()
    };

    const preview = {
      before: { device: null, x: null, y: null },
      requestedAfter: {
        device: typeof params.device === "string" ? params.device : (params.device.name ?? "device_object"),
        x,
        y,
        designator,
        ...(uniqueId !== undefined ? { uniqueId } : {}),
        rotation,
        mirror
      },
      changedKeys: [
        "device",
        "x",
        "y",
        ...(designator ? ["designator"] : []),
        ...(uniqueId !== undefined ? ["uniqueId"] : [])
      ],
      scope: `document:${currentTarget.documentId ?? "active"}`,
      impact: `Creates new component at (${x}, ${y}) with device "${typeof params.device === "string" ? params.device : "custom"}"${designator ? ` designator ${designator}` : ""}.`
    };

    const record = extensionMutations.prepare({
      domain: "schematic",
      action: "createComponent",
      target: currentTarget,
      operation,
      before,
      requestedAfter: preview.requestedAfter,
      changedKeys: preview.changedKeys,
      scope: preview.scope,
      impact: preview.impact,
      ttlMs: 5 * 60_000
    });

    return {
      mutationId: record.mutationId,
      confirmation: record.confirmation,
      action: record.action,
      target: record.target,
      preview: record.preview,
      expiresAt: record.expiresAt
    };
  }

  if (action === "move") {
    const componentId = String(params.component ?? "").trim();
    if (!componentId) {
      throw apiError(
        "invalid_params",
        "Field 'component' (designator or primitiveId) is required to move a component."
      );
    }

    const comp = await findComponentInSchematic(api, componentId);
    let targetX: number;
    let targetY: number;

    if (isNumber(params.x) && isNumber(params.y)) {
      targetX = Number(params.x);
      targetY = Number(params.y);
    } else if (isNumber(params.dx) && isNumber(params.dy)) {
      targetX = comp.x + Number(params.dx);
      targetY = comp.y + Number(params.dy);
    } else {
      throw apiError(
        "invalid_params",
        "Provide either absolute coordinates ('x', 'y') or relative deltas ('dx', 'dy')."
      );
    }

    const operation = {
      action: "moveComponent",
      primitiveId: comp.primitiveId,
      designator: comp.designator,
      fromX: comp.x,
      fromY: comp.y,
      toX: targetX,
      toY: targetY
    };

    const before = {
      primitiveId: comp.primitiveId,
      designator: comp.designator,
      x: comp.x,
      y: comp.y
    };

    const preview = {
      before: { x: comp.x, y: comp.y },
      requestedAfter: { x: targetX, y: targetY },
      changedKeys: ["x", "y"],
      scope: `component:${comp.designator || comp.primitiveId}`,
      impact: `Moves component ${comp.designator || comp.primitiveId} from (${comp.x}, ${comp.y}) to (${targetX}, ${targetY}).`
    };

    const record = extensionMutations.prepare({
      domain: "schematic",
      action: "moveComponent",
      target: currentTarget,
      operation,
      before,
      requestedAfter: preview.requestedAfter,
      changedKeys: preview.changedKeys,
      scope: preview.scope,
      impact: preview.impact,
      ttlMs: 5 * 60_000
    });

    return {
      mutationId: record.mutationId,
      confirmation: record.confirmation,
      action: record.action,
      target: record.target,
      preview: record.preview,
      expiresAt: record.expiresAt
    };
  }

  if (action === "update") {
    const componentId = String(params.component ?? "").trim();
    if (!componentId) {
      throw apiError(
        "invalid_params",
        "Field 'component' (designator or primitiveId) is required to update a component."
      );
    }

    const comp = await findComponentInSchematic(api, componentId);
    const properties = isRecord(params.properties) ? { ...params.properties } : {};

    if (params.designator !== undefined) properties.designator = String(params.designator).trim();
    if (params.value !== undefined) properties.value = String(params.value).trim();
    if (params.footprint !== undefined) properties.footprint = params.footprint;
    if (isNumber(params.rotation)) properties.rotation = Number(params.rotation);
    if (typeof params.mirror === "boolean") properties.mirror = params.mirror;
    for (const key of ["addIntoBom", "addIntoPcb", "subPartName", "uniqueId"] as const) {
      if (params[key] !== undefined) properties[key] = params[key];
    }

    const changedKeys = Object.keys(properties);
    if (changedKeys.length === 0) {
      throw apiError("invalid_params", "No properties provided to update.");
    }
    const nativeProperties = validatedUpdateProperties(properties);

    const operation = {
      action: "updateComponent",
      primitiveId: comp.primitiveId,
      designator: comp.designator,
      properties: nativeProperties
    };

    const before: Record<string, unknown> = {
      primitiveId: comp.primitiveId,
      designator: comp.designator,
      value: comp.value,
      footprint: comp.footprint,
      rotation: comp.rotation,
      mirror: comp.mirror
    };

    const requestedAfter: Record<string, unknown> = {
      ...before,
      ...properties
    };

    const preview = {
      before,
      requestedAfter,
      changedKeys,
      scope: `component:${comp.designator || comp.primitiveId}`,
      impact: `Updates properties [${changedKeys.join(", ")}] on component ${comp.designator || comp.primitiveId}.`
    };

    const record = extensionMutations.prepare({
      domain: "schematic",
      action: "updateComponent",
      target: currentTarget,
      operation,
      before,
      requestedAfter: preview.requestedAfter,
      changedKeys: preview.changedKeys,
      scope: preview.scope,
      impact: preview.impact,
      ttlMs: 5 * 60_000
    });

    return {
      mutationId: record.mutationId,
      confirmation: record.confirmation,
      action: record.action,
      target: record.target,
      preview: record.preview,
      expiresAt: record.expiresAt
    };
  }

  if (action === "delete") {
    const componentId = String(params.component ?? "").trim();
    if (!componentId) {
      throw apiError(
        "invalid_params",
        "Field 'component' (designator or primitiveId) is required to delete a component."
      );
    }

    const comp = await findComponentInSchematic(api, componentId);

    const operation = {
      action: "deleteComponent",
      primitiveId: comp.primitiveId,
      designator: comp.designator
    };

    const before = {
      primitiveId: comp.primitiveId,
      designator: comp.designator,
      x: comp.x,
      y: comp.y,
      value: comp.value,
      footprint: comp.footprint
    };

    const preview = {
      before,
      requestedAfter: null,
      changedKeys: ["deleted"],
      scope: `component:${comp.designator || comp.primitiveId}`,
      impact: `Deletes component ${comp.designator || comp.primitiveId} (${comp.primitiveId}) from the schematic.`
    };

    const record = extensionMutations.prepare({
      domain: "schematic",
      action: "deleteComponent",
      target: currentTarget,
      operation,
      before,
      requestedAfter: null,
      changedKeys: preview.changedKeys,
      scope: preview.scope,
      impact: preview.impact,
      ttlMs: 5 * 60_000
    });

    return {
      mutationId: record.mutationId,
      confirmation: record.confirmation,
      action: record.action,
      target: record.target,
      preview: record.preview,
      expiresAt: record.expiresAt
    };
  }

  throw apiError(
    "unsupported_action",
    `Unsupported schematic component mutation action "${action}". Use 'create', 'move', 'update', or 'delete'.`
  );
}

export async function executeSchematicComponentMutation(
  record: MutationRecord,
  api: () => EasyEdaApi
): Promise<{ executed: boolean; readback: Record<string, unknown> }> {
  const eda = api();
  const op = record.operation as Record<string, any>;

  if (op.action === "assignPinNets") return executePinNets(record, api);
  if (op.action === "annotateSchematic") return executeSchematicAnnotation(record, api);
  if (op.action === "layoutSchematic") return executeSchematicLayout(record, api);
  if (op.action === "layoutSchematicAttributes") return executeSchematicAttributeLayout(record, api);

  if (op.action === "createComponent") {
    ensureApi("sch_PrimitiveComponent", "create", eda);

    if (op.uniqueId !== undefined) ensureApi("sch_PrimitiveComponent", "modify", eda);
    let deviceObj: unknown = op.device;
    if (typeof op.device === "string") {
      const searchFn = eda.lib_Device?.search ?? eda.lib_Search?.search;
      if (!searchFn) {
        throw apiError("capability_unavailable", "Device search (lib_Device.search) is unavailable to resolve device.");
      }
      const searchResult = toArray(await searchFn(op.device));
      if (searchResult.length === 0) {
        throw apiError("device_not_found", `Device matching query "${op.device}" was not found in library.`);
      }
      deviceObj = searchResult[0];
    }

    // Recheck legacy prepared records and search results before the non-cancellable SDK create RPC.
    assertCatalogDeviceReference(deviceObj);
    const comp = await eda.sch_PrimitiveComponent.create(
      deviceObj,
      op.x,
      op.y,
      op.subPartName,
      op.rotation,
      op.mirror,
      op.addIntoBom,
      op.addIntoPcb
    );

    const createdPrimitiveId =
      comp?.getState_PrimitiveId?.() ??
      comp?.primitiveId ??
      comp?.id ??
      comp?.uuid ??
      (typeof comp === "string" ? comp : undefined);

    if (!createdPrimitiveId) {
      throw apiError(
        "write_readback_unknown",
        "Component create call completed without returning a valid primitive ID; do not recreate."
      );
    }

    try {
      if (op.uniqueId !== undefined && extensionMutations.get(record.mutationId).status !== "running")
        throw apiError(
          "write_readback_unknown",
          `Component ${createdPrimitiveId} created after mutation deadline; no modify dispatched.`
        );
      if ((op.designator || op.uniqueId !== undefined) && eda.sch_PrimitiveComponent.modify) {
        if (op.uniqueId !== undefined) {
          assertDocumentTargetMatch(
            record.target,
            extractDocumentIdentity(await eda.dmt_SelectControl.getCurrentDocumentInfo())
          );
          if (extensionMutations.get(record.mutationId).status !== "running")
            throw apiError(
              "write_readback_unknown",
              "Mutation expired before property assignment; no modify dispatched."
            );
        }
        await eda.sch_PrimitiveComponent.modify(createdPrimitiveId, {
          ...(op.designator ? { designator: op.designator } : {}),
          ...(op.uniqueId !== undefined ? { uniqueId: op.uniqueId } : {})
        });
      }
    } catch (error) {
      throw apiError(
        "write_readback_unknown",
        `Component ${createdPrimitiveId} was created; property assignment uncertain; do not recreate. ${String(error)}`
      );
    }

    // Readback verification uses a fresh public getter, never the create/modify result.
    try {
      let readbackComp: ResolvedComponent | undefined;
      try {
        readbackComp = await findComponentInSchematic(api, createdPrimitiveId);
      } catch {
        // If findComponentInSchematic doesn't find it yet, check eda.sch_PrimitiveComponent.get
        if (eda.sch_PrimitiveComponent.get) {
          const raw = await eda.sch_PrimitiveComponent.get(createdPrimitiveId);
          if (raw) {
            readbackComp = {
              primitiveId: createdPrimitiveId,
              designator: String(raw.designator ?? raw.name ?? op.designator ?? ""),
              x: numeric(raw.x) ?? op.x,
              y: numeric(raw.y) ?? op.y,
              raw
            };
          }
        }
      }

      if (!readbackComp) {
        throw apiError("write_readback_unknown", `Component ${createdPrimitiveId} could not be verified on readback.`);
      }

      const observedUniqueId =
        typeof readbackComp.raw.getState_UniqueId === "function"
          ? readbackComp.raw.getState_UniqueId()
          : readbackComp.raw.uniqueId;
      if (op.uniqueId !== undefined && observedUniqueId !== op.uniqueId)
        throw apiError(
          "write_readback_unknown",
          `Created component ${createdPrimitiveId} uniqueId readback mismatch; do not recreate.`
        );

      return {
        executed: true,
        readback: {
          ...(op.uniqueId !== undefined ? { uniqueId: observedUniqueId } : {}),
          primitiveId: readbackComp.primitiveId,
          designator: readbackComp.designator,
          x: readbackComp.x,
          y: readbackComp.y,
          verified: true
        }
      };
    } catch (error) {
      throw apiError(
        "write_readback_unknown",
        `Created component ${createdPrimitiveId} could not be independently verified; do not recreate. ${String(error)}`
      );
    }
  }

  if (op.action === "moveComponent") {
    ensureApi("sch_PrimitiveComponent", "modify", eda);
    await eda.sch_PrimitiveComponent.modify(op.primitiveId, { x: op.toX, y: op.toY });

    // Readback verification
    const readback = await findComponentInSchematic(api, op.primitiveId);
    const verified = readback.x === op.toX && readback.y === op.toY;
    if (!verified) {
      throw apiError(
        "readback_verification_failed",
        `Move readback position mismatch: expected (${op.toX}, ${op.toY}), got (${readback.x}, ${readback.y}).`
      );
    }

    return {
      executed: true,
      readback: {
        primitiveId: readback.primitiveId,
        designator: readback.designator,
        x: readback.x,
        y: readback.y,
        verified: true
      }
    };
  }

  if (op.action === "updateComponent") {
    const properties = validatedUpdateProperties(op.properties);
    ensureApi("sch_PrimitiveComponent", "modify", eda);
    try {
      await eda.sch_PrimitiveComponent.modify(op.primitiveId, properties);
      // The SDK return value is not persistence evidence. Check every requested
      // field through a fresh independent getter, including falsy scalar values.
      const readback = await findComponentInSchematic(api, op.primitiveId);
      const observed: Record<string, unknown> = {};
      for (const [key, expected] of Object.entries(properties)) {
        const getter = readback.raw[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
        if (typeof getter !== "function" && !Object.prototype.hasOwnProperty.call(readback.raw, key))
          throw new Error(`${key} readback unavailable.`);
        const actual = nativeProperty(readback.raw, key);
        if (key === "otherProperty") {
          if (!isRecord(actual) || Array.isArray(actual)) throw new Error(`${key} readback unavailable.`);
          const values: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(expected as Record<string, unknown>)) {
            if (actual[name] !== value) throw new Error(`${key}.${name} readback mismatch.`);
            values[name] = actual[name];
          }
          observed[key] = values;
        } else {
          if (actual !== expected) throw new Error(`${key} readback mismatch.`);
          observed[key] = actual;
        }
      }
      return {
        executed: true,
        readback: {
          primitiveId: readback.primitiveId,
          designator: readback.designator,
          properties: observed,
          verifiedKeys: Object.keys(properties),
          verified: true
        }
      };
    } catch (error) {
      throw apiError(
        "write_readback_unknown",
        `Generic component update could not be independently confirmed; do not retry. ${String(error)}`
      );
    }
  }

  if (op.action === "deleteComponent") {
    ensureApi("sch_PrimitiveComponent", "delete", eda);
    await eda.sch_PrimitiveComponent.delete([op.primitiveId]);

    // Readback verification: ensure primitive no longer exists
    let exists: boolean;
    try {
      await findComponentInSchematic(api, op.primitiveId);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      throw apiError("readback_verification_failed", `Component ${op.primitiveId} still exists after delete call.`);
    }

    return {
      executed: true,
      readback: {
        primitiveId: op.primitiveId,
        designator: op.designator,
        deleted: true,
        verified: true
      }
    };
  }

  throw apiError("unsupported_action", `Unsupported schematic operation action "${op.action}".`);
}
