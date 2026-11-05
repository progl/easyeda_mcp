import { apiError, inferDocumentType, isRecord, optionalCall, sanitize, toArray } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import type { EasyEdaApi, RpcHandler } from "../types.js";
import { extensionMutations } from "../mutation/mutationManager.js";

export type NormalizedDocumentItem = {
  documentId: string;
  documentName?: string;
  documentType: string;
  projectId?: string;
  projectName?: string;
  isOpen: boolean;
  isActive: boolean;
  tabId?: string;
  splitScreenId?: string;
  identity: DocumentIdentity;
};

export type OpenTabItem = {
  tabId: string;
  documentUuid: string;
  title?: string;
  documentType?: unknown;
  splitScreenId?: string;
};

export function collectTabsFromTree(node: unknown, splitScreenId?: string): OpenTabItem[] {
  const tabs: OpenTabItem[] = [];
  if (!isRecord(node)) return tabs;

  const currentSplitId = typeof node.id === "string" ? node.id : (splitScreenId ?? "root");

  if (Array.isArray(node.tabs)) {
    for (const tab of node.tabs) {
      if (isRecord(tab)) {
        const tabId = typeof tab.tabId === "string" ? tab.tabId : typeof tab.id === "string" ? tab.id : "";
        const documentUuid =
          typeof tab.documentUuid === "string" ? tab.documentUuid : typeof tab.uuid === "string" ? tab.uuid : "";
        tabs.push({
          tabId,
          documentUuid,
          title: typeof tab.title === "string" ? tab.title : typeof tab.name === "string" ? tab.name : undefined,
          documentType: tab.documentType ?? (isRecord(tab.data) ? tab.data.doctype : undefined),
          splitScreenId: currentSplitId
        });
      }
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      tabs.push(...collectTabsFromTree(child, typeof child?.id === "string" ? child.id : currentSplitId));
    }
  }

  return tabs;
}

export function extractProjectDocuments(projectData: unknown): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  const items = toArray(projectData);

  for (const item of items) {
    if (!isRecord(item)) continue;
    const docUuid = item.uuid ?? item.documentUuid ?? item.id;
    if (docUuid) {
      docs.push(item);
    }
    if (Array.isArray(item.children)) {
      docs.push(...extractProjectDocuments(item.children));
    }
    if (Array.isArray(item.data)) {
      docs.push(...extractProjectDocuments(item.data));
    }
  }

  return docs;
}

export async function convertBlobToDataUrl(blob: unknown): Promise<{ dataUrl: string; base64: string }> {
  if (typeof blob === "string") {
    if (blob.startsWith("data:")) {
      const base64 = blob.split(",")[1] ?? "";
      return { dataUrl: blob, base64 };
    }
    return { dataUrl: `data:image/png;base64,${blob}`, base64: blob };
  }

  const anyBlob = blob as any;
  if (anyBlob && typeof anyBlob.arrayBuffer === "function") {
    const buffer = await anyBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
    const mime = anyBlob.type || "image/png";
    return { dataUrl: `data:${mime};base64,${base64}`, base64 };
  }

  if (typeof FileReader !== "undefined" && anyBlob instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1] ?? "";
        resolve({ dataUrl, base64 });
      };
      reader.onerror = reject;
      reader.readAsDataURL(anyBlob);
    });
  }

  throw apiError("invalid_image_blob", "Returned canvas image is not a valid Blob or string representation.");
}

