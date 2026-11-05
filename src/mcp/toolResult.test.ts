import { describe, expect, it } from "vitest";
import { fail, ok, mutationOk } from "./toolResult.js";

describe("toolResult", () => {
  it("includes structured payload inside text content for success results", () => {
    const result = ok("Fetched EasyEDA Pro context.", {
      result: {
        projectName: "Power Supply",
        componentCount: 61
      }
    });

    expect(result.content[0]).toMatchObject({
      type: "text"
    });
    expect(result.content[0]?.text).toContain("Fetched EasyEDA Pro context.");
    expect(result.content[0]?.text).toContain('"projectName": "Power Supply"');
    expect(result.structuredContent).toMatchObject({
      result: {
        projectName: "Power Supply"
      }
    });
  });

  it("includes normalized payload inside text content for error results", () => {
    const result = fail(new Error("boom"));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("boom");
    expect(result.content[0]?.text).toContain('"error": "unexpected_error"');
    expect(result.structuredContent).toMatchObject({
      error: "unexpected_error",
      message: "boom"
    });
  });
  it("keeps complete recovery data structured while rendering a bounded mutation summary", () => {
    const record = {
      mutationId: "m1",
      status: "unknown",
      phase: "settled",
      error: "short diagnostic",
      operation: { before: "private-heavy-state".repeat(10000) },
      after: { verified: false, journal: Array(200).fill("wire-id") }
    };
    const full = { action: "mutation", result: record };
    const result = mutationOk("Mutation outcome", full, record);
    expect(result.structuredContent).toBe(full);
    expect((result.content[0] as any).text).toContain("short diagnostic");
    expect((result.content[0] as any).text).not.toContain("private-heavy-state");
    expect((result.content[0] as any).text.length).toBeLessThan(1000);
  });
});
