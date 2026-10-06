/** Minimal WebSocket surface the client needs; keeps the package environment-agnostic. */
export interface WebSocketMessageEvent {
  data: unknown;
}

export type WebSocketListener = (event: WebSocketMessageEvent) => void;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: WebSocketListener): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const READY_STATE_OPEN = 1;

/**
 * Uses the runtime's global WebSocket (Node 22+, browsers). Plugins can pass
 * their own factory when the harness provides a different implementation.
 */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (ctor === undefined) {
    throw new Error(
      "no global WebSocket implementation is available; pass webSocketFactory to SessionBoxClient",
    );
  }
  return new ctor(url) as unknown as WebSocketLike;
};
