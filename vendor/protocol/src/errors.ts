import { z } from "zod";

/**
 * Stable public error codes. These never change shape over the wire;
 * detailed internal errors stay in server logs.
 */
export const ErrorCodeSchema = z.enum([
  "CONTAINER_NOT_FOUND",
  "CONTAINER_NOT_RUNNING",
  "CONTAINER_CREATE_FAILED",
  "SSH_UNAVAILABLE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "INVALID_STATE",
  "OPERATION_TIMEOUT",
  "OPERATION_CANCELLED",
  "FS_NOT_TEXT",
  "FS_TOO_LARGE",
  "FS_IS_DIRECTORY",
  "FS_NOT_REGULAR_FILE",
  "FS_PERMISSION_DENIED",
  "VERSION_CONFLICT",
  "RUNTIME_ERROR",
  "INTERNAL_ERROR",
  "NOT_FOUND",
]);

export type SessionBoxErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string().min(1),
  runtime: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
