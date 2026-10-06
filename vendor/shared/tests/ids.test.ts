import { describe, expect, it } from "vitest";
import { newRequestId, newContainerId, newUlid, nowIso } from "../src/index.ts";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("ids", () => {
  it("generates 26-char Crockford base32 ULIDs", () => {
    const ulid = newUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(CROCKFORD);
  });

  it("prefixes container and request ids", () => {
    expect(newContainerId()).toMatch(/^ctr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newRequestId()).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is lexicographically ordered by timestamp", () => {
    const earlier = newContainerId(1_700_000_000_000);
    const later = newContainerId(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it("does not collide across many calls", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      ids.add(newContainerId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe("time", () => {
  it("formats ISO timestamps", () => {
    expect(nowIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
