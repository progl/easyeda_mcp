import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";

/** Opt-in local development telemetry. Never includes document, RPC params or error details. */
export class DevDiagnostics {
  private state = {
    schemaVersion: 1,
    bridgeSession: randomUUID(),
    updatedAt: "",
    connected: false,
    extensionVersion: undefined as string | undefined,
    helloAt: undefined as string | undefined,
    connectionGeneration: 0,
    pendingCalls: 0,
    pendingMutations: 0,
    lockBusy: false,
    uncertainWrite: false,
    lockEvidence: "bridge_observed_calls_not_native_mutex"
  };
  constructor(
    private readonly file?: string,
    private readonly warn: (message: string) => void = () => {}
  ) {}
  get enabled() {
    return Boolean(this.file);
  }
  connection() {
    this.state.connected = false;
    this.state.connectionGeneration++;
    this.state.extensionVersion = undefined;
    this.state.helloAt = undefined;
    this.write();
  }
  hello(version: string) {
    this.state.connected = true;
    this.state.extensionVersion = version;
    this.state.helloAt = new Date().toISOString();
    this.write();
  }
  disconnect() {
    this.state.connected = false;
    this.write();
  }
  pending(calls: number, mutations: number) {
    this.state.pendingCalls = calls;
    this.state.pendingMutations = mutations;
    this.write();
  }
  uncertain() {
    this.state.uncertainWrite = true;
    this.write();
  }
  write() {
    if (!this.file) return;
    this.state.updatedAt = new Date().toISOString();
    this.state.lockBusy = this.state.pendingCalls > 0 || this.state.uncertainWrite;
    try {
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      this.warn("Development diagnostics file could not be written.");
    }
  }
}
