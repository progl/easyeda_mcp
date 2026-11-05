import { detectBrowserIdentity } from "./browserIdentity.js";
import {
  PROTOCOL_VERSION,
  evaluateProtocolCompatibility,
  type ProtocolCompatibility,
  type BridgeErrorMessage
} from "../../src/protocol/messages.js";
import { EXTENSION_VERSION } from "../../src/version.js";
import { getBridgeUri, type ExtensionBridgeConfig } from "./bridgeConfig.js";
import {
  collectDiagnostics as collectDiagnosticsHelper,
  diagnosticHints,
  isPermissionLikeError
} from "./diagnostics.js";
import { apiError, ensureApi, log, normalizeError, optionalCall, sanitize, showMessage } from "./helpers.js";
import { extractDocumentIdentity } from "./identity.js";
import type { EasyEdaApi } from "./types.js";

export const LEGACY_WS_ID = "easyeda-mcp-bridge";
export const WS_ID = `${LEGACY_WS_ID}@${EXTENSION_VERSION}`;

export type ConnectionPhase = "idle" | "connecting" | "connected" | "blocked";

export type ConnectionState = {
  phase: ConnectionPhase;
  registrationId: string;
  attemptIndex: number;
  lastError?: BridgeErrorMessage["error"];
  lastOpenAt?: string;
  lastStatusAt?: string;
  lastHandshakeAt?: string;
  lastAttemptAt?: string;
  connectedOnce: boolean;
  compatibility: ProtocolCompatibility;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  openTimeoutTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatAckTimer?: ReturnType<typeof setTimeout>;
  pendingPingId?: string;
  heartbeatPeerSupported?: boolean;
  lastHeartbeatAckAt?: string;
};

export interface BridgeConnectionOptions {
  api: () => EasyEdaApi;
  bridgeConfig: ExtensionBridgeConfig;
  onMessage: (raw: string) => Promise<void>;
  getCapabilities: () => Record<string, unknown>;
  onConnectionChanged?: () => void;
}

export interface BridgeConnection {
  ensureConnected(options: { reason: string; manual: boolean; resetAttempts?: boolean }): Promise<void>;
  connect(): void;
  reconnect(): void;
  dispose(): void;
  send(message: Record<string, unknown>): void;
  getStatus(): Promise<Record<string, unknown>>;
  emitStatusUpdate(): Promise<void>;
  collectDiagnostics(): Promise<Record<string, unknown>>;
  getState(): Readonly<ConnectionState>;
}

