import { expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerPcbAnnotationTools } from "./pcbAnnotationTools.js";
it("exposes a prepare-only tool preserving explicit metric input and blocking copper layers", async () => {
  const bridge: any = {
    call: vi.fn(async () => ({ mutationId: "m", confirmation: "CONFIRM pcb:createAnnotations m" }))
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerPcbAnnotationTools(server, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const items = [{ kind: "text", layer: 3, x: 25.4, y: 0, text: "PWR", fontSize: 1.27, lineWidth: 0.127 }];
    expect(
      (await client.callTool({ name: "easyeda_prepare_pcb_annotation", arguments: { items, units: "mm" } })).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenCalledWith(
      "preparePcbAnnotation",
      expect.objectContaining({ items, units: "mm" }),
      30000
    );
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_pcb_annotation",
          arguments: { items: [{ ...items[0], layer: 1 }] }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(1);
    const properties = { x: 2.54, y: 1.27, fontSize: 1.1 };
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_pcb_annotation",
          arguments: { action: "modify", kind: "text", primitiveId: "owned-text", properties, units: "mm" }
        })
      ).isError
    ).toBeFalsy();
    expect(bridge.call).toHaveBeenLastCalledWith(
      "preparePcbAnnotation",
      expect.objectContaining({ action: "modify", kind: "text", primitiveId: "owned-text", properties, units: "mm" }),
      30000
    );
    expect(
      (
        await client.callTool({
          name: "easyeda_prepare_pcb_annotation",
          arguments: { action: "modify", kind: "text", primitiveId: "owned-text", properties: { net: "GND" } }
        })
      ).isError
    ).toBe(true);
    expect(bridge.call).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
