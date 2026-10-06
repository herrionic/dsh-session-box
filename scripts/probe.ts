/**
 * Read-only capability probe against one live SessionBox container.
 *
 *   pnpm --filter @sessionbox/dsh-plugin exec tsx scripts/probe.ts [--container ctr_...]
 *
 * Answers the questions the DSH integration depends on: which shell/rg/node the
 * container image ships, whether a search binary can be provisioned, and
 * whether the protocol guarantees from PROTOCOL.md hold on this deployment.
 */
import process from "node:process";
import { SessionBoxClient } from "@sessionbox/client";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const baseUrl = arg("--url") ?? process.env.SESSIONBOX_URL ?? "http://127.0.0.1:8787";
const token = arg("--token") ?? process.env.SESSIONBOX_TOKEN ?? "";
const client = new SessionBoxClient({ baseUrl, ...(token === "" ? {} : { token }) });

const containers = await client.listContainers();
const wanted = arg("--container") ?? containers[0]?.id;
const container = containers.find((candidate) => candidate.id === wanted);
if (container === undefined) {
  console.error(`no container ${String(wanted)}; available: ${containers.map((c) => c.id).join(", ")}`);
  process.exit(2);
}
console.log(`container ${container.id} (${container.name}) status=${container.status} workspace=${container.workspace}`);

const runtime = await client.connect(container.id);

const census = async (label: string, command: string): Promise<void> => {
  const result = await runtime.exec(command, { timeoutMs: 30_000 });
  const text = `${result.stdout}${result.stderr}`.trim();
  console.log(`--- ${label} (exit ${String(result.exitCode)}) ---`);
  console.log(text === "" ? "(no output)" : text);
};

await census("identity", "id; uname -srm; echo PWD=$(pwd); cat /etc/os-release | head -2");
await census(
  "binaries",
  "for bin in bash sh rg grep find node npm python3 pwsh git jq tar curl wget busybox sudo apt-get; do printf '%s=%s\\n' \"$bin\" \"$(command -v $bin || echo MISSING)\"; done",
);
await census("privilege", "sudo -n true 2>&1 && echo SUDO_OK || echo SUDO_UNAVAILABLE");
await census("network", "timeout 8 curl -sSI https://deb.debian.org/debian/ 2>&1 | head -3 || echo CURL_FAILED");
await census("workspace", "ls -la /workspace; test -w /workspace && echo WORKSPACE_WRITABLE || echo WORKSPACE_READONLY");

const check = async (label: string, run: () => Promise<string>): Promise<void> => {
  try {
    console.log(`${label} -> ${await run()}`);
  } catch (error) {
    console.log(`${label} -> ERROR ${(error as { code?: string }).code ?? String(error)}`);
  }
};

await check("list /etc", async () => `${(await runtime.listFiles("/etc")).entries.length} entries`);
await check("stat /etc/hostname", async () => {
  const entry = await runtime.statFile("/etc/hostname");
  return `${entry.type} version=${entry.version ?? "(none)"}`;
});
await check("lstat /etc/alternatives/awk", async () => {
  const entry = await runtime.statFile("/etc/alternatives/awk", { follow: false });
  return `${entry.type} -> ${entry.linkTarget ?? "(no target)"}`;
});
await check("range read /etc/hostname [0,2)", async () => {
  const file = await runtime.readFile("/etc/hostname", { offset: 0, length: 2 });
  return `${JSON.stringify(file.content)} eof=${String(file.eof)}`;
});
await check("read text of binary /usr/bin/mawk", async () => {
  await runtime.readFile("/usr/bin/mawk");
  return "SUCCEEDED (expected FS_NOT_TEXT!)";
});
await check("readBytes /usr/bin/mawk (8 MiB cap)", async () => {
  const bytes = await runtime.readBytes("/usr/bin/mawk", { maxBytes: 8 * 1024 * 1024 });
  const head = Buffer.from(bytes.contentBase64, "base64").subarray(0, 4);
  return `${Buffer.from(bytes.contentBase64, "base64").length} bytes magic=${head.toString("hex")}`;
});
await check("cancel unknown exec", async () => {
  const target = await runtime.exec("sleep 30", { timeoutMs: 20_000 });
  return `unexpected result ${JSON.stringify(target)}`;
});

await runtime.close();
