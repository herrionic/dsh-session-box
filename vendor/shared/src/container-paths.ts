import path from "node:path";

export const DEFAULT_CONTAINER_ROOT = "/workspace";

/**
 * Maps a path the harness tool layer received (a host path) to the equivalent
 * path inside the container.
 *
 * Rules, in order:
 * 1. Paths already under the container root (`/workspace/...`) pass through, so
 *    a session can address the container explicitly on any host.
 * 2. On Windows hosts, POSIX-absolute paths (e.g. `/tmp/x`) pass through: the
 *    host cannot mean them literally.
 * 3. Host paths inside the session cwd map to `<containerRoot>/<relative>`.
 * 4. Everything else is rejected: silently mapping an unrelated host path into
 *    the container would hide a mistake.
 */
export function toContainerPath(
  input: string,
  hostCwd: string,
  containerRoot: string = DEFAULT_CONTAINER_ROOT,
): string {
  if (input === "") {
    throw new Error("path must not be empty");
  }

  const root = containerRoot.replace(/\/+$/, "") || "/";

  if (input === root || input.startsWith(`${root}/`)) {
    return input;
  }

  if (process.platform === "win32" && input.startsWith("/")) {
    return input;
  }

  const host = path.resolve(input);
  const cwd = path.resolve(hostCwd);
  const relative = path.relative(cwd, host);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!inside) {
    throw new Error(
      `path is outside the session workspace (${hostCwd}) and is not a container path: ${input}`,
    );
  }

  const posixRelative = relative.split(path.sep).filter((segment) => segment !== "").join("/");
  return posixRelative === "" ? root : `${root}/${posixRelative}`;
}

/**
 * The inverse of {@link toContainerPath} for display purposes: turns a container
 * path back into the host path the model used, so tool output stays consistent
 * with the session cwd. Returns undefined when the path is outside the root.
 */
export function fromContainerPath(
  containerPath: string,
  hostCwd: string,
  containerRoot: string = DEFAULT_CONTAINER_ROOT,
): string | undefined {
  const root = containerRoot.replace(/\/+$/, "") || "/";
  if (containerPath !== root && !containerPath.startsWith(`${root}/`)) {
    return undefined;
  }

  const relative = containerPath.slice(root.length).replace(/^\/+/, "");
  if (relative === "") return path.resolve(hostCwd);

  const segments = relative.split("/");
  return path.join(path.resolve(hostCwd), ...segments);
}
