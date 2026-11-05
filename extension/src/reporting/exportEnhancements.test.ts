import { describe, expect, it, vi } from "vitest";
import {
  export3dModel,
  exportDxf,
  exportImage,
  exportProjectArchive,
  validateExportContent,
  validateExportDestination
} from "./exportEnhancements.js";

const stepGeometry =
  "ISO-10303-21;\nHEADER;FILE_DESCRIPTION(('geometry'),'2;1');ENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(10.,0.,0.));\n#3=CARTESIAN_POINT('',(0.,10.,0.));\n#4=POLY_LOOP('',(#1,#2,#3));\n#5=FACE_OUTER_BOUND('',#4,.T.);\n#6=FACE('',(#5));\n#7=OPEN_SHELL('',(#6));\n#8=SHELL_BASED_SURFACE_MODEL('',(#7));\n#9=SHAPE_REPRESENTATION('',(#8),#10);\n#10=GEOMETRIC_REPRESENTATION_CONTEXT(3);\nENDSEC;END-ISO-10303-21;";
describe("exportEnhancements", () => {
  describe("validateExportDestination", () => {
    it("accepts valid filenames and resolves destination path", () => {
      const res = validateExportDestination("board-layer.png", "/path/to/project/exports");
      expect(res.valid).toBe(true);
      expect(res.resolvedFileName).toBe("board-layer.png");
      expect(res.resolvedPath).toBe("/path/to/project/exports/board-layer.png");
    });

    it("rejects empty or whitespace filename", () => {
      const res = validateExportDestination("   ");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("cannot be empty");
    });

    it("rejects filenames containing illegal characters", () => {
      const res = validateExportDestination("bad:name?.svg");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("illegal characters");
    });

    it("rejects unsafe relative directory traversal in destinationPath", () => {
      const res = validateExportDestination("safe.dxf", "../../etc/secrets");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("unsafe relative path traversal");
    });
  });

  describe("validateExportContent", () => {
    it("validates SVG XML content structure", () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>';
      const val = validateExportContent("svg", svg, "test.svg");
      expect(val.valid).toBe(true);
      expect(val.format).toBe("svg");
      expect(val.fileSizeBytes).toBeGreaterThan(50);
      expect(val.checks.some((c) => c.check === "svg_structure" && c.passed)).toBe(true);
    });

    it("validates PNG image header signature", () => {
      const pngDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const val = validateExportContent("png", pngDataUrl, "test.png");
      expect(val.valid).toBe(true);
      expect(val.format).toBe("png");
      expect(val.checks.some((c) => c.check === "png_signature" && c.passed)).toBe(true);
    });

    it("rejects a STEP CAD header without geometric entities", () => {
      const stepData = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('STEP Model'),'2;1');\nENDSEC;\nEND-ISO-10303-21;\n";
      const val = validateExportContent("step", stepData, "model.step");
      expect(val.valid).toBe(false);
      expect(val.format).toBe("step");
      expect(val.checks.some((c) => c.check === "step_iso_header" && c.passed)).toBe(true);
    });

    it("validates OBJ 3D mesh tokens", () => {
      const objData = "# Wavefront OBJ\nv 1.0 2.0 3.0\nv 4.0 5.0 6.0\nv 1.0 6.0 7.0\nf 1 2 3\n";
      const val = validateExportContent("obj", objData, "mesh.obj");
      expect(val.valid).toBe(true);
      expect(val.checks.some((c) => c.check === "obj_tokens" && c.passed)).toBe(true);
    });

    it("validates DXF section headers", () => {
      const dxfData = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n";
      const val = validateExportContent("dxf", dxfData, "layout.dxf");
      expect(val.valid).toBe(true);
      expect(val.format).toBe("dxf");
      expect(val.checks.some((c) => c.check === "dxf_structure" && c.passed)).toBe(true);
    });

    it("flags empty / 0-byte content", () => {
      const val = validateExportContent("svg", "", "empty.svg");
      expect(val.valid).toBe(false);
      expect(val.checks.some((c) => c.check === "file_size" && !c.passed)).toBe(true);
    });
  });

  describe("exportImage", () => {
    it("exports SVG schematic image and runs validation", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: () => ({ documentType: 1, title: "SensorBoard.Schematic" })
        },
        sch_Document: {
          exportSvg: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect/></svg>')
        }
      });
      const saveFile = vi.fn(async (_file, name) => ({ saved: true, fileName: name }));

      const res = await exportImage(api as any, saveFile, {
        fileName: "sheet-1",
        format: "svg",
        scope: "schematic"
      });

      expect(res.saved).toBe(true);
      expect(res.fileName).toBe("sheet-1.svg");
      expect(res.format).toBe("svg");
      expect(res.scope).toBe("schematic");
      expect(res.validation).toMatchObject({ valid: true, format: "svg" });
      expect(saveFile).toHaveBeenCalledWith(expect.anything(), "sheet-1.svg");
    });

    it("exports PNG PCB image using fallback when native renderer returns data", async () => {
      const api = () => ({
        dmt_SelectControl: {
          getCurrentDocumentInfo: () => ({ documentType: 2, title: "MainBoard.PCB" })
        }
      });
      const saveFile = vi.fn(async (_file, name) => ({ saved: true, fileName: name }));

      const res = await exportImage(api as any, saveFile, {
        fileName: "pcb-layout",
        format: "png",
        scope: "pcb",
        transparentBackground: true,
        dpi: 600
      });

      expect(res.saved).toBe(true);
      expect(res.fileName).toBe("pcb-layout.png");
      expect(res.format).toBe("png");
      expect(res.resolutionDpi).toBe(600);
      expect(res.transparentBackground).toBe(true);
      expect(res.validation).toMatchObject({ valid: true });
    });
  });

  describe("export3dModel", () => {
    it("exports STEP CAD geometry with components and copper flags", async () => {
      const get3DFile = vi.fn(async () => new Blob([stepGeometry]));
      const api = () => ({ pcb_ManufactureData: { get3DFile } });
      const saveFile = vi.fn(async (_file, name) => ({ saved: true, fileName: name }));

      const res = await export3dModel(api as any, saveFile, {
        fileName: "pcb-3d",
        format: "step",
        includeComponents3D: true,
        includeCopper: true,
        quality: "high"
      });

      expect(res.saved).toBe(true);
      expect(res.fileName).toBe("pcb-3d.step");
      expect(res.format).toBe("step");
      expect(res.includeComponents3D).toBe(true);
      expect(res.validation).toMatchObject({ valid: true });
      expect(get3DFile).toHaveBeenCalledExactlyOnceWith(
        "pcb-3d",
        "step",
        ["Component Model", "Via", "Wire In Signal Layer", "Silkscreen"],
        "Outfit",
        false
      );
    });
    it("fails before dispatch/save when native get3DFile capability is absent", async () => {
      const save = vi.fn();
      await expect(export3dModel(() => ({}), save, {})).rejects.toMatchObject({ code: "api_unavailable" });
      expect(save).not.toHaveBeenCalled();
    });
    it.each([
      undefined,
      "ISO-10303-21;HEADER;ENDSEC;DATA;#1=APPLICATION_CONTEXT('none');ENDSEC;END-ISO-10303-21;",
      new Uint8Array(100)
    ])("never saves void/header-only/arbitrary binary native output %s", async (raw) => {
      const get3DFile = vi.fn(async () => raw),
        save = vi.fn();
      await expect(export3dModel(() => ({ pcb_ManufactureData: { get3DFile } }), save, {})).rejects.toMatchObject({
        code: "export_outcome_unknown"
      });
      expect(get3DFile).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    });
    it.each(["stl", "wrl"])("rejects unsupported native format %s before dispatch", async (format) => {
      const get3DFile = vi.fn(),
        save = vi.fn();
      await expect(
        export3dModel(() => ({ pcb_ManufactureData: { get3DFile } }), save, { format } as any)
      ).rejects.toMatchObject({ code: "api_unavailable" });
      expect(get3DFile).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe("exportProjectArchive", () => {
    it("saves only a real native project File and does not claim project restoration verified", async () => {
      const file = new File([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4])], "iot-gateway.epro");
      const native = vi.fn(async () => file),
        saveFile = vi.fn(async (_file, name) => ({ saved: true, fileName: name }));
      const result = await exportProjectArchive(
        () => ({
          dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "proj-999", name: "IoT Gateway" }) },
          sys_FileManager: { getProjectFileByProjectUuid: native }
        }),
        saveFile,
        { fileName: "iot-gateway", format: "epro" }
      );
      expect(native).toHaveBeenCalledExactlyOnceWith("proj-999", "iot-gateway", undefined, "epro");
      expect(saveFile).toHaveBeenCalledExactlyOnceWith(file, "iot-gateway.epro");
      expect(result).toMatchObject({
        saved: true,
        nativeFileReceived: true,
        backupVerified: false,
        archiveContentsVerified: false,
        restorationVerified: false
      });
    });
    it("fails closed without native project-file capability even if metadata is available", async () => {
      const save = vi.fn();
      await expect(
        exportProjectArchive(
          () => ({
            dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "p" }), getProjectData: () => [{ id: "doc" }] }
          }),
          save,
          {}
        )
      ).rejects.toMatchObject({ code: "api_unavailable" });
      expect(save).not.toHaveBeenCalled();
    });
    it.each([
      undefined,
      JSON.stringify({ manifest: { documents: ["fake"] } }),
      new File([JSON.stringify({ manifest: {} })], "fake.epro"),
      new File([], "empty.epro")
    ])("does not save undefined/manifest-only/non-native payload %s", async (payload) => {
      const native = vi.fn(async () => payload),
        save = vi.fn();
      await expect(
        exportProjectArchive(
          () => ({
            dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: "p" }) },
            sys_FileManager: { getProjectFile: native }
          }),
          save,
          {}
        )
      ).rejects.toMatchObject({ code: "export_outcome_unknown" });
      expect(native).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe("exportDxf", () => {
    it("exports 2D CAD DXF drawing with PCB units and layer specifications", async () => {
      const api = () => ({
        pcb_ManufactureData: {
          getDxfFile: vi.fn(async () => "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n")
        }
      });
      const saveFile = vi.fn(async (_file, name) => ({ saved: true, fileName: name }));

      const res = await exportDxf(api as any, saveFile, {
        fileName: "board-mechanics",
        scope: "pcb",
        layers: ["Outline", "TopLayer"],
        unit: "mm",
        dxfVersion: "2004"
      });

      expect(res.saved).toBe(true);
      expect(res.fileName).toBe("board-mechanics.dxf");
      expect(res.format).toBe("dxf");
      expect(res.unit).toBe("mm");
      expect(res.dxfVersion).toBe("2004");
      expect(res.layerCount).toBe(2);
      expect(res.validation).toMatchObject({ valid: true });
    });
  });
});
