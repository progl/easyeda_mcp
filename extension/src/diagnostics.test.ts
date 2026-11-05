import { describe, expect, it } from "vitest";
import { EXTENSION_VERSION } from "../../src/version.js";
import { formatDiagnostics, formatStatusSummary } from "./diagnostics.js";

describe("Bridge version in user diagnostics", () => {
  it("shows the running extension version even without a server connection", () => {
    const diagnostics = { connection: { phase: "idle" } };
    for (const render of [formatStatusSummary, formatDiagnostics]) {
      const message = render(diagnostics, "ws://127.0.0.1:8765");
      expect(message.split("\n")[0]).toBe(`Bridge version: ${EXTENSION_VERSION}`);
      expect(message).toContain("Connection phase: idle");
    }
  });
});
