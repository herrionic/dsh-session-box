import { z } from "zod";
import { ErrorCodeSchema } from "./errors.ts";
import {
  FileBytesSchema,
  FileContentSchema,
  FileEntrySchema,
  FileMetadataSchema,
} from "./files.ts";

/** MVP protocol version (PROJECT.md §40). */
export const AGENT_PROTOCOL_VERSION = 2;

/** Client → server handshake. */
export const AgentHelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  client: z.string().min(1).max(128).optional(),
});

export type AgentHello = z.infer<typeof AgentHelloSchema>;

/** Server → client handshake response. */
export const AgentWelcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
});

export type AgentWelcome = z.infer<typeof AgentWelcomeSchema>;

const requestBase = {
  requestId: z.string().min(1).max(128),
  containerId: z.string().min(1).max(128),
};

const pathSchema = z.string().min(1).max(4096);
const terminalIdSchema = z.string().min(1).max(128);

/**
 * Absolute wire caps for `exec`; a deployment can enforce lower limits
 * (PROJECT.md: large heredocs are legitimate payloads).
 */
export const MAX_EXEC_COMMAND_BYTES = 4 * 1024 * 1024;
export const MAX_EXEC_TIMEOUT_MS = 4 * 60 * 60_000;

/**
 * Client → server messages. Most are requests answered by exactly one
 * terminal response; `terminal.input` / `terminal.resize` / `terminal.close`
 * are one-way control frames (no response).
 */
export const AgentRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...requestBase,
    type: z.literal("exec"),
    command: z.string().min(1).max(MAX_EXEC_COMMAND_BYTES),
    cwd: pathSchema.optional(),
    timeoutMs: z.number().int().positive().max(MAX_EXEC_TIMEOUT_MS).optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("exec.cancel"),
    /** The `requestId` of an in-flight `exec` on the same connection. */
    targetRequestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.read"),
    path: pathSchema,
    /** 0-based byte offset; omit for a full read. */
    offset: z.number().int().nonnegative().optional(),
    /** Maximum bytes to return; omit to read to the end of the file. */
    length: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.readBytes"),
    path: pathSchema,
    /** Reject files larger than this (capped at the 8 MiB protocol limit). */
    maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.write"),
    path: pathSchema,
    content: z.string().max(8 * 1024 * 1024),
    /** Optimistic guard: fails with VERSION_CONFLICT unless it matches. */
    expected: z.strictObject({ version: z.string().min(1).max(256) }).optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.rename"),
    from: pathSchema,
    to: pathSchema,
    /** Defaults to true (POSIX rename semantics). */
    overwrite: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.chmod"),
    path: pathSchema,
    /** Permission bits (e.g. 0o644). */
    mode: z.number().int().min(0).max(0o7777),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.symlink"),
    path: pathSchema,
    target: pathSchema,
  }),
  z.strictObject({ ...requestBase, type: z.literal("file.list"), path: pathSchema }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.stat"),
    path: pathSchema,
    /** `false` behaves like lstat (default true, follows links). */
    follow: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.mkdir"),
    path: pathSchema,
    recursive: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("file.remove"),
    path: pathSchema,
    recursive: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("terminal.open"),
    term: z.string().min(1).max(64).optional(),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
  }),
  z.strictObject({
    type: z.literal("terminal.input"),
    terminalId: terminalIdSchema,
    data: z.string().max(64 * 1024),
  }),
  z.strictObject({
    type: z.literal("terminal.resize"),
    terminalId: terminalIdSchema,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
  }),
  z.strictObject({ type: z.literal("terminal.close"), terminalId: terminalIdSchema }),
]);

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentRequestType = AgentRequest["type"];

const responseBase = {
  requestId: z.string().min(1).max(128),
};

/** Server → client messages: one terminal response per request plus events. */
export const AgentResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...responseBase,
    type: z.literal("exec.result"),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({ ...responseBase, type: z.literal("exec.stdout"), data: z.string() }),
  z.strictObject({ ...responseBase, type: z.literal("exec.stderr"), data: z.string() }),
  z.strictObject({
    ...responseBase,
    type: z.literal("exec.cancel.result"),
    targetRequestId: z.string().min(1).max(128),
  }),
  z.strictObject({ ...responseBase, type: z.literal("file.read.result"), file: FileContentSchema }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.readBytes.result"),
    file: FileBytesSchema,
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.write.result"),
    file: FileMetadataSchema,
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.rename.result"),
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.chmod.result"),
    path: z.string().min(1),
    mode: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.symlink.result"),
    path: z.string().min(1),
    target: z.string().min(1),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("file.list.result"),
    path: z.string().min(1),
    entries: z.array(FileEntrySchema),
  }),
  z.strictObject({ ...responseBase, type: z.literal("file.stat.result"), entry: FileEntrySchema }),
  z.strictObject({ ...responseBase, type: z.literal("file.mkdir.result"), path: z.string().min(1) }),
  z.strictObject({ ...responseBase, type: z.literal("file.remove.result"), path: z.string().min(1) }),
  z.strictObject({
    ...responseBase,
    type: z.literal("terminal.opened"),
    terminalId: terminalIdSchema,
  }),
  z.strictObject({
    type: z.literal("terminal.output"),
    terminalId: terminalIdSchema,
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal("terminal.exit"),
    terminalId: terminalIdSchema,
    code: z.number().int().nullable(),
  }),
  // Protocol-level errors (malformed handshake, unknown request) may not have
  // a requestId to echo.
  z.strictObject({
    type: z.literal("error"),
    requestId: z.string().min(1).max(128).optional(),
    code: ErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
]);

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
