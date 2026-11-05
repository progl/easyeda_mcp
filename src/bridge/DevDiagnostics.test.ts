import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DevDiagnostics } from "./DevDiagnostics.js";
test("exports only opt-in bridge diagnostics atomically and retains uncertainty after a write timeout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "easyeda-diag-"));
  try {
    const file = path.join(dir, "status.json");
    const d = new DevDiagnostics(file);
    d.connection();
    d.hello("0.6.1");
    d.pending(1, 1);
    d.uncertain();
    d.pending(0, 0);
    const a = JSON.parse(readFileSync(file, "utf8"));
    expect(a).toMatchObject({
      connected: true,
      extensionVersion: "0.6.1",
      connectionGeneration: 1,
      pendingMutations: 0,
      lockBusy: true
    });
    expect(a.helloAt).toBeDefined();
    expect(a.projectName).toBeUndefined();
    d.disconnect();
    expect(JSON.parse(readFileSync(file, "utf8")).connected).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
