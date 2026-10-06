import { describe, expect, it } from "vitest";
import {
  CreateContainerRequestSchema,
  ErrorResponseSchema,
  LifecyclePolicyPatchSchema,
  ContainerSchema,
  resolveLifecyclePolicy,
} from "../src/index.ts";

describe("lifecycle policy", () => {
  it("resolves defaults", () => {
    expect(resolveLifecyclePolicy()).toEqual({ autoStop: false, deleteAfterStop: false });
  });

  it("lets input override defaults", () => {
    expect(resolveLifecyclePolicy({ autoStop: true, idleTimeoutSeconds: 300 })).toEqual({
      autoStop: true,
      idleTimeoutSeconds: 300,
      deleteAfterStop: false,
    });
  });

  it("supports clearing timeouts with null in a patch", () => {
    const patch = LifecyclePolicyPatchSchema.parse({ idleTimeoutSeconds: null });
    expect(patch.idleTimeoutSeconds).toBeNull();
  });
});

describe("container requests", () => {
  it("accepts an empty create request", () => {
    expect(CreateContainerRequestSchema.parse({})).toEqual({});
  });

  it("rejects unknown fields", () => {
    expect(CreateContainerRequestSchema.safeParse({ image: "x", bogus: 1 }).success).toBe(false);
  });

  it("rejects invalid resource limits", () => {
    const result = CreateContainerRequestSchema.safeParse({
      resources: { memoryLimitMb: -5 },
    });
    expect(result.success).toBe(false);
  });
});

describe("public container model", () => {
  const valid = {
    id: "ctr_01ABC",
    name: "agent-workspace",
    image: "sessionbox/base:latest",
    runtime: "docker",
    status: "running",
    workspace: "/workspace",
    networks: [],
    resources: {},
    lifecycle: { autoStop: false, deleteAfterStop: false },
    createdAt: "2026-10-01T00:00:00.000Z",
    activeConnections: 0,
  };

  it("parses a valid container", () => {
    expect(ContainerSchema.parse(valid).id).toBe("ctr_01ABC");
  });

  it("rejects unknown runtime internals such as containerId", () => {
    expect(ContainerSchema.safeParse({ ...valid, containerId: "abc" }).success).toBe(false);
  });

  it("rejects unknown statuses", () => {
    expect(ContainerSchema.safeParse({ ...valid, status: "zombie" }).success).toBe(false);
  });
});

describe("error response", () => {
  it("parses a stable error payload", () => {
    const parsed = ErrorResponseSchema.parse({
      error: { code: "CONTAINER_NOT_FOUND", message: "container was not found" },
    });
    expect(parsed.error.code).toBe("CONTAINER_NOT_FOUND");
  });
});
