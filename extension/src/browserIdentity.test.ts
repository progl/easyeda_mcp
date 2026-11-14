import { expect, it } from "vitest";
import { detectBrowserIdentity } from "./browserIdentity.js";
it.each([
  ["Mozilla/5.0 Firefox/145.0", "Firefox", "145.0", "browser"],
  ["Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36", "Chrome", "142.0.0.0", "browser"],
  ["Chrome/130.0.0.0 Electron/35.2.1", "Electron", "35.2.1", "desktop"],
  ["Chrome/130.0.0.0 Edg/130.0.2.0", "Edge", "130.0.2.0", "browser"]
])("reports only coarse browser identity for %s", (ua, browserName, version, appKind) => {
  const result = detectBrowserIdentity(ua + " https://private.example/project?token=secret");
  expect(result).toEqual({ browserName, version, appKind, source: "user_agent" });
  expect(JSON.stringify(result)).not.toMatch(/private|project|token|secret|Mozilla/);
});
it("keeps an unrecognized or unavailable user-agent unknown", () => {
  expect(detectBrowserIdentity("")).toEqual({ browserName: "Unknown", appKind: "unknown", source: "user_agent" });
});
