import { z } from "zod";
import { NetworkNameSchema } from "./network.ts";

export const ContainerStatusSchema = z.enum([
  "creating",
  "running",
  "stopped",
  "failed",
  "deleting",
]);

export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;

export const ContainerResourcesSchema = z.strictObject({
  /** CPU limit in cores, e.g. 0.5 or 2 */
  cpuLimit: z.number().positive().max(128).optional(),
  memoryLimitMb: z.number().int().positive().max(1_048_576).optional(),
  pidsLimit: z.number().int().positive().max(100_000).optional(),
});

export type ContainerResources = z.infer<typeof ContainerResourcesSchema>;

export const ContainerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "name must be docker-safe (letters, digits, . _ -)");

/**
 * Public container model. Runtime-neutral by design: no container IDs, no IPs,
 * no SSH details (PROJECT.md §10).
 */
export const ContainerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  image: z.string().min(1),
  runtime: z.string().min(1),
  status: ContainerStatusSchema,
  workspace: z.string().min(1),
  /** Networks this container is attached to (the default one included). */
  networks: z.array(z.string()),
  resources: ContainerResourcesSchema,
  lifecycle: z.object({
    autoStop: z.boolean(),
    idleTimeoutSeconds: z.number().int().positive().optional(),
    maxLifetimeSeconds: z.number().int().positive().optional(),
    deleteAfterStop: z.boolean(),
  }),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  stoppedAt: z.string().min(1).optional(),
  lastActivityAt: z.string().min(1).optional(),
  activeConnections: z.number().int().nonnegative(),
});

export type Container = z.infer<typeof ContainerSchema>;

export const CreateContainerRequestSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  image: z.string().min(1).optional(),
  resources: ContainerResourcesSchema.optional(),
  /** Extra shared networks to attach in addition to the default network. */
  networks: z.array(NetworkNameSchema).max(8).optional(),
  lifecycle: z
    .strictObject({
      autoStop: z.boolean().optional(),
      idleTimeoutSeconds: z.number().int().positive().optional(),
      maxLifetimeSeconds: z.number().int().positive().optional(),
      deleteAfterStop: z.boolean().optional(),
    })
    .optional(),
});

export type CreateContainerRequest = z.infer<typeof CreateContainerRequestSchema>;

export const UpdateContainerSettingsRequestSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  lifecycle: z
    .strictObject({
      autoStop: z.boolean().optional(),
      idleTimeoutSeconds: z.number().int().positive().nullable().optional(),
      maxLifetimeSeconds: z.number().int().positive().nullable().optional(),
      deleteAfterStop: z.boolean().optional(),
    })
    .optional(),
});

export type UpdateContainerSettingsRequest = z.infer<typeof UpdateContainerSettingsRequestSchema>;
