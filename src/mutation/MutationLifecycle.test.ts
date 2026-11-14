import { describe, expect, it, vi } from "vitest";
import type { DocumentIdentity } from "../protocol/identity.js";
import { MutationLifecycle } from "./MutationLifecycle.js";

describe("MutationLifecycle", () => {
  const baseTarget: DocumentIdentity = {
    projectId: "proj-1",
    projectName: "Test Project",
    documentId: "doc-1",
    documentName: "MainBoard.PCB",
    documentType: "pcb",
    tabId: "tab-1",
    capturedAt: new Date().toISOString(),
    completeness: "full",
    source: "native_api",
    fingerprint: "proj-1::doc-1::pcb::tab-1::*"
  };

  it("prepares immutable preview and deterministic confirmation", () => {
    const lifecycle = new MutationLifecycle();
    const before = { trackWidth: 10, clearance: 5 };
    const requestedAfter = { trackWidth: 12, clearance: 5 };

    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "updateRoutingRules",
      target: baseTarget,
      operation: { type: "updateRoutingRules", config: { trackWidth: 12 } },
      before,
      requestedAfter,
      scope: "active_pcb"
    });

    expect(prepared.status).toBe("prepared");
    expect(prepared.documentSaved).toBe(false);
    expect(prepared.confirmation).toBe(`CONFIRM pcb:updateRoutingRules ${prepared.mutationId}`);
    expect(prepared.preview.changedKeys).toEqual(["trackWidth"]);
    expect(prepared.preview.before).toEqual(before);
    expect(prepared.preview.requestedAfter).toEqual(requestedAfter);

    // Modifying source before object does not mutate the prepared record
    before.trackWidth = 999;
    expect(prepared.before.trackWidth).toBe(10);
  });

  it("returns a compact preview while retaining the full immutable proof only once", () => {
    const manager = new MutationLifecycle();
    const before = { proof: "x".repeat(1100000) };
    const record = manager.prepare({
      domain: "sync",
      action: "syncToPcb",
      target: baseTarget,
      operation: {},
      before,
      previewBefore: { proofChars: before.proof.length },
      requestedAfter: { count: 1 },
      scope: "pcb"
    });
    expect(record.before.proof).toBe(before.proof);
    expect(record.preview.before).toEqual({ proofChars: 1100000 });
    expect(record.preview.beforeReference).toBe("record.before");
    expect(JSON.stringify(record).length).toBeLessThan(1200000);
  });
  it("failed return serialization never registers an undiscoverable prepared record", () => {
    const manager = new MutationLifecycle();
    expect(() =>
      manager.prepare({
        domain: "sync",
        action: "syncToPcb",
        target: baseTarget,
        operation: {},
        before: { proof: "x".repeat(1100000) },
        requestedAfter: {},
        scope: "pcb"
      })
    ).toThrow(/2,000,000/);
    expect(manager.getExecutionState()).toMatchObject({ lockHeld: false, preparedCount: 0, unresolvedCount: 0 });
  });
  it("compact-preview recovery requires its trusted deterministic summary and full original before", async () => {
    const first = new MutationLifecycle(),
      summary = (v: any) => ({ proofChars: v.proof.length });
    const r = first.prepare({
      domain: "sync",
      action: "syncToPcb",
      target: baseTarget,
      operation: {},
      before: { proof: "real-proof" },
      previewBefore: summary({ proof: "real-proof" }),
      requestedAfter: {},
      scope: "pcb"
    });
    const unknown = await first.apply({
      mutationId: r.mutationId,
      confirmation: r.confirmation,
      currentTarget: baseTarget,
      currentBefore: r.before,
      execute: async () => {
        throw Object.assign(new Error("late native apply"), { code: "write_readback_unknown" });
      },
      readback: async () => ({})
    });
    const recovered = new MutationLifecycle();
    await expect(
      recovered.reconcileSettledUnknown({
        mutationId: r.mutationId,
        domain: "sync",
        action: "syncToPcb",
        originalRecord: unknown,
        verify: async () => ({ verified: true })
      })
    ).rejects.toMatchObject({ code: "reconciliation_invalid" });
    const tampered = structuredClone(unknown);
    tampered.preview.before = { proofChars: 1 };
    await expect(
      recovered.reconcileSettledUnknown({
        mutationId: r.mutationId,
        domain: "sync",
        action: "syncToPcb",
        originalRecord: tampered,
        summarizeBefore: summary,
        verify: async () => ({ verified: true })
      })
    ).rejects.toMatchObject({ code: "reconciliation_invalid" });
    const result = await recovered.reconcileSettledUnknown({
      mutationId: r.mutationId,
      domain: "sync",
      action: "syncToPcb",
      originalRecord: unknown,
      summarizeBefore: summary,
      verify: async (record) => {
        expect(record.before).toEqual({ proof: "real-proof" });
        return { verified: true };
      }
    });
    expect(result.status).toBe("applied");
  });
  it("requires exact confirmation string to apply", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "schematic",
      action: "addComponent",
      target: baseTarget,
      operation: { type: "add", designator: "R1" },
      before: { count: 0 },
      requestedAfter: { count: 1 },
      scope: "active_sheet"
    });

    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: "confirma",
        currentTarget: baseTarget,
        currentBefore: { count: 0 },
        execute: async () => true,
        readback: async () => ({ count: 1 })
      })
    ).rejects.toThrowError(/Exact confirmation required/i);
  });

  it("blocks mutation when document target has changed since preview", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "moveComponent",
      target: baseTarget,
      operation: { type: "move", id: "C1", x: 100 },
      before: { x: 50 },
      requestedAfter: { x: 100 },
      scope: "active_pcb"
    });

    const switchedTarget = { ...baseTarget, documentId: "doc-2" };

    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: switchedTarget,
        currentBefore: { x: 50 },
        execute: async () => true,
        readback: async () => ({ x: 100 })
      })
    ).rejects.toThrowError(/document ID changed/i);
  });

  it("blocks mutation when state has changed since preview (stale mutation)", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "updateRules",
      target: baseTarget,
      operation: { type: "update", clearance: 15 },
      before: { clearance: 10 },
      requestedAfter: { clearance: 15 },
      scope: "active_pcb"
    });

    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: baseTarget,
        currentBefore: { clearance: 12 }, // State drifted from 10 to 12
        execute: async () => true,
        readback: async () => ({ clearance: 15 })
      })
    ).rejects.toThrowError(/Document state changed since preview/i);
  });

  it("applies mutation once and updates after with verified readback", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "updateRules",
      target: baseTarget,
      operation: { type: "update", clearance: 15 },
      before: { clearance: 10 },
      requestedAfter: { clearance: 15 },
      scope: "active_pcb"
    });

    let executed = 0;
    const result = await lifecycle.apply({
      mutationId: prepared.mutationId,
      confirmation: prepared.confirmation,
      currentTarget: baseTarget,
      currentBefore: { clearance: 10 },
      execute: async () => {
        executed++;
        return true;
      },
      readback: async () => ({ clearance: 15 })
    });

    expect(executed).toBe(1);
    expect(result.status).toBe("applied");
    expect(result.after).toEqual({ clearance: 15 });
    expect(result.documentSaved).toBe(false);

    // Double dispatch is rejected
    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: baseTarget,
        currentBefore: { clearance: 15 },
        execute: async () => true,
        readback: async () => ({ clearance: 15 })
      })
    ).rejects.toThrowError(/already been applied/i);
  });

  it("handles executor failure and marks status failed", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "schematic",
      action: "deleteWire",
      target: baseTarget,
      operation: { type: "delete", wireId: "w1" },
      before: { wireExists: true },
      requestedAfter: { wireExists: false },
      scope: "active_sheet"
    });

    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: baseTarget,
        currentBefore: { wireExists: true },
        execute: async () => false,
        readback: async () => ({ wireExists: true })
      })
    ).rejects.toThrowError(/Mutation execution returned false/i);

    const record = lifecycle.get(prepared.mutationId);
    expect(record.status).toBe("failed");
  });

  it("marks uncertain outcome on timeout or bridge disconnect", () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "autoroute",
      target: baseTarget,
      operation: { type: "autoroute" },
      before: {},
      requestedAfter: {},
      scope: "active_pcb"
    });

    lifecycle.markOutcomeUnknown(prepared.mutationId, new Error("Bridge connection lost"));
    const record = lifecycle.get(prepared.mutationId);
    expect(record.status).toBe("unknown");
    expect(record.error).toContain("Bridge connection lost");
  });

  it("keeps a completed write uncertain when its readback cannot be serialized", async () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "schematic",
      action: "modifyWire",
      target: baseTarget,
      operation: {},
      before: {},
      requestedAfter: {},
      scope: "sheet"
    });
    const execute = vi.fn(async () => true);
    const result = await lifecycle.apply({
      mutationId: prepared.mutationId,
      confirmation: prepared.confirmation,
      currentTarget: baseTarget,
      currentBefore: {},
      execute,
      readback: async () => new Map()
    });
    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Write completed but readback/);
    expect(result.execution?.lockHeld).toBe(false);
    await expect(
      lifecycle.apply({
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: baseTarget,
        currentBefore: {},
        execute,
        readback: async () => ({})
      })
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("expires mutations after TTL", () => {
    const lifecycle = new MutationLifecycle();
    const prepared = lifecycle.prepare({
      domain: "pcb",
      action: "updateRules",
      target: baseTarget,
      operation: { type: "update" },
      before: {},
      requestedAfter: {},
      scope: "active_pcb",
      ttlMs: -1000 // Already expired
    });

    const record = lifecycle.get(prepared.mutationId);
    expect(record.status).toBe("expired");
  });
});

