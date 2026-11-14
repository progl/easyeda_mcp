import { beforeEach, expect, it, vi } from "vitest";
import {
  getBoardInventory,
  prepareBoardOperation,
  executeBoardOperation,
  reconcileBoardCopy
} from "./boardOperations.js";
import { extensionMutations } from "./mutationManager.js";
const board = (name: string, suffix: string) => ({
  name,
  parentProjectUuid: "project",
  schematic: {
    uuid: `sch${suffix}`,
    name: `Schematic${suffix}`,
    parentProjectUuid: "project",
    page: [{ uuid: `page${suffix}`, name: "CONTROL", parentSchematicUuid: `sch${suffix}` }]
  },
  pcb: { uuid: `pcb${suffix}`, name: `PCB${suffix}`, parentProjectUuid: "project" }
});
function fixture() {
  const boards = [board("Original", "0")];
  let project = "project";
  const copyBoard = vi.fn(async (_name: string) => {
    boards.push(board("Original Copy", "1"));
    return "Original Copy";
  });
  const modifyBoardName = vi.fn(async (old: string, name: string) => {
    boards.find((b) => b.name === old)!.name = name;
    return true;
  });
  const eda = {
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: project }) },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: "page0", parentProjectUuid: project, documentType: 1 })
    },
    dmt_Board: {
      getAllBoardsInfo: async () => boards,
      getCurrentBoardInfo: async () => boards[0],
      copyBoard,
      modifyBoardName
    }
  };
  return {
    eda,
    boards,
    copyBoard,
    modifyBoardName,
    setProject: (p: string) => {
      project = p;
    }
  };
}
beforeEach(() => extensionMutations.invalidateAll());
it("lists exact board/SCH/PCB/page links without any copy or source API", async () => {
  const f = fixture(),
    r: any = await getBoardInventory(() => f.eda, {});
  expect(r.projectId).toBe("project");
  expect(r.currentBoardName).toBe("Original");
  expect(r.boards[0]).toMatchObject({
    name: "Original",
    schematic: { uuid: "sch0", pageCount: 1, pages: [{ uuid: "page0" }] },
    pcb: { uuid: "pcb0" }
  });
  expect(f.copyBoard).not.toHaveBeenCalled();
});
it("prepares without writes, copies once using only source name, and proves one new linked board preserving the original", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  expect(f.copyBoard).not.toHaveBeenCalled();
  const r = await executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId));
  expect(f.copyBoard).toHaveBeenCalledExactlyOnceWith("Original");
  expect(r.readback).toMatchObject({
    inventoryVerified: true,
    sourcePreserved: true,
    newBoard: { name: "Original Copy", schematic: { uuid: "sch1" }, pcb: { uuid: "pcb1" } },
    componentCountsVerified: false
  });
  expect(f.boards[0].name).toBe("Original");
});
it("requires project/source/current inventory and blocks destination overwrite before writes", async () => {
  const f = fixture();
  for (const p of [
    { action: "copy", projectId: "other", sourceBoardName: "Original" },
    { action: "copy", projectId: "project", sourceBoardName: "missing" },
    { action: "copy", projectId: "project", sourceBoardName: "Original", newName: "Chosen" },
    { action: "rename", projectId: "project", sourceBoardName: "Original", newName: "Original" }
  ])
    await expect(prepareBoardOperation(() => f.eda, p)).rejects.toThrow();
  expect(f.copyBoard).not.toHaveBeenCalled();
  expect(f.modifyBoardName).not.toHaveBeenCalled();
});
it("rejects stale board inventory before copy", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  f.boards.push(board("Unexpected", "2"));
  await expect(executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toThrow(
    /changed|stale/i
  );
  expect(f.copyBoard).not.toHaveBeenCalled();
});
it("renames only an explicit existing board while preserving linked document IDs", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "rename",
      projectId: "project",
      sourceBoardName: "Original",
      newName: "LOWER"
    });
  const r = await executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId));
  expect(f.modifyBoardName).toHaveBeenCalledExactlyOnceWith("Original", "LOWER");
  expect(r.readback).toMatchObject({
    inventoryVerified: true,
    renamedBoard: { name: "LOWER", schematic: { uuid: "sch0" }, pcb: { uuid: "pcb0" } }
  });
});
it("never silently deletes or repeats a copy when native output is ambiguous", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  f.copyBoard.mockImplementation(async () => {
    f.boards.push(board("Uncertain Copy", "1"));
    return undefined as any;
  });
  await expect(executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId))).rejects.toMatchObject({
    code: "write_readback_unknown"
  });
  expect(f.boards).toHaveLength(2);
  expect(f.copyBoard).toHaveBeenCalledTimes(1);
});

