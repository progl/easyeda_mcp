import { DevDiagnostics } from "./DevDiagnostics.js";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { EditorClient } from "../editor/EditorClient.js";
import {
  type BridgeCallMessage,
  type ClientToServerMessage,
  createDisconnectedStatus,
  evaluateProtocolCompatibility,
  type EditorStatus,
  parseClientMessage
} from "../protocol/messages.js";
import {
  BridgeProtocolCompatibilityError,
  BridgeRpcError,
  BridgeTimeoutError,
  BridgeUnavailableError
} from "./errors.js";

type PendingCall = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export type EasyEdaBridgeOptions = {
  host?: string;
  port?: number;
  logger?: Pick<Console, "error" | "warn" | "info">;
  diagnosticsFile?: string;
};

function runtimeVersionOrder(a: string, b: string): number | undefined {
  const parse = (value: string) => {
    if (typeof value !== "string" || value.length > 128) return undefined;
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        value
      );
    if (match?.[4]?.split(".").some((p) => /^\d+$/.test(p) && p.length > 1 && p[0] === "0")) return undefined;
    return match ?? undefined;
  };
  const x = parse(a),
    y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) {
    const u = BigInt(x[i]),
      v = BigInt(y[i]);
    if (u !== v) return u > v ? 1 : -1;
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const u = x[4].split("."),
    v = y[4].split(".");
  for (let i = 0; i < Math.max(u.length, v.length); i++) {
    if (u[i] === v[i]) continue;
    if (u[i] === undefined) return -1;
    if (v[i] === undefined) return 1;
    const un = /^\d+$/.test(u[i]),
      vn = /^\d+$/.test(v[i]);
    if (un && vn) return BigInt(u[i]) > BigInt(v[i]) ? 1 : -1;
    if (un !== vn) return un ? -1 : 1;
    return u[i] < v[i] ? -1 : 1;
  }
  return 0;
}

export class EasyEdaBridge implements EditorClient {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: Pick<Console, "error" | "warn" | "info">;
  private readonly devDiagnostics: DevDiagnostics;
  private diagnosticsTimer?: NodeJS.Timeout;
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private activeRuntimeId?: string;
  // Process-session tombstones: bounded independently of socket reconnects.
  private readonly retiredRuntimeIds = new Map<string, true>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly retiredSockets = new WeakSet<WebSocket>();
  private status: EditorStatus = createDisconnectedStatus();

  constructor(options: EasyEdaBridgeOptions = {}) {
    const envHost = process.env.EASYEDA_MCP_WS_HOST?.trim();
    const envPort = process.env.EASYEDA_MCP_WS_PORT?.trim();
    this.host = options.host ?? (envHost || "127.0.0.1");
    this.port = options.port ?? (envPort ? Number(envPort) : 8765);
    this.logger = options.logger ?? console;
    this.devDiagnostics = new DevDiagnostics(
      options.diagnosticsFile ?? process.env.EASYEDA_MCP_DEV_STATUS_FILE,
      (message) => this.logger.warn(message)
    );
  }

  get endpoint(): string {
    const address = this.wss?.address();
    const activePort = typeof address === "object" && address ? address.port : this.port;
    return `ws://${this.host}:${activePort}`;
  }

