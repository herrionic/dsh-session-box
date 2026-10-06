import { z } from "zod";
import { ErrorCodeSchema } from "./errors.ts";

/** Client → server terminal messages (PROJECT.md §26). */
export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("input"),
    data: z.string().max(64 * 1024),
  }),
  z.strictObject({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

/** Server → client terminal messages. */
export const TerminalServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    containerId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("output"),
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal("exit"),
    code: z.number().int().nullable(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string().min(1),
  }),
]);

export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;
