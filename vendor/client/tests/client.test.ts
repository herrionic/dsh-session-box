import { describe, expect, it, vi } from "vitest";
import { SessionBoxClient } from "../src/client.ts";
import { SessionBoxClientError } from "../src/errors.ts";
import { ContainerRuntime } from "../src/runtime.ts";
import type { WebSocketLike, WebSocketListener, WebSocketMessageEvent } from "../src/websocket.ts";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, WebSocketListener[]>();

  addEventListener(type: "open" | "message" | "close" | "error", listener: WebSocketListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", { data: undefined });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", { data: undefined });
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: WebSocketMessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createRuntime(options: { requestTimeoutMs?: number } = {}): {
  runtime: ContainerRuntime;
  socket: FakeWebSocket;
} {
  const socket = new FakeWebSocket();
  const runtime = new ContainerRuntime({
    containerId: "ctr_test",
    url: "ws://example/api/ws/agent",
    webSocketFactory: () => socket,
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
  return { runtime, socket };
}

async function connect(runtime: ContainerRuntime, socket: FakeWebSocket): Promise<void> {
  const connecting = runtime.connect();
  socket.open();
  // Let connect() attach its message listener before the welcome arrives.
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.receive({ type: "welcome", protocolVersion: 2 });
  await connecting;
}

describe("ContainerRuntime", () => {
  it("performs the hello/welcome handshake", async () => {
    const { runtime, socket } = createRuntime();
    await connect(runtime, socket);

    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "hello",
      protocolVersion: 2,
      client: "sessionbox-client",
    });
    await runtime.close();
  });

  it("correlates responses by requestId", async () => {
    const { runtime, socket } = createRuntime();
    await connect(runtime, socket);

    const pending = runtime.exec("uname -a");
    const request = JSON.parse(socket.sent[1] ?? "{}") as { requestId: string; containerId: string };
    expect(request.containerId).toBe("ctr_test");
    expect(request).toMatchObject({ type: "exec", command: "uname -a" });

    socket.receive({
      requestId: request.requestId,
      type: "exec.result",
      exitCode: 0,
      stdout: "Linux\n",
      stderr: "",
    });

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "Linux\n", stderr: "" });
    await runtime.close();
  });

  it("surfaces server errors with their stable code", async () => {
    const { runtime, socket } = createRuntime();
    await connect(runtime, socket);

    const pending = runtime.readFile("/workspace/missing.txt");
    const request = JSON.parse(socket.sent[1] ?? "{}") as { requestId: string };

    socket.receive({
      requestId: request.requestId,
      type: "error",
      code: "NOT_FOUND",
      message: "the path was not found in the container",
    });

    await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
    await runtime.close();
  });

  it("times out unanswered requests", async () => {
    const { runtime, socket } = createRuntime({ requestTimeoutMs: 20 });
    await connect(runtime, socket);

    await expect(runtime.listFiles("/workspace")).rejects.toMatchObject({
      code: "OPERATION_TIMEOUT",
    });
    await runtime.close();
  });

  it("rejects in-flight requests when the connection closes", async () => {
    const { runtime, socket } = createRuntime();
    await connect(runtime, socket);

    const pending = runtime.exec("sleep 1");
    socket.close();

    await expect(pending).rejects.toBeInstanceOf(SessionBoxClientError);
    await expect(pending).rejects.toMatchObject({ code: "SSH_UNAVAILABLE" });
  });
});

describe("SessionBoxClient", () => {
  it("sends bearer tokens and builds REST URLs", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new SessionBoxClient({
      baseUrl: "http://box:8787/",
      token: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.listContainers()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://box:8787/api/containers",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
  });

  it("maps server error payloads to client errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "CONTAINER_NOT_FOUND", message: "container ctr_1 was not found" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new SessionBoxClient({
      baseUrl: "http://box:8787",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getContainer("ctr_1")).rejects.toMatchObject({
      code: "CONTAINER_NOT_FOUND",
      message: "container ctr_1 was not found",
    });
  });

  it("derives the agent WebSocket URL from the base URL", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionBoxClient({
      baseUrl: "https://box:8787",
      webSocketFactory: (url) => {
        expect(url).toBe("wss://box:8787/api/ws/agent");
        return socket;
      },
    });

    const connecting = client.connect("ctr_test");
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({ type: "welcome", protocolVersion: 2 });

    const runtime = await connecting;
    expect(runtime).toBeInstanceOf(ContainerRuntime);
    await runtime.close();
  });

  it("carries the token on the agent WebSocket URL when configured", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionBoxClient({
      baseUrl: "https://box:8787",
      token: "secret-token",
      webSocketFactory: (url) => {
        expect(url).toBe("wss://box:8787/api/ws/agent?token=secret-token");
        return socket;
      },
    });

    const connecting = client.connect("ctr_test");
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({ type: "welcome", protocolVersion: 2 });

    const runtime = await connecting;
    await runtime.close();
  });
});
