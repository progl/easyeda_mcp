import { vi } from "vitest";
export function pageFixture() {
  let active = "p1";
  const pages: any[] = [
    { uuid: "p1", name: "Main", parentSchematicUuid: "sch" },
    { uuid: "p2", name: "Power", parentSchematicUuid: "sch" }
  ];
  const components: Record<string, any[]> = {
    p1: [
      {
        primitiveId: "c1",
        componentType: "part",
        designator: "R1",
        uniqueId: "uid1",
        x: 100,
        y: 100,
        rotation: 0,
        mirror: false,
        component: { libraryUuid: "lib", uuid: "dev" },
        footprint: { uuid: "fp", libraryUuid: "lib" },
        otherProperty: { Value: "10k" },
        addIntoBom: true,
        addIntoPcb: true
      }
    ],
    p2: []
  };
  const wires: Record<string, any[]> = { p1: [{ primitiveId: "w1", line: [80, 100, 90, 100], net: "GND" }], p2: [] };
  const eda: any = {
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({ uuid: active, parentProjectUuid: "project", documentType: 1 })
    },
    dmt_EditorControl: {
      openDocument: vi.fn(async (id: string) => {
        active = id;
      })
    },
    dmt_Schematic: {
      getCurrentSchematicInfo: async () => ({ uuid: "sch", parentProjectUuid: "project" }),
      getCurrentSchematicAllSchematicPagesInfo: async () => pages,
      getSchematicPageInfo: async (id: string) => pages.find((p) => p.uuid === id),
      createSchematicPage: vi.fn(async () => {
        pages.push({ uuid: "p3", name: "P3", parentSchematicUuid: "sch" });
        components.p3 = [];
        wires.p3 = [];
        return "p3";
      }),
      modifySchematicPageName: vi.fn(async (id: string, name: string) => {
        pages.find((p) => p.uuid === id).name = name;
        return true;
      })
    },
    sch_PrimitiveComponent: {
      getAll: async (_?: unknown, all?: boolean) => (all ? Object.values(components).flat() : components[active]),
      getAllPinsByPrimitiveId: async (id: string) => [
        { primitiveId: id + "-1", pinNumber: "1", x: 90, y: 100, rotation: 180 }
      ],
      create: vi.fn(async (device: any, x: number, y: number) => {
        const c = {
          primitiveId: "copy",
          componentType: "part",
          component: device,
          footprint: { uuid: "fp", libraryUuid: "lib" },
          x,
          y,
          rotation: 0,
          mirror: false,
          addIntoBom: true,
          addIntoPcb: true
        };
        components[active].push(c);
        return c;
      }),
      modify: vi.fn(async (id: string, p: any) => {
        const c = components[active].find((c) => c.primitiveId === id);
        Object.assign(c, p);
        return c;
      }),
      delete: vi.fn(async (ids: string[]) => {
        components[active] = components[active].filter((c) => !ids.includes(c.primitiveId));
        return true;
      })
    },
    sch_PrimitiveWire: {
      getAll: async () => wires[active],
      create: vi.fn(async (line: number[], net: string) => {
        const w = { primitiveId: "copywire", line, net };
        wires[active].push(w);
        return w;
      }),
      delete: vi.fn(async (ids: string[]) => {
        wires[active] = wires[active].filter((w) => !ids.includes(w.primitiveId));
        return true;
      })
    },
    sch_PrimitiveText: { getAll: async () => [] },
    sch_PrimitiveAttribute: { getAll: async () => [] }
  };
  return { eda, pages, components, wires, api: () => eda, active: () => active };
}