export function createDocumentHandlers(api: () => EasyEdaApi): Record<string, RpcHandler> {
  async function listDocuments(): Promise<Record<string, unknown>> {
    const eda = api();
    const activeDocInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const activeIdentity = extractDocumentIdentity(activeDocInfo);

    const projectInfo = await optionalCall(() => eda.dmt_Project?.getCurrentProjectInfo?.());
    const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl?.getSplitScreenTree?.());
    const openTabs = collectTabsFromTree(splitScreenTree);

    const docMap = new Map<string, NormalizedDocumentItem>();

    // 1. Ingest documents from project structure
    if (isRecord(projectInfo)) {
      const rawProjectDocs = extractProjectDocuments(projectInfo.data);
      for (const rawDoc of rawProjectDocs) {
        const docId = String(rawDoc.uuid ?? rawDoc.documentUuid ?? rawDoc.id ?? "");
        if (!docId) continue;

        const docIdentity = extractDocumentIdentity({
          ...rawDoc,
          parentProjectUuid: projectInfo.uuid ?? rawDoc.parentProjectUuid,
          projectName: projectInfo.name ?? rawDoc.projectName
        });

        docMap.set(docId, {
          documentId: docId,
          documentName: docIdentity.documentName,
          documentType: docIdentity.documentType,
          projectId: docIdentity.projectId,
          projectName: docIdentity.projectName,
          isOpen: false,
          isActive: false,
          identity: docIdentity
        });
      }
    }

    // 2. Correlate with open tabs
    for (const tab of openTabs) {
      if (!tab.documentUuid) continue;
      const existing = docMap.get(tab.documentUuid);
      const isCurrentActive =
        activeIdentity.documentId === tab.documentUuid ||
        (Boolean(activeIdentity.tabId) && activeIdentity.tabId === tab.tabId);

      if (existing) {
        existing.isOpen = true;
        existing.isActive = isCurrentActive;
        existing.tabId = tab.tabId;
        existing.splitScreenId = tab.splitScreenId;
        if (isCurrentActive) {
          existing.identity = activeIdentity;
        }
      } else {
        const docIdentity = extractDocumentIdentity({
          uuid: tab.documentUuid,
          name: tab.title,
          documentType: tab.documentType,
          tabId: tab.tabId,
          parentProjectUuid: activeIdentity.projectId,
          projectName: activeIdentity.projectName
        });
        docMap.set(tab.documentUuid, {
          documentId: tab.documentUuid,
          documentName: tab.title ?? docIdentity.documentName,
          documentType: inferDocumentType({ documentType: tab.documentType }) as string,
          projectId: activeIdentity.projectId,
          projectName: activeIdentity.projectName,
          isOpen: true,
          isActive: isCurrentActive,
          tabId: tab.tabId,
          splitScreenId: tab.splitScreenId,
          identity: isCurrentActive ? activeIdentity : docIdentity
        });
      }
    }

    // 3. Ensure active document is present if not already added
    if (activeIdentity.documentId && !docMap.has(activeIdentity.documentId)) {
      docMap.set(activeIdentity.documentId, {
        documentId: activeIdentity.documentId,
        documentName: activeIdentity.documentName,
        documentType: activeIdentity.documentType,
        projectId: activeIdentity.projectId,
        projectName: activeIdentity.projectName,
        isOpen: true,
        isActive: true,
        tabId: activeIdentity.tabId,
        identity: activeIdentity
      });
    }

    const documents = Array.from(docMap.values());

    return {
      activeDocument: activeIdentity,
      project: isRecord(projectInfo)
        ? {
            uuid: projectInfo.uuid,
            name: projectInfo.name
          }
        : undefined,
      total: documents.length,
      openCount: documents.filter((d) => d.isOpen).length,
      documents: sanitize(documents),
      capabilities: {
        canOpenDocument: Boolean(eda.dmt_EditorControl?.openDocument),
        canActivateDocument: Boolean(eda.dmt_EditorControl?.activateDocument),
        canRenderView: Boolean(eda.dmt_EditorControl?.getCurrentRenderedAreaImage)
      }
    };
  }

  async function openDocument(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const targetDocId = String(params.documentId ?? params.target?.documentId ?? params.uuid ?? "");
    const targetTabId = String(params.tabId ?? params.target?.tabId ?? "");
    const splitScreenId = params.splitScreenId ? String(params.splitScreenId) : undefined;
    const activate = params.activate !== false;

    if (!targetDocId && !targetTabId) {
      throw apiError("invalid_params", "Either documentId or tabId must be provided to open a document.");
    }

    const previousDocInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const previousTarget = extractDocumentIdentity(previousDocInfo);

    // Look for existing tab
    const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl?.getSplitScreenTree?.());
    const openTabs = collectTabsFromTree(splitScreenTree);
    const existingTab = openTabs.find(
      (t) => (targetTabId && t.tabId === targetTabId) || (targetDocId && t.documentUuid === targetDocId)
    );

    let methodUsed: string;

    if (existingTab && activate && eda.dmt_EditorControl?.activateDocument) {
      methodUsed = "activateDocument";
      await eda.dmt_EditorControl.activateDocument(existingTab.tabId);
    } else if (eda.dmt_EditorControl?.openDocument) {
      methodUsed = "openDocument";
      const docUuidToOpen = targetDocId || existingTab?.documentUuid;
      if (!docUuidToOpen) {
        throw apiError("document_not_found", `Could not resolve document UUID for tabId ${targetTabId}.`);
      }
      await eda.dmt_EditorControl.openDocument(docUuidToOpen, splitScreenId);
    } else if (existingTab && eda.dmt_EditorControl?.activateDocument) {
      methodUsed = "activateDocument";
      await eda.dmt_EditorControl.activateDocument(existingTab.tabId);
    } else {
      throw apiError(
        "capability_unavailable",
        "Document opening or tab switching (dmt_EditorControl.openDocument / activateDocument) is not available in the connected EasyEDA Pro version."
      );
    }

    // Readback verification
    const currentDocInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(currentDocInfo);

    const focusChanged =
      previousTarget.documentId !== currentTarget.documentId ||
      (Boolean(previousTarget.tabId) && Boolean(currentTarget.tabId) && previousTarget.tabId !== currentTarget.tabId);

    const readbackConfirmed = Boolean(
      currentTarget.documentId && (!targetDocId || currentTarget.documentId === targetDocId)
    );

    return {
      opened: true,
      methodUsed,
      documentId: targetDocId || currentTarget.documentId,
      tabId: currentTarget.tabId ?? existingTab?.tabId,
      previousTarget,
      currentTarget,
      focusChanged,
      readbackConfirmed,
      viewport: {
        note: "Opening or activating a document alters editor input focus and displays the document canvas viewport."
      }
    };
  }

  async function renderDocumentView(params: Record<string, any>): Promise<Record<string, unknown>> {
    const eda = api();
    const currentDocInfo = await optionalCall(() => eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    const currentTarget = extractDocumentIdentity(currentDocInfo);

    // Validate target if caller specified target expectation
    if (params.target) {
      assertDocumentTargetMatch(params.target, currentTarget);
    }

    if (!eda.dmt_EditorControl?.getCurrentRenderedAreaImage) {
      throw apiError(
        "capability_unavailable",
        "Canvas viewport rendering (dmt_EditorControl.getCurrentRenderedAreaImage) is not supported by the connected EasyEDA Pro version."
      );
    }

    const targetTabId = params.tabId ?? currentTarget.tabId;
    const rawImageBlob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(targetTabId);

    if (!rawImageBlob) {
      throw apiError("capture_empty", "getCurrentRenderedAreaImage returned no image data.");
    }

    const { dataUrl, base64 } = await convertBlobToDataUrl(rawImageBlob);

    return {
      target: currentTarget,
      tabId: targetTabId,
      mimeType: "image/png",
      base64,
      dataUrl,
      viewport: {
        type: "visible_canvas_area",
        limits: [
          "Captures only the currently rendered area of the active canvas viewport, not off-screen primitives.",
          "Resolution and scale correspond directly to the current zoom and viewport dimensions in EasyEDA Pro.",
          "Requires the editor canvas engine to have completed paint execution."
        ]
      }
    };
  }

  let refreshRunning = false;
  async function refreshDocumentView(params: Record<string, any>): Promise<Record<string, unknown>> {
    const expected = params.target;
    if (
      !isRecord(expected) ||
      typeof expected.projectId !== "string" ||
      !expected.projectId ||
      typeof expected.documentId !== "string" ||
      !expected.documentId ||
      !["schematic", "pcb"].includes(String(expected.documentType))
    )
      throw apiError(
        "invalid_params",
        "Refresh requires explicit projectId, documentId and schematic/pcb documentType."
      );
    const timeoutMs = params.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 120000)
      throw apiError("invalid_params", "timeoutMs must be 200–120000 ms.");
    if (refreshRunning || extensionMutations.getExecutionState().lockHeld)
      throw apiError("editor_busy", "Do not refresh while a mutation or another refresh is running.");
    refreshRunning = true;
    const eda = api(),
      control = eda.dmt_EditorControl,
      saveOwner = expected.documentType === "schematic" ? eda.sch_Document : eda.pcb_Document;
    let phase = "preflight",
      closeRequested = false,
      oldTabRemoved = false,
      saveVerified = false;
    const deadline = Date.now() + timeoutMs - Math.min(500, timeoutMs / 10);
    const bounded = async <T>(call: () => Promise<T> | T): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw apiError("refresh_timeout", "Document refresh deadline expired.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(call),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(apiError("refresh_timeout", "Native document refresh call timed out; do not replay.")),
              remaining
            );
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const identity = async () =>
      extractDocumentIdentity(await bounded(() => eda.dmt_SelectControl.getCurrentDocumentInfo()));
    const guard = async () => {
      if (extensionMutations.getExecutionState().lockHeld)
        throw apiError("editor_busy", "A mutation began during refresh; stopped.");
      assertDocumentTargetMatch(expected, await identity());
    };
    const projectGuard = async () => {
      const info: any = await bounded(() => eda.dmt_Project.getCurrentProjectInfo());
      if (String(info?.uuid ?? info?.projectId ?? "") !== expected.projectId)
        throw apiError("target_mismatch", "Active project changed during refresh.");
    };
    const readTabs = async () => {
      const tree = await bounded(() => control.getSplitScreenTree());
      if (
        !isRecord(tree) ||
        typeof tree.id !== "string" ||
        (!Array.isArray(tree.tabs) && !Array.isArray(tree.children))
      )
        throw apiError(
          "unverified_tab_inventory",
          "Native split-screen tree did not provide a verifiable tab inventory."
        );
      return collectTabsFromTree(tree);
    };
    try {
      for (const [owner, method] of [
        [control, "getSplitScreenTree"],
        [control, "closeDocument"],
        [control, "openDocument"],
        [saveOwner, "save"],
        [eda.dmt_Project, "getCurrentProjectInfo"],
        [eda.dmt_SelectControl, "getCurrentDocumentInfo"]
      ] as Array<[any, string]>)
        if (typeof owner?.[method] !== "function")
          throw apiError("capability_unavailable", `Refresh requires public ${method}; no close attempted.`);
      await guard();
      await projectGuard();
      const before = await identity(),
        tabs = await readTabs();
      // Public IDMT_EditorTabItem carries tabId, not documentUuid. Bind that
      // inventory entry to the independently read current document identity.
      const activeTabId = before.tabId ?? expected.tabId;
      const matches = tabs.filter((t) =>
        t.documentUuid ? t.documentUuid === expected.documentId : Boolean(activeTabId && t.tabId === activeTabId)
      );
      if (matches.length !== 1)
        throw apiError("ambiguous_tab", "Expected document must have exactly one open tab before refreshing.");
      const oldTab = matches[0];
      if (before.tabId && oldTab.tabId !== before.tabId)
        throw apiError("target_mismatch", "Active tab does not match native tab inventory.");
      phase = "save";
      await guard();
      if ((await bounded(() => saveOwner.save())) !== true)
        throw apiError("save_unconfirmed", "Native save did not return true; document was never closed.");
      saveVerified = true;
      phase = "close";
      await guard();
      await projectGuard();
      closeRequested = true;
      if ((await bounded(() => control.closeDocument(oldTab.tabId))) !== true)
        throw new Error("Native close did not return true; inspect tabs before recovery.");
      phase = "wait_closed";
      while (true) {
        await projectGuard();
        const current = await readTabs();
        if (!current.some((t) => t.tabId === oldTab.tabId || t.documentUuid === expected.documentId)) {
          oldTabRemoved = true;
          break;
        }
        if (Date.now() >= deadline) throw new Error("Old tab removal was not confirmed.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      phase = "open";
      await projectGuard();
      if (extensionMutations.getExecutionState().lockHeld)
        throw apiError("editor_busy", "A mutation began after close; automatic reopen stopped.");
      const newTabId = await bounded(() => control.openDocument(expected.documentId, oldTab.splitScreenId));
      if (typeof newTabId !== "string" || !newTabId) throw new Error("Native reopen did not return a tab ID.");
      phase = "verify";
      while (true) {
        await projectGuard();
        const current = await identity(),
          currentTabs = await readTabs();
        if (
          current.projectId === expected.projectId &&
          current.documentId === expected.documentId &&
          current.documentType === expected.documentType &&
          current.tabId === newTabId &&
          currentTabs.some((t) => (!t.documentUuid || t.documentUuid === expected.documentId) && t.tabId === newTabId)
        )
          return {
            status: "refreshed",
            saveVerified: true,
            oldTabRemoved: true,
            targetVerified: true,
            visualRenderVerified: false,
            previousTabId: oldTab.tabId,
            tabId: newTabId,
            target: current,
            refreshMethod: "public_save_close_poll_open",
            note: "Reopened saved document; rendered canvas must be checked separately."
          };
        if (Date.now() >= deadline) throw new Error("Reopened document target was not verified.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      if (!closeRequested) throw error;
      return {
        status: "unknown",
        retryable: false,
        phase,
        saveVerified,
        closeRequested,
        oldTabRemoved,
        visualRenderVerified: false,
        error: String(error).slice(0, 600),
        nextSteps: ["Inspect document tabs/current target before recovery. Never automatically repeat save/close/open."]
      };
    } finally {
      refreshRunning = false;
    }
  }

  return {
    listDocuments,
    openDocument,
    renderDocumentView,
    refreshDocumentView
  };
}
