import { z } from "zod";

export const FileEntryTypeSchema = z.enum(["file", "directory", "symlink", "other"]);
export type FileEntryType = z.infer<typeof FileEntryTypeSchema>;

export const FileEntrySchema = z.strictObject({
  name: z.string(),
  path: z.string().min(1),
  type: FileEntryTypeSchema,
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  /** Epoch milliseconds. */
  modifiedAt: z.number().int().nonnegative(),
  /**
   * Opaque optimistic-concurrency version:
   * `<ino>:<size>:<mtimeNs>:<ctimeNs>`, from container metadata only (never
   * file content), so every surface reports the same value without needing
   * read permission.
   */
  version: z.string().min(1),
  /** Symlink target; present only when the entry was observed without following. */
  linkTarget: z.string().optional(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResponseSchema = z.strictObject({
  path: z.string().min(1),
  entries: z.array(FileEntrySchema),
});

export type FileListResponse = z.infer<typeof FileListResponseSchema>;

export const FileMetadataSchema = z.strictObject({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  version: z.string().min(1),
});

export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const FileContentSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  version: z.string().min(1),
  /** 0-based byte offset of the returned range. */
  offset: z.number().int().nonnegative(),
  /** Byte length of the returned range. */
  length: z.number().int().nonnegative(),
  /** Whether the returned range reaches the end of the file. */
  eof: z.boolean(),
});

export type FileContent = z.infer<typeof FileContentSchema>;

/** Binary-safe file payload (base64); the companion of `FileContent`. */
export const FileBytesSchema = z.strictObject({
  path: z.string().min(1),
  contentBase64: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  version: z.string().min(1),
});

export type FileBytes = z.infer<typeof FileBytesSchema>;

export const WriteFileRequestSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export const CreateFileRequestSchema = z.strictObject({
  path: z.string().min(1),
  type: z.enum(["file", "directory"]),
});

export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>;

/**
 * Limits shared by the server and the web UI. Text editing is intentionally
 * bounded; larger payloads go through upload/download (PROJECT.md §42:
 * oversized file requests must be rejected).
 */
export const FILE_LIMITS = {
  maxTextFileBytes: 1024 * 1024,
  maxUploadBytes: 16 * 1024 * 1024,
} as const;
