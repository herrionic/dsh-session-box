/**
 * Types for the browser half.
 *
 * The client module registry reads its bundle bytes, never these declarations;
 * they exist so a TypeScript consumer importing `@sessionbox/dsh-plugin/client`
 * resolves the subpath instead of failing on a missing file.
 */
export {}
