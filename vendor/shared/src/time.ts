export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}
