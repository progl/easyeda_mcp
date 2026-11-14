import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSchematicPageCopy,
  prepareSchematicPageDelete,
  executeSchematicPageCopy,
  executeSchematicPageDelete,
  reconcileSchematicPageDelete
} from "./schematicPageCopies.js";
import { extensionMutations } from "./mutationManager.js";

function fixture() {
  const page = (uuid: string, parent: string) => ({ uuid, name: uuid, parentSchematicUuid: parent });
  const board = (uuid: string, pages: string[]) => ({
    name: uuid,
    parentProjectUuid: "project",
    schematic: { uuid, name: uuid, parentProjectUuid: "project", page: pages.map((p) => page(p, uuid)) },
    pcb: { uuid: `${uuid}-pcb`, name: `${uuid}-pcb`, parentProjectUuid: "project" }
  });
  const boards = [board("source", ["original", "source-other"]), board("dest", ["placeholder"])];
  let active = "original";
  const allPages = () => boards.flatMap((b) => b.schematic.page);
  const copy = vi.fn(async (_id: string, dest: string) => {
    boards.find((b) => b.schematic.uuid === dest)!.schematic.page.push(page("copied", dest));
    return "copied" as string | undefined;
  });
  const remove = vi.fn(async (id: string) => {
    for (const b of boards) b.schematic.page = b.schematic.page.filter((p) => p.uuid !== id);
    if (active === id) active = "original";
    return true;
  });
  const eda: any = {
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "project" }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: active, parentProjectUuid: "project", documentType: 1 })
    },
    dmt_Board: {
      getAllBoardsInfo: vi.fn(async () => boards),
      getCurrentBoardInfo: async () => boards.find((b) => b.schematic.page.some((p) => p.uuid === active))
    },
    dmt_Schematic: {
      getSchematicPageInfo: vi.fn(async (id: string) => {
        const p = allPages().find((p) => p.uuid === id);
        return p ? { ...p, description: "original metadata" } : undefined;
      }),
      copySchematicPage: copy,
      deleteSchematicPage: remove
    }
  };
  const api = () => eda;
  return { api, eda, boards, copy, remove, page, active: (id: string) => (active = id) };
}
const copyParams = { projectId: "project", sourcePageId: "original", destinationSchematicUuid: "dest" };
const deleteParams = {
  projectId: "project",
  pageUuid: "source-other",
  owningSchematicUuid: "source",
  protectedBoardName: "dest"
};
const record = (p: { mutationId: string }) => extensionMutations.get(p.mutationId);
beforeEach(() => extensionMutations.invalidateAll());
afterEach(() => vi.useRealTimers());

