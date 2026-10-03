import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://practice:practice@localhost:5432/practice";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_ACCESS_SECRET ??= "a".repeat(32);
process.env.REFRESH_TOKEN_PEPPER ??= "b".repeat(32);
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.PUBLIC_API_ORIGIN ??= "http://localhost:3000";
process.env.WEB_ORIGIN ??= "http://localhost:5173";

const { createShareToken, hashShareToken } = await import("../src/lib/security.js");

describe("share tokens", () => {
  it("creates a URL-safe token with a stable 64-hex hash", () => {
    const { raw, hash } = createShareToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(raw)).toBe(hash);
  });

  it("never reuses tokens and does not expose the raw value in the hash", () => {
    const first = createShareToken();
    const second = createShareToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).not.toBe(second.hash);
    expect(first.hash).not.toContain(first.raw);
  });
});
