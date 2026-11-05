import type { BrowserIdentity } from "../../src/protocol/messages.js";
/** Coarse JS-host hint, not browser-window attestation. Never transmit the UA. */
export function detectBrowserIdentity(userAgent = globalThis.navigator?.userAgent ?? ""): BrowserIdentity {
  const families: Array<[BrowserIdentity["browserName"], RegExp]> = [
    ["Electron", /\bElectron\/([0-9]+(?:\.[0-9]+){0,4})/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/([0-9]+(?:\.[0-9]+){0,4})/],
    ["Edge", /\b(?:Edg|EdgA|EdgiOS)\/([0-9]+(?:\.[0-9]+){0,4})/],
    ["Opera", /\bOPR\/([0-9]+(?:\.[0-9]+){0,4})/],
    ["Chrome", /\b(?:Chrome|CriOS)\/([0-9]+(?:\.[0-9]+){0,4})/],
    ["Safari", /\bVersion\/([0-9]+(?:\.[0-9]+){0,4}).*\bSafari\//]
  ];
  for (const [browserName, pattern] of families) {
    const match = userAgent.match(pattern);
    if (match)
      return {
        browserName,
        version: match[1].slice(0, 32),
        appKind: browserName === "Electron" ? "desktop" : "browser",
        source: "user_agent"
      };
  }
  return { browserName: "Unknown", appKind: "unknown", source: "user_agent" };
}
