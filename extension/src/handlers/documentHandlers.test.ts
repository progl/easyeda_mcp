import { describe, expect, it, vi } from "vitest";
import {
  collectTabsFromTree,
  convertBlobToDataUrl,
  createDocumentHandlers,
  extractProjectDocuments
} from "./documentHandlers.js";

describe("Extension Document Handlers", () => {
  describe("collectTabsFromTree", () => {
    it("extracts tabs from nested split screen tree", () => {
      const tree = {
        id: "root-split",
        tabs: [{ tabId: "tab-1", documentUuid: "doc-1", title: "Main.PcbDoc", documentType: 3 }],
        children: [
          {
            id: "child-split",
            tabs: [{ id: "tab-2", uuid: "doc-2", name: "Power.SchDoc", documentType: 1 }]
          }
        ]
      };

      const tabs = collectTabsFromTree(tree);
      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toEqual({
        tabId: "tab-1",
        documentUuid: "doc-1",
        title: "Main.PcbDoc",
        documentType: 3,
        splitScreenId: "root-split"
      });
      expect(tabs[1]).toEqual({
        tabId: "tab-2",
        documentUuid: "doc-2",
        title: "Power.SchDoc",
        documentType: 1,
        splitScreenId: "child-split"
      });
    });

    it("returns empty array for invalid tree", () => {
      expect(collectTabsFromTree(null)).toEqual([]);
      expect(collectTabsFromTree(undefined)).toEqual([]);
    });
  });

  describe("extractProjectDocuments", () => {
    it("recursively collects project documents", () => {
      const data = [
        {
          uuid: "sch-1",
          name: "Sheet1.SchDoc",
          documentType: 1,
          children: [{ uuid: "sch-2", name: "Sheet2.SchDoc", documentType: 1 }]
        },
        {
          uuid: "pcb-1",
          name: "Board.PcbDoc",
          documentType: 3
        }
      ];

      const docs = extractProjectDocuments(data);
      expect(docs.map((d) => d.uuid)).toEqual(["sch-1", "sch-2", "pcb-1"]);
    });
  });

  describe("convertBlobToDataUrl", () => {
    it("handles data url strings directly", async () => {
      const res = await convertBlobToDataUrl("data:image/png;base64,QUJD");
      expect(res.dataUrl).toBe("data:image/png;base64,QUJD");
      expect(res.base64).toBe("QUJD");
    });

    it("handles raw base64 strings", async () => {
      const res = await convertBlobToDataUrl("QUJD");
      expect(res.dataUrl).toBe("data:image/png;base64,QUJD");
      expect(res.base64).toBe("QUJD");
    });

    it("handles object with arrayBuffer", async () => {
      const bytes = new Uint8Array([65, 66, 67]); // "ABC"
      const blobLike = {
        type: "image/png",
        arrayBuffer: async () => bytes.buffer
      };
      const res = await convertBlobToDataUrl(blobLike);
      expect(res.base64).toBe("QUJD");
      expect(res.dataUrl).toBe("data:image/png;base64,QUJD");
    });
  });

  describe("createDocumentHandlers", () => {
    it("lists project documents and correlates open tabs and active document", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "doc-pcb",
            name: "Main.PcbDoc",
            documentType: 3,
            tabId: "tab-1",
            parentProjectUuid: "proj-1",
            projectName: "TestProject"
          }))
        },
        dmt_Project: {
          getCurrentProjectInfo: vi.fn(async () => ({
            uuid: "proj-1",
            name: "TestProject",
            data: [
              { uuid: "doc-pcb", name: "Main.PcbDoc", documentType: 3 },
              { uuid: "doc-sch", name: "Power.SchDoc", documentType: 1 }
            ]
          }))
        },
        dmt_EditorControl: {
          getSplitScreenTree: vi.fn(async () => ({
            id: "screen-1",
            tabs: [{ tabId: "tab-1", documentUuid: "doc-pcb", title: "Main.PcbDoc", documentType: 3 }]
          })),
          openDocument: vi.fn(),
          activateDocument: vi.fn(),
          getCurrentRenderedAreaImage: vi.fn()
        }
      });

      const handlers = createDocumentHandlers(api);
      const result = (await handlers.listDocuments({})) as any;

      expect(result.total).toBe(2);
      expect(result.openCount).toBe(1);
      expect(result.activeDocument.documentId).toBe("doc-pcb");
      expect(result.capabilities).toEqual({
        canOpenDocument: true,
        canActivateDocument: true,
        canRenderView: true
      });

      const pcb = result.documents.find((d: any) => d.documentId === "doc-pcb");
      const sch = result.documents.find((d: any) => d.documentId === "doc-sch");
      expect(pcb).toMatchObject({ isOpen: true, isActive: true, tabId: "tab-1" });
      expect(sch).toMatchObject({ isOpen: false, isActive: false });
    });

    it("activates an existing tab when opening an already open document", async () => {
      let activeDoc: any = {
        uuid: "doc-pcb",
        name: "Main.PcbDoc",
        documentType: 3,
        tabId: "tab-1"
      };

      const activateDocumentMock = vi.fn(async (tabId: string) => {
        if (tabId === "tab-2") {
          activeDoc = {
            uuid: "doc-sch",
            name: "Power.SchDoc",
            documentType: 1,
            tabId: "tab-2"
          };
        }
      });

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => activeDoc)
        },
        dmt_EditorControl: {
          getSplitScreenTree: vi.fn(async () => ({
            id: "screen-1",
            tabs: [
              { tabId: "tab-1", documentUuid: "doc-pcb", title: "Main.PcbDoc", documentType: 3 },
              { tabId: "tab-2", documentUuid: "doc-sch", title: "Power.SchDoc", documentType: 1 }
            ]
          })),
          activateDocument: activateDocumentMock
        }
      });

      const handlers = createDocumentHandlers(api);
      const result = (await handlers.openDocument({ documentId: "doc-sch" })) as any;

      expect(activateDocumentMock).toHaveBeenCalledWith("tab-2");
      expect(result.opened).toBe(true);
      expect(result.methodUsed).toBe("activateDocument");
      expect(result.focusChanged).toBe(true);
      expect(result.readbackConfirmed).toBe(true);
      expect(result.currentTarget.documentId).toBe("doc-sch");
    });

    it("opens a new document tab when not currently open", async () => {
      let activeDoc: any = {
        uuid: "doc-pcb",
        name: "Main.PcbDoc",
        documentType: 3,
        tabId: "tab-1"
      };

      const openDocumentMock = vi.fn(async (uuid: string) => {
        activeDoc = {
          uuid,
          name: "NewSheet.SchDoc",
          documentType: 1,
          tabId: "tab-new"
        };
      });

      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => activeDoc)
        },
        dmt_EditorControl: {
          getSplitScreenTree: vi.fn(async () => ({
            id: "screen-1",
            tabs: [{ tabId: "tab-1", documentUuid: "doc-pcb", title: "Main.PcbDoc", documentType: 3 }]
          })),
          openDocument: openDocumentMock
        }
      });

      const handlers = createDocumentHandlers(api);
      const result = (await handlers.openDocument({ documentId: "doc-new-sheet" })) as any;

      expect(openDocumentMock).toHaveBeenCalledWith("doc-new-sheet", undefined);
      expect(result.opened).toBe(true);
      expect(result.methodUsed).toBe("openDocument");
      expect(result.focusChanged).toBe(true);
      expect(result.readbackConfirmed).toBe(true);
    });

    it("throws capability_unavailable when editor control lacks open and activate methods", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({ uuid: "doc-1" }))
        },
        dmt_EditorControl: {}
      });

      const handlers = createDocumentHandlers(api);
      await expect(handlers.openDocument({ documentId: "doc-2" })).rejects.toThrow(/not available/);
    });

    it("renders document view when capability is supported", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "doc-1",
            name: "Main.PcbDoc",
            documentType: 3,
            tabId: "tab-1"
          }))
        },
        dmt_EditorControl: {
          getCurrentRenderedAreaImage: vi.fn(async () => ({
            type: "image/png",
            arrayBuffer: async () => bytes.buffer
          }))
        }
      });

      const handlers = createDocumentHandlers(api);
      const result = (await handlers.renderDocumentView({})) as any;

      expect(result.target.documentId).toBe("doc-1");
      expect(result.tabId).toBe("tab-1");
      expect(result.viewport.type).toBe("visible_canvas_area");
      expect(result.viewport.limits).toHaveLength(3);
      expect(result.dataUrl).toContain("data:image/png;base64,");
    });

    it("enforces target validation on renderDocumentView and rejects on target mismatch", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "doc-current",
            name: "Main.PcbDoc",
            documentType: 3
          }))
        },
        dmt_EditorControl: {
          getCurrentRenderedAreaImage: vi.fn()
        }
      });

      const handlers = createDocumentHandlers(api);
      await expect(
        handlers.renderDocumentView({
          target: { documentId: "expected-other-doc" }
        })
      ).rejects.toThrow(/Active document ID changed/);
    });

    it("throws capability_unavailable on renderDocumentView when getCurrentRenderedAreaImage is missing", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: vi.fn(async () => ({
            uuid: "doc-1",
            name: "Main.PcbDoc",
            documentType: 3
          }))
        },
        dmt_EditorControl: {}
      });

      const handlers = createDocumentHandlers(api);
      await expect(handlers.renderDocumentView({})).rejects.toThrow(/not supported/);
    });
  });
});

