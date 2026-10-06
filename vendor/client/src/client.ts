import type {
  CreateContainerRequest,
  ErrorResponse,
  HealthResponse,
  Container,
  UpdateContainerSettingsRequest,
} from "@sessionbox/protocol";
import { SessionBoxClientError } from "./errors.ts";
import { ContainerRuntime } from "./runtime.ts";
import { defaultWebSocketFactory, type WebSocketFactory } from "./websocket.ts";

export interface SessionBoxClientOptions {
  /** Server base URL, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Bearer token for plugin authentication (enforced from Day 6). */
  token?: string;
  /** Injectable for tests and non-standard runtimes. */
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  requestTimeoutMs?: number;
}

/**
 * Shared client for harness adapters (PROJECT.md §31). Harness-specific code
 * stays outside; this class only speaks the public SessionBox API.
 */
export class SessionBoxClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly requestTimeoutMs: number;

  constructor(options: SessionBoxClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (baseUrl === "") {
      throw new SessionBoxClientError("INVALID_REQUEST", "baseUrl must not be empty");
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async health(): Promise<HealthResponse> {
    return await this.request("/api/health");
  }

  async listContainers(): Promise<Container[]> {
    return await this.request("/api/containers");
  }

  async createContainer(input: CreateContainerRequest = {}): Promise<Container> {
    return await this.request("/api/containers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getContainer(id: string): Promise<Container> {
    return await this.request(`/api/containers/${encodeURIComponent(id)}`);
  }

  async startContainer(id: string): Promise<Container> {
    return await this.request(`/api/containers/${encodeURIComponent(id)}/start`, { method: "POST" });
  }

  async stopContainer(id: string): Promise<Container> {
    return await this.request(`/api/containers/${encodeURIComponent(id)}/stop`, { method: "POST" });
  }

  async restartContainer(id: string): Promise<Container> {
    return await this.request(`/api/containers/${encodeURIComponent(id)}/restart`, {
      method: "POST",
    });
  }

  async deleteContainer(id: string): Promise<void> {
    await this.request(`/api/containers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async updateContainerSettings(id: string, patch: UpdateContainerSettingsRequest): Promise<Container> {
    return await this.request(`/api/containers/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Opens an agent-protocol connection to a container. */
  async connect(containerId: string): Promise<ContainerRuntime> {
    const runtime = new ContainerRuntime({
      containerId,
      url: this.agentUrl(),
      webSocketFactory: this.webSocketFactory,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    await runtime.connect();
    return runtime;
  }

  private agentUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/ws/agent";
    url.search = "";
    url.hash = "";
    // The agent WebSocket cannot set headers; the token travels in the query
    // and is stripped by the server before route validation.
    if (this.token !== undefined) {
      url.searchParams.set("token", this.token);
    }
    return url.toString();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.token !== undefined) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body as ErrorResponse | undefined)?.error;
      throw new SessionBoxClientError(
        error?.code ?? "INTERNAL_ERROR",
        error?.message ?? response.statusText,
      );
    }

    return body as T;
  }
}
