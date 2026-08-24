import { describe, expect, test } from "bun:test";
import { totpCode } from "../src/connections/totp";

/**
 * RFC 6238 Appendix B test vectors, SHA-1 rows, truncated to the usual six digits. The appendix
 * lists eight-digit codes; the last six of each are what a six-digit computation yields.
 */

// "12345678901234567890" in base32.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  test("rfc 6238 vectors", async () => {
    expect(await totpCode(SEED, new Date(59 * 1000))).toBe("287082");
    expect(await totpCode(SEED, new Date(1111111109 * 1000))).toBe("081804");
    expect(await totpCode(SEED, new Date(1234567890 * 1000))).toBe("005924");
    expect(await totpCode(SEED, new Date(20000000000 * 1000))).toBe("353130");
  });

  test("spaces and case in the seed are tolerated", async () => {
    expect(
      await totpCode(
        "gezd gnbv gy3t qojq gezd gnbv gy3t qojq",
        new Date(59000),
      ),
    ).toBe("287082");
  });
});
