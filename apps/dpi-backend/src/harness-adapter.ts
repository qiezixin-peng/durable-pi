import type {
  AgentConfig,
  AgentDetail,
  AgentSummary,
  CreateAgentBody,
  CreateSessionBody,
  ForkBody,
  Page,
  SendMessageBody,
  SendResult,
  SessionSummary,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import type { Store } from "./store.js";

/**
 * Stable platform address for an agent. Platform code keeps this mapping and
 * never needs pi-durable's Conversation or Harness objects.
 */
export interface HarnessAgentAddress {
  sessionId: string;
  agentId: number;
}

export interface HarnessRuntimeInfo {
  kind: "pi-durable-sdk";
  version: string;
  capabilities: readonly [
    "sessions",
    "agents",
    "fork",
    "streaming",
    "tools",
    "extensions",
    "compaction",
    "recovery",
  ];
}

/**
 * The platform-to-agent-runtime boundary. Scheduler and Coordinator code use
 * this interface; provider streaming, tool loops and session storage stay in Pi.
 */
export interface HarnessAdapter {
  readonly info: HarnessRuntimeInfo;
  createSession(input: CreateSessionBody): Promise<SessionSummary>;
  archiveSession(sessionId: string): Promise<{ archived: string }>;
  createAgent(sessionId: string, input?: CreateAgentBody): Promise<AgentSummary>;
  getAgent(address: HarnessAgentAddress): Promise<AgentDetail>;
  configureAgent(address: HarnessAgentAddress, config: AgentConfig): Promise<AgentConfig>;
  send(address: HarnessAgentAddress, input: SendMessageBody): Promise<SendResult>;
  wait(sessionId: string, submissionId: number, waitMs?: number, signal?: AbortSignal): Promise<SendResult>;
  abort(address: HarnessAgentAddress, includeBackground?: boolean): Promise<{ ok: true }>;
  fork(address: HarnessAgentAddress, input: ForkBody): Promise<AgentSummary>;
  compact(address: HarnessAgentAddress, instructions?: string): Promise<{ taskId: number }>;
  reset(address: HarnessAgentAddress, note?: string): Promise<{ ok: true }>;
  history(address: HarnessAgentAddress, limit?: number): Promise<Page<WireEntry>>;
}

const ref = (address: HarnessAgentAddress) => String(address.agentId);

/**
 * SDK adapter over the existing durable Store. It intentionally exposes only
 * serializable platform contracts and keeps all Pi objects inside the backend.
 */
export class PiDurableHarnessAdapter implements HarnessAdapter {
  readonly info: HarnessRuntimeInfo;

  constructor(
    private readonly store: Store,
    version: string,
  ) {
    this.info = {
      kind: "pi-durable-sdk",
      version,
      capabilities: [
        "sessions",
        "agents",
        "fork",
        "streaming",
        "tools",
        "extensions",
        "compaction",
        "recovery",
      ],
    };
  }

  createSession(input: CreateSessionBody) {
    return this.store.create(input);
  }

  archiveSession(sessionId: string) {
    return this.store.archive(this.store.resolveSession(sessionId));
  }

  createAgent(sessionId: string, input: CreateAgentBody = {}) {
    return this.store.createAgent(this.store.resolveSession(sessionId), input);
  }

  async getAgent(address: HarnessAgentAddress) {
    const { row, c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.agentDetail(row, c);
  }

  async configureAgent(address: HarnessAgentAddress, config: AgentConfig) {
    const { row, c } = await this.store.resolveAgent(address.sessionId, ref(address));
    const body: Record<string, unknown> = { ...config };
    return this.store.configure(row, c, body);
  }

  async send(address: HarnessAgentAddress, input: SendMessageBody): Promise<SendResult> {
    const { h, c } = await this.store.resolveAgent(address.sessionId, ref(address));
    const body: Record<string, unknown> = { ...input };
    const submission = await this.store.send(c, body);
    if (!input.waitMs) return { submissionId: submission.id as number, status: "queued" };
    return this.store.settled(h, submission.id as number, input.waitMs);
  }

  wait(sessionId: string, submissionId: number, waitMs = 0, signal?: AbortSignal) {
    const row = this.store.resolveSession(sessionId);
    return this.store.settled(this.store.harness(row), submissionId, waitMs, signal);
  }

  async abort(address: HarnessAgentAddress, includeBackground = false) {
    const { c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.abort(c, includeBackground);
  }

  async fork(address: HarnessAgentAddress, input: ForkBody) {
    const { row, c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.fork(row, c, input);
  }

  async compact(address: HarnessAgentAddress, instructions?: string) {
    const { c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.compact(c, instructions);
  }

  async reset(address: HarnessAgentAddress, note?: string) {
    const { c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.reset(c, note);
  }

  async history(address: HarnessAgentAddress, limit = 500) {
    const { c } = await this.store.resolveAgent(address.sessionId, ref(address));
    return this.store.entries(c, undefined, limit);
  }
}