describe("safe document view refresh", () => {
  function fixture() {
    let active: any = { uuid: "doc", parentProjectUuid: "p", documentType: 1, tabId: "tab" };
    let tabs: any[] = [{ tabId: "tab", documentUuid: "doc" }];
    const sdk: any = {
      dmt_SelectControl: { getCurrentDocumentInfo: vi.fn(async () => active) },
      dmt_Project: { getCurrentProjectInfo: vi.fn(async () => ({ uuid: "p" })) },
      sch_Document: { save: vi.fn(async () => true) },
      dmt_EditorControl: {
        getSplitScreenTree: vi.fn(async () => ({ id: "split", tabs })),
        closeDocument: vi.fn(async () => {
          setTimeout(() => {
            tabs = [];
            active = { parentProjectUuid: "p" };
          }, 25);
          return true;
        }),
        openDocument: vi.fn(async () => {
          if (tabs.length) throw new Error("opened before close confirmed");
          tabs = [{ tabId: "newtab", documentUuid: "doc" }];
          active = { uuid: "doc", parentProjectUuid: "p", documentType: 1, tabId: "newtab" };
          return "newtab";
        })
      }
    };
    const handler = createDocumentHandlers(() => sdk).refreshDocumentView;
    return {
      sdk,
      handler,
      target: { projectId: "p", documentId: "doc", documentType: "schematic" },
      setActive: (x: any) => {
        active = x;
      }
    };
  }
  it("requires save true and waits for actual asynchronous tab removal before opening once", async () => {
    const f = fixture();
    const result: any = await f.handler({ target: f.target, timeoutMs: 1000 });
    expect(result).toMatchObject({
      status: "refreshed",
      saveVerified: true,
      oldTabRemoved: true,
      targetVerified: true,
      visualRenderVerified: false
    });
    expect(f.sdk.sch_Document.save).toHaveBeenCalledTimes(1);
    expect(f.sdk.dmt_EditorControl.closeDocument).toHaveBeenCalledExactlyOnceWith("tab");
    expect(f.sdk.dmt_EditorControl.openDocument).toHaveBeenCalledTimes(1);
  });
  it("refreshes SDK tabs without a documentUuid using the independently verified active tab ID", async () => {
    const f = fixture();
    const getTree = f.sdk.dmt_EditorControl.getSplitScreenTree.getMockImplementation();
    f.sdk.dmt_EditorControl.getSplitScreenTree.mockImplementation(async () => {
      const tree = await getTree();
      return { ...tree, tabs: tree.tabs.map((t: any) => ({ tabId: t.tabId, title: "PCB1", documentType: 1 })) };
    });
    const result: any = await f.handler({ target: f.target, timeoutMs: 1000 });
    expect(result.status).toBe("refreshed");
    expect(f.sdk.dmt_EditorControl.closeDocument).toHaveBeenCalledExactlyOnceWith("tab");
    expect(f.sdk.dmt_EditorControl.openDocument).toHaveBeenCalledTimes(1);
  });
  it.each([false, undefined])("never closes when save returned %s", async (value) => {
    const f = fixture();
    f.sdk.sch_Document.save.mockResolvedValue(value);
    await expect(f.handler({ target: f.target, timeoutMs: 1000 })).rejects.toThrow(/save|saved/i);
    expect(f.sdk.dmt_EditorControl.closeDocument).not.toHaveBeenCalled();
    expect(f.sdk.dmt_EditorControl.openDocument).not.toHaveBeenCalled();
  });
  it("does not close if the active document changed while saving", async () => {
    const f = fixture();
    f.sdk.sch_Document.save.mockImplementation(async () => {
      f.setActive({ uuid: "other", parentProjectUuid: "p", documentType: 1 });
      return true;
    });
    await expect(f.handler({ target: f.target, timeoutMs: 1000 })).rejects.toThrow(/target|document/i);
    expect(f.sdk.dmt_EditorControl.closeDocument).not.toHaveBeenCalled();
  });
  it("returns unknown after close if reopening fails, without repeating close/open", async () => {
    const f = fixture();
    f.sdk.dmt_EditorControl.openDocument.mockRejectedValue(new Error("open failed"));
    const result: any = await f.handler({ target: f.target, timeoutMs: 1000 });
    expect(result).toMatchObject({ status: "unknown", retryable: false, phase: "open" });
    expect(f.sdk.dmt_EditorControl.closeDocument).toHaveBeenCalledTimes(1);
    expect(f.sdk.dmt_EditorControl.openDocument).toHaveBeenCalledTimes(1);
  });
  it("does not continue to reopen after a timed-out close resolves late", async () => {
    const f = fixture();
    let resolve!: (value: boolean) => void;
    f.sdk.dmt_EditorControl.closeDocument.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        })
    );
    const result: any = await f.handler({ target: f.target, timeoutMs: 200 });
    expect(result).toMatchObject({ status: "unknown", phase: "close", retryable: false });
    resolve(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(f.sdk.dmt_EditorControl.closeDocument).toHaveBeenCalledTimes(1);
    expect(f.sdk.dmt_EditorControl.openDocument).not.toHaveBeenCalled();
  });
  it("never reopens until the actual old tab disappears", async () => {
    const f = fixture();
    f.sdk.dmt_EditorControl.closeDocument.mockResolvedValue(true);
    const result: any = await f.handler({ target: f.target, timeoutMs: 200 });
    expect(result).toMatchObject({ status: "unknown", phase: "wait_closed", oldTabRemoved: false });
    expect(f.sdk.dmt_EditorControl.openDocument).not.toHaveBeenCalled();
  });
  it("aborts reopening if the active project changed after close", async () => {
    const f = fixture();
    const close = f.sdk.dmt_EditorControl.closeDocument.getMockImplementation();
    f.sdk.dmt_EditorControl.closeDocument.mockImplementation(async () => {
      const result = await close();
      f.sdk.dmt_Project.getCurrentProjectInfo.mockResolvedValue({ uuid: "other" });
      return result;
    });
    const result: any = await f.handler({ target: f.target, timeoutMs: 1000 });
    expect(result).toMatchObject({ status: "unknown", retryable: false });
    expect(f.sdk.dmt_EditorControl.openDocument).not.toHaveBeenCalled();
  });
});
