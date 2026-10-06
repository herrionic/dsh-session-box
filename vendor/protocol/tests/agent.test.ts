import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AgentHelloSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  AgentWelcomeSchema,
} from "../src/index.ts";

describe("agent handshake", () => {
  it("speaks protocol version 2", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(2);
    expect(AgentHelloSchema.parse({ type: "hello", protocolVersion: 1 })).toMatchObject({
      type: "hello",
    });
    expect(AgentWelcomeSchema.parse({ type: "welcome", protocolVersion: 1 })).toMatchObject({
      type: "welcome",
    });
  });

  it("rejects unknown handshake fields", () => {
    expect(
      AgentHelloSchema.safeParse({ type: "hello", protocolVersion: 1, bogus: true }).success,
    ).toBe(false);
  });
});

describe("agent requests", () => {
  it("accepts every required operation", () => {
    const requests = [
      { type: "exec", requestId: "r1", containerId: "ctr_1", command: "ls" },
      {
        type: "exec.cancel",
        requestId: "r1b",
        containerId: "ctr_1",
        targetRequestId: "r1",
      },
      { type: "file.read", requestId: "r2", containerId: "ctr_1", path: "/workspace/a.txt" },
      {
        type: "file.read",
        requestId: "r2r",
        containerId: "ctr_1",
        path: "/workspace/a.txt",
        offset: 10,
        length: 20,
      },
      {
        type: "file.readBytes",
        requestId: "r2b",
        containerId: "ctr_1",
        path: "/workspace/a.bin",
        maxBytes: 4096,
      },
      {
        type: "file.write",
        requestId: "r3",
        containerId: "ctr_1",
        path: "/workspace/a.txt",
        content: "hi",
        expected: { version: "1000:2" },
      },
      {
        type: "file.rename",
        requestId: "r3b",
        containerId: "ctr_1",
        from: "/workspace/a.txt",
        to: "/workspace/b.txt",
      },
      {
        type: "file.chmod",
        requestId: "r3c",
        containerId: "ctr_1",
        path: "/workspace/a.txt",
        mode: 0o644,
      },
      {
        type: "file.symlink",
        requestId: "r3d",
        containerId: "ctr_1",
        path: "/workspace/link",
        target: "/workspace/a.txt",
      },
      { type: "file.list", requestId: "r4", containerId: "ctr_1", path: "/workspace" },
      {
        type: "file.stat",
        requestId: "r5",
        containerId: "ctr_1",
        path: "/workspace/a.txt",
        follow: false,
      },
      { type: "file.mkdir", requestId: "r6", containerId: "ctr_1", path: "/workspace/x" },
      { type: "file.remove", requestId: "r7", containerId: "ctr_1", path: "/workspace/x" },
      { type: "terminal.open", requestId: "r8", containerId: "ctr_1", cols: 80, rows: 24 },
      { type: "terminal.input", terminalId: "term_x", data: "ls\r" },
      { type: "terminal.resize", terminalId: "term_x", cols: 100, rows: 30 },
      { type: "terminal.close", terminalId: "term_x" },
    ];

    for (const request of requests) {
      expect(AgentRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("rejects malformed requests", () => {
    expect(AgentRequestSchema.safeParse({ type: "exec", requestId: "r1", containerId: "s" }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ type: "unknown", requestId: "r1", containerId: "s" }).success).toBe(false);
    expect(
      AgentRequestSchema.safeParse({
        type: "exec",
        requestId: "r1",
        containerId: "s",
        command: "ls",
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe("agent responses", () => {
  it("accepts results and errors", () => {
    expect(
      AgentResponseSchema.safeParse({
        requestId: "r1",
        type: "exec.result",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        requestId: "r1b",
        type: "exec.cancel.result",
        targetRequestId: "r1",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        requestId: "r1",
        type: "exec.stdout",
        data: "partial",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        requestId: "r2",
        type: "file.read.result",
        file: {
          path: "/workspace/a.txt",
          content: "hi",
          size: 2,
          modifiedAt: 1000,
          version: "1000:2",
          offset: 0,
          length: 2,
          eof: true,
        },
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        requestId: "r2b",
        type: "file.readBytes.result",
        file: {
          path: "/workspace/a.bin",
          contentBase64: "AAEC",
          size: 3,
          modifiedAt: 1000,
          version: "1000:3",
        },
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        requestId: "r8",
        type: "terminal.opened",
        terminalId: "term_x",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        type: "terminal.output",
        terminalId: "term_x",
        data: "hi\r\n",
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        type: "terminal.exit",
        terminalId: "term_x",
        code: 0,
      }).success,
    ).toBe(true);

    expect(
      AgentResponseSchema.safeParse({
        type: "error",
        code: "CONTAINER_NOT_FOUND",
        message: "container was not found",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown response types", () => {
    expect(
      AgentResponseSchema.safeParse({ requestId: "r1", type: "exec.done", exitCode: 0 }).success,
    ).toBe(false);
  });
});
