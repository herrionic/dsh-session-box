import { z } from "zod";

/** Runtime-neutral network name: most runtimes identify networks by name. */
export const NetworkNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "name must be network-safe (letters, digits, . _ -)");

export const NetworkSchema = z.strictObject({
  name: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  /** Public ids of the containers attached to this network. */
  containers: z.array(z.string()),
});

export type Network = z.infer<typeof NetworkSchema>;

export const CreateNetworkRequestSchema = z.strictObject({
  name: NetworkNameSchema,
});

export type CreateNetworkRequest = z.infer<typeof CreateNetworkRequestSchema>;