describe("mutation execution deadlines", () => {
  const target: DocumentIdentity = { documentId: "sheet", documentType: "schematic", tabId: "tab" };
  function setup() {
    const lifecycle = new MutationLifecycle(100);
    const options = {
      domain: "schematic",
      action: "addNetLabel",
      target,
      operation: {},
      before: {},
      requestedAfter: {},
      scope: "sheet"
    };
    const prepared = lifecycle.prepare(options);
    return {
      lifecycle,
      options,
      prepared,
      apply: {
        mutationId: prepared.mutationId,
        confirmation: prepared.confirmation,
        currentTarget: target,
        currentBefore: {}
      }
    };
  }

  it("reports a hung write as unknown, retains its lock and forbids replay", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, options, prepared, apply } = setup();
      const execute = vi.fn(() => new Promise<boolean>(() => {}));
      const resultPromise = lifecycle.apply({ ...apply, execute, readback: async () => ({}) });
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;
      expect(result).toMatchObject({
        status: "unknown",
        phase: "execute",
        execution: { lockHeld: true, timeoutMs: 100 }
      });
      expect(result.timedOutAt).toBeDefined();
      expect(() => lifecycle.prepare(options)).toThrow(/still pending/);
      try {
        lifecycle.prepare(options);
      } catch (error) {
        expect((error as { details: unknown }).details).toMatchObject({
          mutationId: prepared.mutationId,
          status: "unknown"
        });
      }
      await expect(lifecycle.apply({ ...apply, execute, readback: async () => ({}) })).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically reconciles late completion and releases the lock", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, options, prepared, apply } = setup();
      let finish!: (value: boolean) => void;
      const resultPromise = lifecycle.apply({
        ...apply,
        execute: () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
        readback: async () => ({ verified: true })
      });
      await vi.advanceTimersByTimeAsync(100);
      expect((await resultPromise).status).toBe("unknown");
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.get(prepared.mutationId)).toMatchObject({
        status: "applied",
        phase: "settled",
        after: { verified: true },
        execution: { lockHeld: false }
      });
      expect(lifecycle.get(prepared.mutationId).error).toBeUndefined();
      expect(() => lifecycle.prepare(options)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes late rejection without an unhandled rejection or a permanent lock", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, options, prepared, apply } = setup();
      let reject!: (error: Error) => void;
      const resultPromise = lifecycle.apply({
        ...apply,
        execute: () =>
          new Promise<boolean>((_, fail) => {
            reject = fail;
          }),
        readback: async () => ({})
      });
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;
      reject(new Error("SDK failed late"));
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.get(prepared.mutationId)).toMatchObject({
        status: "unknown",
        phase: "settled",
        execution: { lockHeld: false }
      });
      expect(() => lifecycle.prepare(options)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a stalled readback without unlocking a newer write on late completion", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, options, prepared, apply } = setup();
      let finishRead!: (value: unknown) => void;
      const first = lifecycle.apply({
        ...apply,
        execute: async () => true,
        readback: () =>
          new Promise((resolve) => {
            finishRead = resolve;
          })
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ status: "unknown", phase: "readback", execution: { lockHeld: false } });
      const next = lifecycle.prepare(options);
      let finishWrite!: (value: boolean) => void;
      const second = lifecycle.apply({
        ...apply,
        mutationId: next.mutationId,
        confirmation: next.confirmation,
        execute: () =>
          new Promise<boolean>((resolve) => {
            finishWrite = resolve;
          }),
        readback: async () => ({})
      });
      finishRead({ verified: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.get(prepared.mutationId).status).toBe("applied");
      expect(lifecycle.get(next.mutationId).execution?.lockHeld).toBe(true);
      expect(() => lifecycle.prepare(options)).toThrow();
      finishWrite(true);
      await second;
      expect(() => lifecycle.prepare(options)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("exposes the observed execution lock and unresolved outcomes without draining native writes", async () => {
  const manager = new MutationLifecycle();
  const target: DocumentIdentity = {
    documentId: "d",
    documentType: "pcb",
    capturedAt: new Date().toISOString(),
    completeness: "partial",
    source: "native_api",
    fingerprint: "d"
  };
  const p = manager.prepare({
    domain: "pcb",
    action: "test",
    target,
    operation: {},
    before: {},
    requestedAfter: {},
    scope: "test"
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = manager.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: target,
    currentBefore: {},
    execute: async () => {
      await pending;
    },
    readback: async () => ({})
  });
  expect(manager.getExecutionState()).toMatchObject({
    lockHeld: true,
    activeMutationId: p.mutationId,
    activeStatus: "running"
  });
  release();
  await completion;
  expect(manager.getExecutionState()).toMatchObject({ lockHeld: false });
  manager.markOutcomeUnknown(p.mutationId, "readback unavailable");
  expect(manager.getExecutionState().unresolved).toEqual([
    expect.objectContaining({ mutationId: p.mutationId, status: "unknown" })
  ]);
});
it("never restores an external applied receipt by default and inserts only after trusted read-only proof", async () => {
  const source = new MutationLifecycle(),
    target: any = { projectId: "p", documentId: "page", documentType: "schematic" };
  const p = source.prepare({
    domain: "schematic",
    action: "legacyDeviceStage",
    target,
    operation: { phase: "stage" },
    before: { count: 1 },
    requestedAfter: { count: 2 },
    scope: "page"
  });
  const receipt = await source.apply({
    mutationId: p.mutationId,
    confirmation: p.confirmation,
    currentTarget: target,
    currentBefore: p.before,
    execute: async () => true,
    readback: async () => ({ count: 2 })
  });
  const recovered = new MutationLifecycle(),
    verify = vi.fn(async () => ({ verified: true }));
  const args = {
    mutationId: p.mutationId,
    domain: "schematic",
    action: "legacyDeviceStage",
    originalRecord: receipt,
    verify
  };
  await expect(recovered.reconcileSettledUnknown(args)).rejects.toMatchObject({ code: "reconciliation_not_ready" });
  expect(verify).not.toHaveBeenCalled();
  expect(() => recovered.get(p.mutationId)).toThrow();
  await expect(
    recovered.reconcileSettledUnknown({
      ...args,
      allowVerifiedAppliedRestore: true,
      verify: async () => {
        expect(recovered.getExecutionState().lockHeld).toBe(true);
        throw new Error("native changed");
      }
    })
  ).rejects.toThrow("native changed");
  expect(() => recovered.get(p.mutationId)).toThrow();
  expect(recovered.getExecutionState().lockHeld).toBe(false);
  const restored = await recovered.reconcileSettledUnknown({ ...args, allowVerifiedAppliedRestore: true });
  expect(restored.reconciliation).toMatchObject({
    previousStatus: "applied",
    recoveredReceipt: true,
    mode: "read_only"
  });
  expect(recovered.get(p.mutationId).after).toEqual({ verified: true });
});
