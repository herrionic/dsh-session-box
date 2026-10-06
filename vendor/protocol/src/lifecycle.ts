import { z } from "zod";

/**
 * Lifecycle behaviour is configured and enforced by SessionBox, never by the
 * plugins. A plugin disconnect must not stop a container (PROJECT.md §11).
 */
export const LifecyclePolicySchema = z.strictObject({
  autoStop: z.boolean(),
  idleTimeoutSeconds: z.number().int().positive().optional(),
  maxLifetimeSeconds: z.number().int().positive().optional(),
  deleteAfterStop: z.boolean(),
});

export type LifecyclePolicy = z.infer<typeof LifecyclePolicySchema>;

/** Input form: missing keys are filled from defaults by the server. */
export const LifecyclePolicyInputSchema = z.strictObject({
  autoStop: z.boolean().optional(),
  idleTimeoutSeconds: z.number().int().positive().optional(),
  maxLifetimeSeconds: z.number().int().positive().optional(),
  deleteAfterStop: z.boolean().optional(),
});

export type LifecyclePolicyInput = z.infer<typeof LifecyclePolicyInputSchema>;

/** Patch form: `null` explicitly clears an optional timeout. */
export const LifecyclePolicyPatchSchema = z.strictObject({
  autoStop: z.boolean().optional(),
  idleTimeoutSeconds: z.number().int().positive().nullable().optional(),
  maxLifetimeSeconds: z.number().int().positive().nullable().optional(),
  deleteAfterStop: z.boolean().optional(),
});

export type LifecyclePolicyPatch = z.infer<typeof LifecyclePolicyPatchSchema>;

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  autoStop: false,
  deleteAfterStop: false,
};

export function resolveLifecyclePolicy(input?: LifecyclePolicyInput): LifecyclePolicy {
  return { ...DEFAULT_LIFECYCLE_POLICY, ...input };
}