describe("guarded schematic-page copy", () => {
  it("prepares read-only, deep snapshots exact inventory, then copies once into the explicit other schematic", async () => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    expect(p).toMatchObject({ action: "copySchematicPage", destructive: false });
    expect(f.copy).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    const result = await executeSchematicPageCopy(f.api, record(p));
    expect(f.copy).toHaveBeenCalledExactlyOnceWith("original", "dest");
    expect(result.readback).toMatchObject({
      pageUuid: "copied",
      sourcePreserved: true,
      inventoryVerified: true,
      contentsVerified: false,
      owningSchematicUuid: "dest"
    });
    expect(f.boards[0].schematic.page.map((p) => p.uuid)).toEqual(["original", "source-other"]);
    expect((record(p).before as any).boards.find((b: any) => b.schematic.uuid === "dest").schematic.pages).toHaveLength(
      1
    );
  });
  it.each([
    {},
    { ...copyParams, projectId: "foreign" },
    { ...copyParams, sourcePageId: "missing" },
    { ...copyParams, destinationSchematicUuid: "source" },
    { ...copyParams, destinationSchematicUuid: "missing" },
    { ...copyParams, sourcePageId: " original" }
  ])(
    "rejects missing, wrong-project, same-schematic or ambiguous explicit references before writing: %j",
    async (params) => {
      const f = fixture();
      await expect(prepareSchematicPageCopy(f.api, params)).rejects.toThrow();
      expect(f.copy).not.toHaveBeenCalled();
    }
  );
  it("rejects incomplete native metadata without falling back to page names", async () => {
    const f = fixture();
    f.eda.dmt_Schematic.getSchematicPageInfo = async (id: string) => ({ uuid: id, name: id });
    await expect(prepareSchematicPageCopy(f.api, copyParams)).rejects.toMatchObject({ code: "unverified_inventory" });
    expect(f.copy).not.toHaveBeenCalled();
  });
  it("rejects duplicate global page UUIDs and foreign page ownership", async () => {
    const f = fixture();
    f.boards[1].schematic.page.push(f.page("original", "dest"));
    await expect(prepareSchematicPageCopy(f.api, copyParams)).rejects.toThrow();
    f.boards[1].schematic.page.pop();
    f.boards[1].schematic.page[0].parentSchematicUuid = "foreign";
    await expect(prepareSchematicPageCopy(f.api, copyParams)).rejects.toThrow();
    expect(f.copy).not.toHaveBeenCalled();
  });
  it("rejects stale other-page metadata and current document drift before copying", async () => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    f.boards[1].schematic.page[0].name = "changed";
    await expect(executeSchematicPageCopy(f.api, record(p))).rejects.toMatchObject({ code: "stale_snapshot" });
    f.boards[1].schematic.page[0].name = "placeholder";
    f.active("source-other");
    await expect(executeSchematicPageCopy(f.api, record(p))).rejects.toThrow();
    expect(f.copy).not.toHaveBeenCalled();
  });
  it("rejects a changed full native page property even when normalized board inventory is unchanged", async () => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    const read = f.eda.dmt_Schematic.getSchematicPageInfo;
    f.eda.dmt_Schematic.getSchematicPageInfo = async (id: string) => ({ ...(await read(id)), description: "drift" });
    await expect(executeSchematicPageCopy(f.api, record(p))).rejects.toMatchObject({ code: "stale_snapshot" });
    expect(f.copy).not.toHaveBeenCalled();
  });
  it("retries only transient metadata reads after native acknowledgment and accepts automatic destination focus", async () => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    vi.useFakeTimers();
    f.copy.mockImplementation(async (_id, dest) => {
      const pending: any = f.page("copied", dest);
      delete pending.parentSchematicUuid;
      f.boards[1].schematic.page.push(pending);
      setTimeout(() => {
        pending.parentSchematicUuid = dest;
        f.active("copied");
      }, 1500);
      return "copied";
    });
    const result = executeSchematicPageCopy(f.api, record(p));
    const assertion = expect(result).resolves.toMatchObject({ readback: { inventoryVerified: true } });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(f.copy).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each([undefined, "original", "not-the-created-page", " "])(
    "never cleans up or reports success for invalid copy acknowledgment %j",
    async (ack) => {
      const f = fixture();
      const p = await prepareSchematicPageCopy(f.api, copyParams);
      f.copy.mockImplementation(async () => {
        f.boards[1].schematic.page.push(f.page("copied", "dest"));
        return ack;
      });
      vi.useFakeTimers();
      const result = executeSchematicPageCopy(f.api, record(p));
      const assertion = expect(result).rejects.toMatchObject({ code: "write_readback_unknown" });
      await vi.advanceTimersByTimeAsync(41000);
      await assertion;
      expect(f.copy).toHaveBeenCalledTimes(1);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.boards[1].schematic.page.some((p) => p.uuid === "copied")).toBe(true);
    }
  );
  it.each(["extra", "source-changed"])("does not verify a copy with an unexpected delta: %s", async (problem) => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    f.copy.mockImplementation(async () => {
      f.boards[1].schematic.page.push(f.page("copied", "dest"));
      if (problem === "extra") f.boards[1].schematic.page.push(f.page("extra", "dest"));
      else f.boards[0].schematic.page[0].name = "changed";
      return "copied";
    });
    vi.useFakeTimers();
    const assertion = expect(executeSchematicPageCopy(f.api, record(p))).rejects.toMatchObject({
      code: "write_readback_unknown"
    });
    await vi.advanceTimersByTimeAsync(41000);
    await assertion;
    expect(f.copy).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("retains the lifecycle lock for an uncancellable pending native write and rejects unknown replay", async () => {
    const f = fixture();
    const p = await prepareSchematicPageCopy(f.api, copyParams);
    let finish!: (id: string) => void;
    f.copy.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    vi.useFakeTimers();
    const prepared = record(p);
    let readback: any;
    const apply = (confirmation = p.confirmation) =>
      extensionMutations.apply({
        mutationId: p.mutationId,
        confirmation,
        currentTarget: prepared.target,
        currentBefore: prepared.before,
        execute: async () => {
          const result = await executeSchematicPageCopy(f.api, prepared);
          readback = result.readback;
          return result.executed;
        },
        readback: async () => readback
      });
    await expect(apply("wrong confirmation")).rejects.toMatchObject({ code: "confirmation_required" });
    expect(f.copy).not.toHaveBeenCalled();
    const result = apply();
    await vi.advanceTimersByTimeAsync(46_000);
    const receipt = await result;
    try {
      expect(receipt.status).toBe("unknown");
      expect(extensionMutations.get(p.mutationId).execution?.lockHeld).toBe(true);
      await expect(apply()).rejects.toMatchObject({ code: "mutation_invalid_state" });
      expect(f.copy).toHaveBeenCalledTimes(1);
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      f.boards[1].schematic.page.push(f.page("copied", "dest"));
      finish("copied");
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(extensionMutations.get(p.mutationId).status).toBe("unknown");
    expect(extensionMutations.get(p.mutationId).execution?.lockHeld).toBe(false);
    expect(f.boards[1].schematic.page.some((p) => p.uuid === "copied")).toBe(true);
  });
});