export function createBridgeConnection(options: BridgeConnectionOptions): BridgeConnection {
  const { api, bridgeConfig, onMessage, getCapabilities, onConnectionChanged } = options;

  let attemptGeneration = 0;
  let disposed = false;
  let legacyCleaned = false;
  let pingSequence = 0;
  const registrationId = `${WS_ID}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  const connectionState: ConnectionState = {
    phase: "idle",
    registrationId,
    attemptIndex: 0,
    connectedOnce: false,
    compatibility: evaluateProtocolCompatibility(PROTOCOL_VERSION)
  };

  function clearOpenTimeout(): void {
    if (connectionState.openTimeoutTimer) {
      clearTimeout(connectionState.openTimeoutTimer);
      connectionState.openTimeoutTimer = undefined;
    }
  }

  function resetConnectionTimers(): void {
    clearOpenTimeout();
    clearHeartbeatProbe();
    connectionState.heartbeatPeerSupported = false;
    connectionState.lastHeartbeatAckAt = undefined;
    if (connectionState.reconnectTimer) {
      clearTimeout(connectionState.reconnectTimer);
      connectionState.reconnectTimer = undefined;
    }
    if (connectionState.heartbeatTimer) {
      clearInterval(connectionState.heartbeatTimer);
      connectionState.heartbeatTimer = undefined;
    }
  }

  function clearHeartbeatProbe(): void {
    if (connectionState.heartbeatAckTimer) clearTimeout(connectionState.heartbeatAckTimer);
    connectionState.heartbeatAckTimer = undefined;
    connectionState.pendingPingId = undefined;
  }

  function sendHeartbeatProbe(): void {
    if (
      disposed ||
      connectionState.phase !== "connected" ||
      !connectionState.heartbeatPeerSupported ||
      connectionState.pendingPingId
    )
      return;
    const generation = attemptGeneration;
    const pingId = `${registrationId}:${generation}:${++pingSequence}`;
    connectionState.pendingPingId = pingId;
    connectionState.heartbeatAckTimer = setTimeout(() => {
      if (generation !== attemptGeneration || disposed || connectionState.pendingPingId !== pingId) return;
      handleConnectionFailure(
        normalizeError(
          apiError(
            "heartbeat_ack_timeout",
            "MCP server heartbeat ACK timed out; reconnecting transport without replaying commands."
          )
        ),
        { manual: false, shouldRetry: true }
      );
      if (typeof api().sys_WebSocket?.close === "function") {
        try {
          api().sys_WebSocket.close(registrationId, 1000, "MCP heartbeat ACK timeout");
        } catch (error) {
          log("warn", "Could not close stale MCP registration", error);
        }
      }
    }, bridgeConfig.heartbeatAckTimeoutMs ?? 5000);
    try {
      send({ kind: "ping", pingId });
    } catch {
      /* send already schedules transport recovery */
    }
  }

  function send(message: Record<string, unknown>): void {
    try {
      ensureApi("sys_WebSocket", "send", api());
      api().sys_WebSocket.send(registrationId, JSON.stringify(message));
    } catch (error) {
      handleConnectionFailure(normalizeError(error), {
        manual: false,
        shouldRetry: true
      });
      throw error;
    }
  }

  async function getStatus(): Promise<Record<string, unknown>> {
    const documentInfo = await optionalCall(() => api().dmt_SelectControl?.getCurrentDocumentInfo?.());
    const documentIdentity = extractDocumentIdentity(documentInfo);
    return {
      connected: connectionState.phase === "connected",
      connectionState: connectionState.phase,
      extensionVersion: EXTENSION_VERSION,
      runtimeId: registrationId,
      browserIdentity: detectBrowserIdentity(),
      protocolVersion: PROTOCOL_VERSION,
      compatibility: connectionState.compatibility,
      capabilities: { ...getCapabilities(), applicationHeartbeat: true },
      heartbeat: {
        mode:
          connectionState.phase !== "connected"
            ? "disconnected"
            : connectionState.heartbeatPeerSupported
              ? connectionState.pendingPingId
                ? "awaiting_ack"
                : "acknowledged"
              : "legacy_unverified",
        lastAckAt: connectionState.lastHeartbeatAckAt,
        note: connectionState.heartbeatPeerSupported
          ? "Application ACK watchdog negotiated."
          : "Peer has not advertised ACK support; silent transport loss cannot be verified."
      },
      documentIdentity,
      activeDocumentType: documentIdentity.documentType,
      projectName: documentIdentity.projectName,
      documentName: documentIdentity.documentName,
      message: connectionState.lastError?.message,
      documentInfo: sanitize(documentInfo),
      updatedAt: new Date().toISOString()
    };
  }

  async function emitStatusUpdate(): Promise<void> {
    const generation = attemptGeneration;
    const status = await getStatus();
    if (generation !== attemptGeneration || disposed) return;
    send({
      kind: "status",
      compatibility: connectionState.compatibility,
      status
    });
    connectionState.lastStatusAt = new Date().toISOString();
  }

  function startHeartbeat(): void {
    if (connectionState.heartbeatTimer) {
      clearInterval(connectionState.heartbeatTimer);
    }
    connectionState.heartbeatTimer = setInterval(() => {
      sendHeartbeatProbe();
      void emitStatusUpdate().catch((error) => {
        handleConnectionFailure(normalizeError(error), {
          manual: false,
          shouldRetry: true
        });
      });
    }, bridgeConfig.heartbeatIntervalMs);
  }

  function handleConnectionFailure(
    error: BridgeErrorMessage["error"],
    failureOptions: { manual: boolean; shouldRetry: boolean }
  ): void {
    // send() and the heartbeat rejection can report the same failure. Preserve
    // the already scheduled attempt rather than advancing backoff twice.
    if (disposed || (connectionState.phase === "idle" && connectionState.reconnectTimer)) return;
    attemptGeneration++;
    if (connectionState.reconnectTimer) {
      clearTimeout(connectionState.reconnectTimer);
      connectionState.reconnectTimer = undefined;
    }
    onConnectionChanged?.();
    clearOpenTimeout();
    clearHeartbeatProbe();
    if (connectionState.heartbeatTimer) {
      clearInterval(connectionState.heartbeatTimer);
      connectionState.heartbeatTimer = undefined;
    }

    connectionState.lastError = error;
    connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
    connectionState.phase =
      isPermissionLikeError(error) || error.code === "api_unavailable" || error.code === "runtime_superseded"
        ? "blocked"
        : "idle";

    // These failures originate from WebSocket register/send or its open timeout,
    // never from command execution. Keep waiting for a delayed/restarted server;
    // permission/API failures stay blocked and require explicit intervention.
    const shouldRetry = !disposed && connectionState.phase !== "blocked" && failureOptions.shouldRetry;
    if (shouldRetry) {
      const nextAttempt = connectionState.attemptIndex + 1;
      const delays = bridgeConfig.reconnectDelayMs;
      const configuredDelay = delays[nextAttempt];
      const lastDelay = delays[delays.length - 1] || 1000;
      const delayMs = Math.min(
        30_000,
        configuredDelay ?? lastDelay * 2 ** Math.min(30, nextAttempt - delays.length + 1)
      );
      connectionState.attemptIndex = nextAttempt;
      connectionState.reconnectTimer = setTimeout(() => {
        connectionState.reconnectTimer = undefined;
        void ensureConnected({
          reason: "retry",
          manual: false
        });
      }, delayMs);
    }

    if (failureOptions.manual || !shouldRetry || connectionState.phase === "blocked") {
      showMessage("EasyEDA MCP Bridge", [error.message, "", ...diagnosticHints(error, bridgeConfig)].join("\n"));
    }
  }

  async function startBridge(startOptions: { reason: string; manual: boolean }): Promise<void> {
    const generation = ++attemptGeneration;
    resetConnectionTimers();
    connectionState.phase = "connecting";
    connectionState.lastAttemptAt = new Date().toISOString();

    const wsUri = getBridgeUri(bridgeConfig);
    const attemptIndex = connectionState.attemptIndex;
    const openTimeoutMs = bridgeConfig.openTimeoutMs;

    connectionState.openTimeoutTimer = setTimeout(() => {
      if (generation !== attemptGeneration || disposed) return;
      const error = apiError("bridge_open_timeout", `Timed out waiting for EasyEDA MCP Bridge to open ${wsUri}.`);
      handleConnectionFailure(normalizeError(error), {
        manual: startOptions.manual,
        shouldRetry: true
      });
    }, openTimeoutMs);

    try {
      ensureApi("sys_WebSocket", "register", api());
      // The SDK registry is shared by extension UUID + ID across runtime loads.
      // Retired versions must never close the current version's registration on retry.
      if (typeof api().sys_WebSocket.close === "function") {
        if (!legacyCleaned) {
          api().sys_WebSocket.close(LEGACY_WS_ID, 1000, "Migrating legacy MCP bridge registration");
          legacyCleaned = true;
        }
        api().sys_WebSocket.close(registrationId, 1000, "Replacing MCP bridge registration");
      }
      api().sys_WebSocket.register(
        registrationId,
        wsUri,
        async (event: MessageEvent<string>) => {
          if (generation !== attemptGeneration || disposed) return;
          try {
            const control = JSON.parse(event.data);
            if (control?.kind === "runtime_retired") {
              handleConnectionFailure(
                {
                  code: "runtime_superseded",
                  message:
                    typeof control.reason === "string"
                      ? control.reason
                      : "This runtime was superseded; use manual Reconnect to take over."
                },
                { manual: false, shouldRetry: false }
              );
              try {
                api().sys_WebSocket?.close?.(registrationId, 1000, "Runtime superseded");
              } catch (error) {
                log("warn", "Could not close retired runtime registration", error);
              }
              return;
            }
            if (control?.kind === "heartbeat_offer") {
              if (control.version === 1 && connectionState.phase === "connected") {
                connectionState.heartbeatPeerSupported = true;
                sendHeartbeatProbe();
              }
              return;
            }
            if (control?.kind === "pong") {
              if (typeof control.pingId === "string" && control.pingId === connectionState.pendingPingId) {
                clearHeartbeatProbe();
                connectionState.lastHeartbeatAckAt = new Date().toISOString();
              }
              return;
            }
          } catch {
            /* Ordinary/malformed messages are handled by the dispatcher. */
          }
          await onMessage(event.data);
        },
        async () => {
          if (generation !== attemptGeneration || disposed) return;
          onConnectionChanged?.();
          connectionState.phase = "connected";
          connectionState.lastOpenAt = new Date().toISOString();
          connectionState.lastHandshakeAt = connectionState.lastOpenAt;
          connectionState.lastError = undefined;
          connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
          connectionState.attemptIndex = 0;
          clearOpenTimeout();
          const status = await getStatus();
          if (generation !== attemptGeneration || disposed) return;
          send({
            kind: "hello",
            client: "easyeda-pro-extension",
            version: EXTENSION_VERSION,
            runtimeId: registrationId,
            browserIdentity: detectBrowserIdentity(),
            takeover: startOptions.manual,
            protocolVersion: PROTOCOL_VERSION,
            compatibility: connectionState.compatibility,
            capabilities: { ...getCapabilities(), applicationHeartbeat: true },
            status
          });
          startHeartbeat();
          connectionState.connectedOnce = true;
          if (startOptions.manual) showMessage("EasyEDA MCP Bridge", `Connected to ${wsUri}.`);
          else log("warn", `EasyEDA MCP Bridge connected automatically to ${wsUri}.`);
        }
      );
    } catch (error) {
      handleConnectionFailure(normalizeError(error), {
        manual: startOptions.manual,
        shouldRetry: true
      });
      return;
    }

    log("warn", `Bridge connection attempt ${attemptIndex + 1} started for ${startOptions.reason} -> ${wsUri}`);
  }

  async function ensureConnected(connectOptions: {
    reason: string;
    manual: boolean;
    resetAttempts?: boolean;
  }): Promise<void> {
    if (disposed && !connectOptions.resetAttempts) return;
    if (connectOptions.resetAttempts) disposed = false;
    if (connectOptions.resetAttempts) {
      connectionState.attemptIndex = 0;
    }

    if (connectionState.phase === "connecting") {
      return;
    }

    if (connectionState.phase === "connected" && !connectOptions.manual) {
      return;
    }

    await startBridge(connectOptions);
  }

  return {
    ensureConnected,
    connect(): void {
      void ensureConnected({ reason: "manual-connect", manual: true, resetAttempts: true });
    },
    reconnect(): void {
      attemptGeneration++;
      onConnectionChanged?.();
      resetConnectionTimers();
      connectionState.phase = "idle";
      connectionState.attemptIndex = 0;
      void ensureConnected({ reason: "manual-reconnect", manual: true, resetAttempts: true });
    },
    dispose(): void {
      disposed = true;
      attemptGeneration++;
      resetConnectionTimers();
      if (typeof api().sys_WebSocket.close === "function")
        api().sys_WebSocket.close(registrationId, 1000, "MCP bridge deactivated");
      connectionState.phase = "idle";
    },
    send,
    getStatus,
    emitStatusUpdate,
    collectDiagnostics: () =>
      collectDiagnosticsHelper(api, bridgeConfig, { ...connectionState, runtimeId: registrationId }),
    getState: () => connectionState
  };
}