it("requires exact confirmation and never replays an unknown project copy", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const handlers = createActionHandlers(() => f.eda, {} as any);
  const apply = { action: "mutation", params: { mutationId: p.mutationId }, confirmation: p.confirmation };
  await expect(handlers.confirmedAction({ ...apply, confirmation: "CONFIRM" })).rejects.toThrow();
  expect(f.copyBoard).not.toHaveBeenCalled();
  f.copyBoard.mockImplementation(async () => {
    f.boards.push(board("Uncertain Copy", "1"));
    return undefined as any;
  });
  const r: any = await handlers.confirmedAction(apply);
  expect(r.status).toBe("unknown");
  expect(r.mutationId).toBe(p.mutationId);
  try {
    await handlers.confirmedAction(apply);
  } catch {
    /* Unknown copy remains present and consumed. */
  }
  expect(f.copyBoard).toHaveBeenCalledTimes(1);
  expect(f.boards).toHaveLength(2);
});
it("polls only native inventory after copy acknowledgment without another copy", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  vi.useFakeTimers();
  try {
    f.copyBoard.mockImplementation(async () => {
      setTimeout(() => f.boards.push(board("Original Copy", "1")), 500);
      return "Original Copy";
    });
    const execution = executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await execution;
    expect(result.readback.inventoryVerified).toBe(true);
    expect(f.copyBoard).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("polls transient incomplete copied-page metadata instead of aborting readback immediately", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  vi.useFakeTimers();
  try {
    f.copyBoard.mockImplementation(async () => {
      const pending = board("Original Copy", "1");
      pending.schematic.page = [];
      f.boards.push(pending);
      setTimeout(() => {
        pending.schematic.page = board("Original Copy", "1").schematic.page;
      }, 1500);
      return "Original Copy";
    });
    const execution = executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId));
    const assertion = expect(execution).resolves.toMatchObject({
      readback: { inventoryVerified: true, newBoard: { name: "Original Copy" } }
    });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(f.copyBoard).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("reconciles one settled unknown from an explicit original receipt using inventory only", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  const receipt: any = {
    ...extensionMutations.get(p.mutationId),
    mutationId: "00000000-0000-4000-8000-000000000001",
    confirmation: "CONFIRM project:copyBoard 00000000-0000-4000-8000-000000000001",
    status: "unknown",
    phase: "settled",
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    error: "Transient page metadata incomplete"
  };
  f.boards.push(board("Original Copy", "1"));
  const result: any = await reconcileBoardCopy(() => f.eda, {
    mutationId: receipt.mutationId,
    originalRecord: receipt
  });
  expect(result.status).toBe("applied");
  expect(result.execution.lockHeld).toBe(false);
  expect(result.after).toMatchObject({
    inventoryVerified: true,
    sourcePreserved: true,
    verified: false,
    componentCountsVerified: false
  });
  expect(f.copyBoard).not.toHaveBeenCalled();
  expect(f.modifyBoardName).not.toHaveBeenCalled();
});
it("does not promote an ambiguous or source-changed unknown receipt", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  const receipt: any = {
    ...extensionMutations.get(p.mutationId),
    mutationId: "00000000-0000-4000-8000-000000000002",
    confirmation: "CONFIRM project:copyBoard 00000000-0000-4000-8000-000000000002",
    status: "unknown",
    phase: "settled",
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString()
  };
  f.boards.push(board("Copy1", "1"), board("Copy2", "2"));
  await expect(
    reconcileBoardCopy(() => f.eda, { mutationId: receipt.mutationId, originalRecord: receipt })
  ).rejects.toThrow(/proof|additional|one/i);
  expect(f.copyBoard).not.toHaveBeenCalled();
});

it("ends bounded metadata polling as unknown without another native copy when pages never complete", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  vi.useFakeTimers();
  try {
    f.copyBoard.mockImplementation(async () => {
      const pending = board("Original Copy", "1");
      pending.schematic.page = [];
      f.boards.push(pending);
      return "Original Copy";
    });
    const execution = executeBoardOperation(() => f.eda, extensionMutations.get(p.mutationId));
    const assertion = expect(execution).rejects.toMatchObject({ code: "write_readback_unknown" });
    await vi.advanceTimersByTimeAsync(40001);
    await assertion;
    expect(f.copyBoard).toHaveBeenCalledTimes(1);
    expect(f.boards).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
it("reconciles a real stored settled unknown without requiring its old active document", async () => {
  const f = fixture(),
    p: any = await prepareBoardOperation(() => f.eda, {
      action: "copy",
      projectId: "project",
      sourceBoardName: "Original"
    });
  const { createActionHandlers } = await import("../handlers/actionHandlers.js");
  const handlers = createActionHandlers(() => f.eda, {} as any);
  f.copyBoard.mockImplementation(async () => {
    f.boards.push(board("Original Copy", "1"));
    return undefined as any;
  });
  const unknown: any = await handlers.confirmedAction({
    action: "mutation",
    confirmation: p.confirmation,
    params: { mutationId: p.mutationId }
  });
  expect(unknown.status).toBe("unknown");
  f.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({
    uuid: "page1",
    parentProjectUuid: "project",
    documentType: 1
  });
  f.eda.dmt_Board.getCurrentBoardInfo = async () => f.boards[1];
  const result: any = await reconcileBoardCopy(() => f.eda, { mutationId: p.mutationId });
  expect(result.status).toBe("applied");
  expect(result.reconciliation.mode).toBe("read_only");
  expect(result.after.contentsVerified).toBe(false);
  expect(result.after.inventory.currentBoardName).toBe("Original Copy");
  expect(extensionMutations.get(p.mutationId).status).toBe("applied");
  expect(f.copyBoard).toHaveBeenCalledTimes(1);
});
