import { WebSocketServer, WebSocket } from "ws";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { context } from "esbuild";
import { packageExtension } from "./package-extension.mjs";

// EasyEDA SDK dev-mode protocol; this endpoint is separate from the MCP bridge.
export async function startDevPublisher({ port = 59394, readDiagnostics = async () => undefined } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 16_384 });
  await once(wss, "listening");
  let current,
    paused = true,
    published,
    verification = { state: "not_published" };
  let nextClient = 0;
  const clients = new Map();
  async function guard(idleConfirmed = false) {
    const d = await readDiagnostics();
    const fresh = d && Date.now() - Date.parse(d.updatedAt) >= 0 && Date.now() - Date.parse(d.updatedAt) < 3500;
    if (fresh && (d.pendingCalls > 0 || d.pendingMutations > 0))
      throw new Error("Bridge busy: pending calls/mutations; package remains staged.");
    if (fresh && d.lockBusy && !idleConfirmed) throw new Error("Bridge busy or uncertain; package remains staged.");
    if (fresh && d.lockBusy && !d.uncertainWrite) throw new Error("Bridge busy: package remains staged.");
    if ((!fresh || !d.connected) && !idleConfirmed)
      throw new Error("Fresh connected bridge diagnostics unavailable; publication paused.");
    return d;
  }
  const send = (socket) => {
    if (current && socket.readyState === WebSocket.OPEN) {
      socket.send(current.message);
      const c = clients.get(socket);
      if (c) c.lastDeliveredAt = new Date().toISOString();
    }
  };
  wss.on("connection", async (socket) => {
    const c = { id: ++nextClient, connectedAt: new Date().toISOString(), registered: false };
    clients.set(socket, c);
    console.log(`[extension-dev] Dev client connected id=${c.id}; clients=${clients.size}`);
    socket.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === "register") {
          c.registered = true;
          c.tabId = typeof m.tabId === "string" ? m.tabId.slice(0, 200) : undefined;
          c.registeredAt = new Date().toISOString();
          console.log(`[extension-dev] Dev client registered id=${c.id}`);
        }
      } catch {
        /* Non-register messages are not installation acknowledgements. */
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      console.log(`[extension-dev] Dev client disconnected id=${c.id}; clients=${clients.size}`);
    });
    if (!paused && current) {
      try {
        await guard(false);
        send(socket);
      } catch (error) {
        console.log(`[extension-dev] Late client delivery withheld: ${error.message}`);
      }
    }
  });
  const publisher = {
    url: `ws://127.0.0.1:${wss.address().port}`,
    async stage(buffer, fileName, { version } = {}) {
      if (
        !Buffer.isBuffer(buffer) ||
        !buffer.length ||
        path.basename(fileName) !== fileName ||
        !fileName.endsWith(".eext")
      )
        throw new Error("Expected nonempty .eext package and plain file name");
      paused = true;
      published = undefined;
      verification = { state: "not_published" };
      current = {
        fileName,
        version,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        stagedAt: new Date().toISOString(),
        message: JSON.stringify({
          type: "file",
          topic: "Dev Mode Extension Package Update",
          content: buffer.toString("base64"),
          fileName,
          fileMimeType: "application/octet-stream"
        })
      };
      console.log(`[extension-dev] Staged ${fileName}; paused; clients=${clients.size}`);
    },
    async release({ idleConfirmed = false } = {}) {
      if (!current) throw new Error("No staged package.");
      const before = await guard(idleConfirmed);
      published = {
        at: new Date().toISOString(),
        bridgeSession: before?.bridgeSession,
        generation: before?.connectionGeneration,
        previousVersion: before?.extensionVersion
      };
      paused = false;
      for (const socket of clients.keys()) send(socket);
      verification = {
        state: "publication_not_installation",
        reason: "Official dev protocol has no installation ACK."
      };
      console.log(`[extension-dev] Published ${current.fileName}; clients=${clients.size}; awaiting new hello.`);
      return publisher.status();
    },
    // Explicit one-shot compatibility API. Watchers must call stage, not publish.
    async publish(buffer, fileName, metadata = {}) {
      await publisher.stage(buffer, fileName, metadata);
      return publisher.release({ idleConfirmed: true });
    },
    pause() {
      paused = true;
    },
    status() {
      return {
        paused,
        clients: [...clients.values()],
        package: current
          ? { fileName: current.fileName, version: current.version, sha256: current.sha256, stagedAt: current.stagedAt }
          : undefined,
        published,
        verification
      };
    },
    async checkRuntime() {
      if (!published) return verification;
      const d = await readDiagnostics();
      const age = d ? Date.now() - Date.parse(d.updatedAt) : NaN;
      if (!d || !Number.isFinite(age) || age < 0 || age > 3500 || !d.connected)
        return (verification = {
          state: "runtime_unavailable",
          reason: "No fresh connected diagnostics; delivery is not installation."
        });
      if (!current.version)
        return (verification = {
          state: "expected_version_unavailable",
          reason: "Stage metadata has no expected version."
        });
      if (d.extensionVersion !== current.version)
        return (verification = {
          state: "stale_runtime",
          expectedVersion: current.version,
          actualVersion: d.extensionVersion
        });
      const newConnection =
        !!published.bridgeSession &&
        d.bridgeSession === published.bridgeSession &&
        d.connectionGeneration > published.generation;
      if (!newConnection || Date.parse(d.helloAt) <= Date.parse(published.at))
        return (verification = { state: "awaiting_new_hello", actualVersion: d.extensionVersion });
      return (verification = {
        state: "runtime_version_confirmed",
        actualVersion: d.extensionVersion,
        helloAt: d.helloAt,
        packageBytesVerified: false,
        sameVersionReplacement: published.previousVersion === d.extensionVersion,
        reason:
          "A new bridge connection reported the expected version after publication; package digest is not in hello."
      });
    },
    async close() {
      for (const s of wss.clients) s.terminate();
      await new Promise((resolve, reject) => wss.close((e) => (e ? reject(e) : resolve())));
    }
  };
  return publisher;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const diagnosticsFile = process.env.EASYEDA_MCP_DEV_STATUS_FILE;
  const readDiagnostics = async () => {
    if (!diagnosticsFile) return undefined;
    try {
      return JSON.parse(await readFile(diagnosticsFile, "utf8"));
    } catch {
      return undefined;
    }
  };
  const publisher = await startDevPublisher({ readDiagnostics });
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.on("line", async (line) => {
    try {
      switch (line.trim()) {
        case "publish":
          await publisher.release();
          break;
        case "publish idle":
          await publisher.release({ idleConfirmed: true });
          break;
        case "pause":
          publisher.pause();
          break;
        case "status":
          await publisher.checkRuntime();
          console.log(JSON.stringify(publisher.status(), null, 2));
          break;
        default:
          console.log("Commands: status | publish | publish idle (explicit quiescence confirmation) | pause");
      }
    } catch (error) {
      console.error(`[extension-dev] ${error.message}`);
    }
  });
  console.log("[extension-dev] Watch builds STAGE ONLY. Commands: status | publish | publish idle | pause");
  console.log(`[extension-dev] ${publisher.url}; Extensions Manager: Up Up Down Down Left Right Left Right b a`);
  let previousVerification;
  const verificationTimer = setInterval(async () => {
    try {
      const result = await publisher.checkRuntime();
      if (result.state !== previousVerification) {
        previousVerification = result.state;
        console.log(`[extension-dev] Runtime: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      console.error(`[extension-dev] Runtime observation failed: ${error.message}`);
    }
  }, 1000);
  verificationTimer.unref();
  const ctx = await context({
    entryPoints: [path.join(root, "extension/src/index.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "edaEsbuildExportName",
    outfile: path.join(root, "extension/dist/index.js"),
    plugins: [
      {
        name: "package-and-publish",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            try {
              const p = await packageExtension();
              const manifestData = JSON.parse(await readFile(path.join(root, "extension/extension.json"), "utf8"));
              await publisher.stage(p.buffer, path.basename(p.outFile), { version: manifestData.version });
              if (process.argv.includes("--auto-publish")) {
                try {
                  await publisher.release();
                } catch (error) {
                  console.log(`[extension-dev] Auto publish withheld: ${error.message}`);
                }
              }
            } catch (error) {
              console.error("[extension-dev] Package not published:", error.message);
            }
          });
        }
      }
    ]
  });
  const manifest = path.join(root, "extension/extension.json");
  watchFile(manifest, { interval: 500 }, () => ctx.rebuild().catch((e) => console.error(e.message)));
  const stop = async () => {
    clearInterval(verificationTimer);
    input.close();
    unwatchFile(manifest);
    await ctx.dispose();
    await publisher.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await ctx.watch();
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