describe("separately confirmed schematic-page deletion", () => {
  it("stages a destructive operation read-only and deletes exactly the explicit non-last page", async () => {
    const f = fixture();
    const p = await prepareSchematicPageDelete(f.api, deleteParams);
    expect(p).toMatchObject({ action: "deleteSchematicPage", destructive: true });
    expect(f.remove).not.toHaveBeenCalled();
    const result = await executeSchematicPageDelete(f.api, record(p));
    expect(result.readback).toMatchObject({ pageUuid: "source-other", pageAbsent: true, otherPagesPreserved: true });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("source-other");
    expect(f.copy).not.toHaveBeenCalled();
  });
  it.each([
    { ...deleteParams, pageUuid: "placeholder", owningSchematicUuid: "dest" },
    { ...deleteParams, owningSchematicUuid: "dest" },
    { ...deleteParams, pageUuid: "missing" }
  ])("rejects last-page or wrong-owner deletion before writes: %j", async (params) => {
    const f = fixture();
    await expect(prepareSchematicPageDelete(f.api, params)).rejects.toThrow();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each([undefined, "source", "missing"])(
    "refuses missing protection, protected-board pages, and an uninventoried protected board: %j",
    async (protectedBoardName) => {
      const f = fixture();
      await expect(prepareSchematicPageDelete(f.api, { ...deleteParams, protectedBoardName })).rejects.toThrow();
      expect(f.remove).not.toHaveBeenCalled();
    }
  );
  it("refuses deleting the last page even when its board is not the protected board", async () => {
    const f = fixture();
    await expect(
      prepareSchematicPageDelete(f.api, {
        projectId: "project",
        pageUuid: "placeholder",
        owningSchematicUuid: "dest",
        protectedBoardName: "source"
      })
    ).rejects.toMatchObject({ code: "last_page" });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("requires native ownership metadata and delete capability, never a guessed metadata fallback", async () => {
    const f = fixture();
    delete f.eda.dmt_Schematic.getSchematicPageInfo;
    await expect(prepareSchematicPageDelete(f.api, deleteParams)).rejects.toMatchObject({
      code: "capability_unavailable"
    });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("rechecks the exact whole inventory before delete instead of trusting prepare", async () => {
    const f = fixture();
    const p = await prepareSchematicPageDelete(f.api, deleteParams);
    f.boards[0].schematic.page = f.boards[0].schematic.page.filter((p) => p.uuid !== "original");
    f.active("source-other");
    await expect(executeSchematicPageDelete(f.api, record(p))).rejects.toThrow();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(["false", "still-present", "other-changed"])("does not claim deletion success when %s", async (problem) => {
    const f = fixture();
    const p = await prepareSchematicPageDelete(f.api, deleteParams);
    f.remove.mockImplementation(async () => {
      if (problem !== "still-present") f.boards[0].schematic.page.pop();
      if (problem === "other-changed") f.boards[1].schematic.page[0].name = "changed";
      return problem !== "false";
    });
    vi.useFakeTimers();
    const assertion = expect(executeSchematicPageDelete(f.api, record(p))).rejects.toMatchObject({
      code: "write_readback_unknown"
    });
    await vi.advanceTimersByTimeAsync(41000);
    await assertion;
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.copy).not.toHaveBeenCalled();
  });
});

describe("derived page title-block metadata", () => {
  it("accepts native owning-page count and number updates after delete, without replay", async () => {
    const f = fixture();
    const base = f.eda.dmt_Schematic.getSchematicPageInfo;
    f.eda.dmt_Schematic.getSchematicPageInfo = vi.fn(async (id: string) => {
      const raw = await base(id);
      if (!raw) return raw;
      const pages = f.boards.find((b) => b.schematic.uuid === raw.parentSchematicUuid)!.schematic.page;
      return {
        ...raw,
        titleBlockData: {
          "@Page Count": { value: String(pages.length), showValue: true },
          "@Page No": { value: String(pages.findIndex((p) => p.uuid === id) + 1), showValue: true }
        }
      };
    });
    const prepared = await prepareSchematicPageDelete(f.api, deleteParams);
    const result = await executeSchematicPageDelete(f.api, record(prepared));
    expect(result.readback.pageAbsent).toBe(true);
    expect(result.readback.allowedDerivedChanges).toHaveLength(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it("reconciles only settled unknown through lifecycle, with no second SDK delete", async () => {
    const f = fixture();
    const prepared = await prepareSchematicPageDelete(f.api, deleteParams);
    const original = record(prepared);
    await extensionMutations.apply({
      mutationId: prepared.mutationId,
      confirmation: prepared.confirmation,
      currentTarget: original.target,
      currentBefore: original.before,
      execute: async () => {
        await f.remove(deleteParams.pageUuid);
        return true;
      },
      readback: async () => {
        throw new Error("lost readback");
      }
    });
    const result = await reconcileSchematicPageDelete(f.api, { mutationId: prepared.mutationId });
    expect(result.status).toBe("applied");
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
});

it.each(["protected metadata", "owning stable metadata", "invalid derived count"])(
  "refuses reconciliation with %s changes",
  async (kind) => {
    const f = fixture();
    const prepared = await prepareSchematicPageDelete(f.api, deleteParams);
    const original = record(prepared);
    await extensionMutations.apply({
      mutationId: prepared.mutationId,
      confirmation: prepared.confirmation,
      currentTarget: original.target,
      currentBefore: original.before,
      execute: async () => {
        await f.remove(deleteParams.pageUuid);
        return true;
      },
      readback: async () => {
        throw new Error("lost readback");
      }
    });
    const base = f.eda.dmt_Schematic.getSchematicPageInfo;
    f.eda.dmt_Schematic.getSchematicPageInfo = vi.fn(async (id: string) => {
      const raw = await base(id);
      if (id !== (kind === "protected metadata" ? "placeholder" : "original")) return raw;
      return kind === "invalid derived count"
        ? { ...raw, titleBlockData: { "@Page Count": { value: "99" } } }
        : { ...raw, description: "unexpected edit" };
    });
    await expect(reconcileSchematicPageDelete(f.api, { mutationId: prepared.mutationId })).rejects.toMatchObject({
      code: "reconciliation_unproven"
    });
    expect(record(prepared).status).toBe("unknown");
    expect(f.remove).toHaveBeenCalledTimes(1);
  }
);
