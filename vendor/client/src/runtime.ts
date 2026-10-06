import {
  AGENT_PROTOCOL_VERSION,
  AgentResponseSchema,
  AgentWelcomeSchema,
  type AgentRequest,
  type AgentResponse,
  type ExecResult,
  type FileBytes,
  type FileContent,
  type FileEntry,
  type FileListResponse,
  type FileMetadata,
} from "@sessionbox/protocol";
import { newRequestId } from "@sessionbox/shared";
import { SessionBoxClientError } from "./errors.ts";
import {
  READY_STATE_OPEN,
  type WebSocketFactory,
  type WebSocketLike,
} from "./websocket.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestPayload = DistributiveOmit<AgentRequest, "requestId" | "containerId">;

export interface ContainerRuntimeOptions {
  containerId: string;
  url: string;
  webSocketFactory: WebSocketFactory;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Aborting sends `exec.cancel`; the promise then rejects with OPERATION_CANCELLED. */
  signal?: AbortSignal;
  /** Incremental output preview; the final result still carries everything. */
  onOutput?: (event: { stream: "stdout" | "stderr"; data: string }) => void;
}

export interface OpenTerminalOptions {
  cols?: number;
  rows?: number;
  term?: string;
  onOutput?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

/** A programmable PTY on the agent connection. */
export interface AgentTerminal {
  id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface PendingRequest {
  resolve: (response: AgentResponse) => void;
  reject: (error: SessionBoxClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  onStream?: (message: Extract<AgentResponse, { type: "exec.stdout" | "exec.stderr" }>) => void;
  cleanup?: () => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Mirrors the server-side exec default so the client waits a little longer. */
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_GRACE_MS = 5_000;

/**
 * A live connection to one container through the SessionBox agent protocol.
 * The harness adapter uses this instead of touching SSH, files or Docker.
 */
export class ContainerRuntime {
  private readonly containerId: string;
  private readonly url: string;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminalHandlers = new Map<
    string,
    { onOutput?: (data: string) => void; onExit?: (code: number | null) => void }
  >();
  private handshake: { resolve: () => void; reject: (error: SessionBoxClientError) => void } | null =
    null;

  constructor(options: ContainerRuntimeOptions) {
    this.containerId = options.containerId;
    this.url = options.url;
    this.webSocketFactory = options.webSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.socket !== null) return;

    const socket = this.webSocketFactory(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new SessionBoxClientError("OPERATION_TIMEOUT", "timed out opening the agent connection"),
        );
      }, this.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection failed"));
      });
    });

    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());

    const welcome = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new SessionBoxClientError("OPERATION_TIMEOUT", "agent handshake timed out"));
      }, this.connectTimeoutMs);
      this.handshake = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        client: "sessionbox-client",
      }),
    );

    await welcome;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const response = await this.request(
      {
        type: "exec",
        command,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
      {
        // Wait slightly longer than the server-side timeout so its answer wins.
        timeoutMs: (options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_TIMEOUT_GRACE_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.onOutput !== undefined
          ? {
              onStream: (message) =>
                options.onOutput?.({
                  stream: message.type === "exec.stdout" ? "stdout" : "stderr",
                  data: message.data,
                }),
            }
          : {}),
      },
    );
    if (response.type !== "exec.result") {
      throw unexpected(response.type);
    }
    return { exitCode: response.exitCode, stdout: response.stdout, stderr: response.stderr };
  }

  async readFile(
    path: string,
    options: { offset?: number; length?: number } = {},
  ): Promise<FileContent> {
    const response = await this.request({
      type: "file.read",
      path,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.length !== undefined ? { length: options.length } : {}),
    });
    if (response.type !== "file.read.result") throw unexpected(response.type);
    return response.file;
  }

  async readBytes(path: string, options: { maxBytes?: number } = {}): Promise<FileBytes> {
    const response = await this.request({
      type: "file.readBytes",
      path,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    if (response.type !== "file.readBytes.result") throw unexpected(response.type);
    return response.file;
  }

  async writeFile(
    path: string,
    content: string,
    options: { expected?: { version: string } } = {},
  ): Promise<FileMetadata> {
    const response = await this.request({
      type: "file.write",
      path,
      content,
      ...(options.expected !== undefined ? { expected: options.expected } : {}),
    });
    if (response.type !== "file.write.result") throw unexpected(response.type);
    return response.file;
  }

  async listFiles(path: string): Promise<FileListResponse> {
    const response = await this.request({ type: "file.list", path });
    if (response.type !== "file.list.result") throw unexpected(response.type);
    return { path: response.path, entries: response.entries };
  }

  async statFile(path: string, options: { follow?: boolean } = {}): Promise<FileEntry> {
    const response = await this.request({
      type: "file.stat",
      path,
      ...(options.follow !== undefined ? { follow: options.follow } : {}),
    });
    if (response.type !== "file.stat.result") throw unexpected(response.type);
    return response.entry;
  }

  async rename(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<void> {
    const response = await this.request({
      type: "file.rename",
      from,
      to,
      ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
    });
    if (response.type !== "file.rename.result") throw unexpected(response.type);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const response = await this.request({ type: "file.chmod", path, mode });
    if (response.type !== "file.chmod.result") throw unexpected(response.type);
  }

  async symlink(path: string, target: string): Promise<void> {
    const response = await this.request({ type: "file.symlink", path, target });
    if (response.type !== "file.symlink.result") throw unexpected(response.type);
  }

  /** Opens a PTY; output arrives through the returned handle's callbacks. */
  async openTerminal(options: OpenTerminalOptions = {}): Promise<AgentTerminal> {
    const response = await this.request({
      type: "terminal.open",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      ...(options.term !== undefined ? { term: options.term } : {}),
    });
    if (response.type !== "terminal.opened") throw unexpected(response.type);

    const terminalId = response.terminalId;
    this.terminalHandlers.set(terminalId, {
      ...(options.onOutput !== undefined ? { onOutput: options.onOutput } : {}),
      ...(options.onExit !== undefined ? { onExit: options.onExit } : {}),
    });

    return {
      id: terminalId,
      write: (data) => this.sendFrame({ type: "terminal.input", terminalId, data }),
      resize: (cols, rows) => this.sendFrame({ type: "terminal.resize", terminalId, cols, rows }),
      close: () => {
        this.terminalHandlers.delete(terminalId);
        this.sendFrame({ type: "terminal.close", terminalId });
      },
    };
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const response = await this.request({
      type: "file.mkdir",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    });
    if (response.type !== "file.mkdir.result") throw unexpected(response.type);
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const response = await this.request({
      type: "file.remove",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    });
    if (response.type !== "file.remove.result") throw unexpected(response.type);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new SessionBoxClientError("INVALID_STATE", "runtime was closed"));
    this.failTerminals(null);
    if (socket !== null) socket.close();
  }

  private async request(
    payload: RequestPayload,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onStream?: (message: Extract<AgentResponse, { type: "exec.stdout" | "exec.stderr" }>) => void;
    } = {},
  ): Promise<AgentResponse> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== READY_STATE_OPEN) {
      throw new SessionBoxClientError("INVALID_STATE", "agent connection is not open");
    }

    const requestId = newRequestId();

    return await new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(requestId);
        if (pending !== undefined) {
          pending.reject(new SessionBoxClientError("OPERATION_TIMEOUT", "agent request timed out"));
        }
      }, options.timeoutMs ?? this.requestTimeoutMs);

      const entry: PendingRequest = {
        resolve,
        reject,
        timer,
        ...(options.onStream !== undefined ? { onStream: options.onStream } : {}),
      };
      if (options.signal !== undefined) {
        const onAbort = (): void => this.sendCancel(requestId);
        options.signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, entry);

      try {
        socket.send(JSON.stringify({ ...payload, requestId, containerId: this.containerId }));
      } catch (error) {
        const pending = this.takePending(requestId);
        pending?.reject(
          new SessionBoxClientError(
            "SSH_UNAVAILABLE",
            `failed to send request: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      if (options.signal?.aborted === true) {
        this.sendCancel(requestId);
      }
    });
  }

  /** Asks the server to cancel an in-flight exec; its response settles it. */
  private sendCancel(targetRequestId: string): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== READY_STATE_OPEN) return;
    try {
      socket.send(
        JSON.stringify({
          type: "exec.cancel",
          requestId: newRequestId(),
          containerId: this.containerId,
          targetRequestId,
        }),
      );
    } catch {
      // The connection is gone; the pending request fails on close.
    }
  }

  /** Sends a one-way control frame (terminal input/resize/close). */
  private sendFrame(payload: RequestPayload): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== READY_STATE_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // The connection is gone; terminal handlers fail on close.
    }
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    return pending;
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }

    const welcome = AgentWelcomeSchema.safeParse(parsed);
    if (welcome.success && this.handshake !== null) {
      const handshake = this.handshake;
      this.handshake = null;
      handshake.resolve();
      return;
    }

    const response = AgentResponseSchema.safeParse(parsed);
    if (!response.success) return;

    const message = response.data;

    // Non-terminal frames never settle a request.
    if (message.type === "exec.stdout" || message.type === "exec.stderr") {
      this.pending.get(message.requestId)?.onStream?.(message);
      return;
    }
    if (message.type === "terminal.output" || message.type === "terminal.exit") {
      const handler = this.terminalHandlers.get(message.terminalId);
      if (message.type === "terminal.output") {
        handler?.onOutput?.(message.data);
      } else {
        this.terminalHandlers.delete(message.terminalId);
        handler?.onExit?.(message.code);
      }
      return;
    }

    const pending = this.takePending(message.requestId ?? "");
    if (pending === undefined) return;

    if (message.type === "error") {
      pending.reject(new SessionBoxClientError(message.code, message.message, message.details));
      return;
    }
    pending.resolve(message);
  }

  private onClose(): void {
    this.socket = null;
    if (this.handshake !== null) {
      const handshake = this.handshake;
      this.handshake = null;
      handshake.reject(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection closed"));
    }
    this.rejectPending(new SessionBoxClientError("SSH_UNAVAILABLE", "agent connection closed"));
    this.failTerminals(null);
  }

  private failTerminals(code: number | null): void {
    for (const handler of this.terminalHandlers.values()) {
      handler.onExit?.(code);
    }
    this.terminalHandlers.clear();
  }

  private rejectPending(error: SessionBoxClientError): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId);
      pending?.reject(error);
    }
  }
}

function unexpected(type: string): SessionBoxClientError {
  return new SessionBoxClientError("INTERNAL_ERROR", `unexpected response type "${type}"`);
}