  getStatus(): EditorStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ host: this.host, port: this.port });
    this.wss.on("connection", (socket) => this.attachSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.wss?.once("listening", resolve);
      this.wss?.once("error", reject);
    });
    if (this.devDiagnostics.enabled) {
      this.devDiagnostics.write();
      this.diagnosticsTimer = setInterval(() => this.devDiagnostics.write(), 1000);
      this.diagnosticsTimer.unref();
    }
    this.logger.error(`[easyeda-mcp] WebSocket bridge listening at ${this.endpoint}`);
  }

  async stop(): Promise<void> {
    this.rejectAll(new BridgeUnavailableError("EasyEDA Pro bridge is stopping."));
    for (const socket of this.wss?.clients ?? []) socket.close();
    await new Promise<void>((resolve, reject) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
    clearInterval(this.diagnosticsTimer);
    this.devDiagnostics.disconnect();
    this.wss = undefined;
    this.socket = undefined;
    this.activeRuntimeId = undefined;
    this.retiredRuntimeIds.clear();
    this.status = createDisconnectedStatus();
  }

  async call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeUnavailableError();
    }

    if (this.status.compatibility && !this.status.compatibility.compatible) {
      throw new BridgeProtocolCompatibilityError(
        this.status.compatibility.reason ?? "EasyEDA Pro extension protocol is incompatible with the MCP server.",
        this.status.compatibility.expectedProtocolVersion,
        this.status.compatibility.actualProtocolVersion
      );
    }

    if (this.status.connectionState !== "connected")
      throw new BridgeUnavailableError("Extension hello has not established a usable runtime.");

    const requestId = randomUUID();
    const message: BridgeCallMessage = {
      kind: "call",
      requestId,
      method,
      params,
      timeoutMs
    };

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (method === "confirmedAction") this.devDiagnostics.uncertain();
        this.updateDevPending();
        reject(new BridgeTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer
      });
    });

    this.updateDevPending();
    this.socket.send(JSON.stringify(message));
    return response;
  }

  private promoteSocket(socket: WebSocket, runtimeId?: string): void {
    if (this.socket === socket) return;
    const previous = this.socket;
    if (previous) {
      if (this.activeRuntimeId && this.activeRuntimeId !== runtimeId) {
        this.retiredRuntimeIds.delete(this.activeRuntimeId);
        this.retiredRuntimeIds.set(this.activeRuntimeId, true);
        if (this.retiredRuntimeIds.size > 256)
          this.retiredRuntimeIds.delete(this.retiredRuntimeIds.keys().next().value!);
        if (previous.readyState === WebSocket.OPEN)
          previous.send(
            JSON.stringify({
              kind: "runtime_retired",
              reason: "Another runtime took ownership. Use manual Reconnect to take over explicitly."
            })
          );
      }
      this.retiredSockets.add(previous);
      this.rejectAll(
        new BridgeUnavailableError(
          "EasyEDA Pro runtime replaced the connection. Query dispatched mutations; never replay an uncertain write."
        )
      );
      if (previous.readyState === WebSocket.OPEN)
        previous.close(1012, "Superseded by an accepted EasyEDA runtime hello.");
    }
    this.socket = socket;
    this.activeRuntimeId = runtimeId;
    this.devDiagnostics.connection();
    this.status = {
      connected: true,
      connectionState: "connecting",
      message: "EasyEDA Pro extension connected. Waiting for hello/status.",
      updatedAt: new Date().toISOString()
    };
    this.logger.error("[easyeda-mcp] EasyEDA Pro extension connected");
  }

  private attachSocket(socket: WebSocket): void {
    // An unauthenticated TCP connection must not evict a working runtime.

    const helloDeadline = setTimeout(() => {
      if (this.socket !== socket || this.status.connectionState === "connecting")
        socket.close(1008, "Expected a compatible extension hello.");
    }, 10000);
    helloDeadline.unref();
    socket.on("message", (data) => {
      if (this.retiredSockets.has(socket) || socket.readyState !== WebSocket.OPEN) return;
      try {
        const message = parseClientMessage(data.toString());
        if (
          message.kind === "hello" &&
          message.runtimeId !== undefined &&
          (typeof message.runtimeId !== "string" || !message.runtimeId.length || message.runtimeId.length > 256)
        ) {
          if (this.socket !== socket) socket.close(1008, "Invalid runtime ID.");
          return;
        }
        if (
          message.kind === "hello" &&
          this.socket === socket &&
          this.activeRuntimeId &&
          message.runtimeId !== this.activeRuntimeId
        )
          return;
        if (
          message.kind === "hello" &&
          (message.client !== "easyeda-pro-extension" ||
            typeof message.version !== "string" ||
            runtimeVersionOrder(message.version, message.version) !== 0)
        ) {
          if (this.socket !== socket) socket.close(1008, "Invalid extension hello.");
          return;
        }
        if (
          message.kind === "hello" &&
          this.socket === socket &&
          this.status.connectionState === "connected" &&
          this.status.extensionVersion
        ) {
          const order = runtimeVersionOrder(message.version, this.status.extensionVersion);
          if (order === undefined || order < 0) return;
        }
        if (this.socket !== socket) {
          if (message.kind !== "hello") return;
          if (message.runtimeId && this.retiredRuntimeIds.has(message.runtimeId) && message.takeover !== true) {
            socket.send(
              JSON.stringify({
                kind: "runtime_retired",
                reason: "This runtime was superseded. Automatic retries cannot retake ownership; use manual Reconnect."
              })
            );
            socket.close(1008, "Retired runtime requires explicit manual takeover.");
            return;
          }
          const compatible = evaluateProtocolCompatibility(message.protocolVersion).compatible;
          const activeHealthy =
            this.socket?.readyState === WebSocket.OPEN && this.status.connectionState === "connected";
          const order =
            activeHealthy && this.status.extensionVersion
              ? runtimeVersionOrder(message.version, this.status.extensionVersion)
              : 0;
          if (
            (this.socket?.readyState === WebSocket.OPEN && !compatible) ||
            (activeHealthy && (order === undefined || order < 0))
          ) {
            socket.close(
              1008,
              "A compatible same or newer runtime is required while the active connection is healthy."
            );
            return;
          }
          if (activeHealthy && order === 0 && !message.runtimeId) {
            socket.close(1008, "A runtime ID is required to replace a healthy same-version owner.");
            return;
          }
          if (message.runtimeId) this.retiredRuntimeIds.delete(message.runtimeId);
          this.promoteSocket(socket, message.runtimeId);
        }
        if (message.kind === "hello" && !this.activeRuntimeId && message.runtimeId)
          this.activeRuntimeId = message.runtimeId;
        if (message.kind === "hello") clearTimeout(helloDeadline);
        if (this.socket === socket) this.handleMessage(message);
      } catch (error) {
        this.logger.warn(`[easyeda-mcp] Ignored invalid bridge message: ${String(error)}`);
      }
    });
    socket.on("close", () => {
      this.retiredSockets.add(socket);
      clearTimeout(helloDeadline);
      if (this.socket === socket) {
        this.socket = undefined;
        this.devDiagnostics.disconnect();
        this.status = createDisconnectedStatus(
          "EasyEDA Pro extension disconnected. Keep the extension open or reopen EasyEDA Pro."
        );
        this.rejectAll(new BridgeUnavailableError(this.status.message));
        this.logger.error("[easyeda-mcp] EasyEDA Pro extension disconnected");
      }
    });
  }

  private handleMessage(message: ClientToServerMessage): void {
    if (message.kind === "hello") {
      this.devDiagnostics.hello(message.version);
      const compatibility = evaluateProtocolCompatibility(message.protocolVersion);
      this.status = {
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        compatibility,
        capabilities: message.capabilities,
        ...message.status,
        extensionVersion: message.version,
        runtimeId: message.runtimeId,
        browserIdentity: message.browserIdentity ?? message.status?.browserIdentity,
        protocolVersion: message.protocolVersion,
        message: compatibility.compatible ? message.status?.message : compatibility.reason,
        updatedAt: new Date().toISOString()
      };
      if (compatibility.compatible && message.capabilities.applicationHeartbeat === true)
        this.socket?.send(JSON.stringify({ kind: "heartbeat_offer", version: 1 }));
      return;
    }

    if (message.kind === "ping") {
      if (this.status.connectionState === "connected" && this.status.capabilities?.applicationHeartbeat === true)
        this.socket?.send(JSON.stringify({ kind: "pong", pingId: message.pingId }));
      return;
    }

    if (message.kind === "status") {
      // A retired runtime can still have a queued heartbeat; it must not downgrade accepted hello metadata.
      if (
        this.status.extensionVersion &&
        message.status.extensionVersion &&
        message.status.extensionVersion !== this.status.extensionVersion
      )
        return;
      const reportedProtocolVersion = message.status.protocolVersion ?? this.status.protocolVersion;
      const compatibility = evaluateProtocolCompatibility(reportedProtocolVersion);
      this.status = {
        ...this.status,
        ...message.status,
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        compatibility,
        message: compatibility.compatible ? (message.status.message ?? this.status.message) : compatibility.reason,
        updatedAt: new Date().toISOString()
      };
      return;
    }

    if (message.kind === "result") {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (pending.method === "confirmedAction" && (message.result as any)?.status === "unknown")
        this.devDiagnostics.uncertain();
      this.updateDevPending();
      pending.resolve(message.result);
      return;
    }

    if (message.kind === "error") {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (pending.method === "confirmedAction") this.devDiagnostics.uncertain();
      this.updateDevPending();
      pending.reject(new BridgeRpcError(message.error.message, message.error.code, message.error.details));
    }
  }

  private updateDevPending(): void {
    this.devDiagnostics.pending(
      this.pending.size,
      [...this.pending.values()].filter((call) => call.method === "confirmedAction").length
    );
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.method === "confirmedAction") this.devDiagnostics.uncertain();
      pending.reject(error);
      this.pending.delete(requestId);
    }
    this.updateDevPending();
  }
}
