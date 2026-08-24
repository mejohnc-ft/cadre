import { describe, expect, test } from "bun:test";
import {
  parseEgressRules,
  requestAllowed,
} from "../src/connections/egress-rules";

describe("egress rules", () => {
  test("no rules allows everything", () => {
    expect(requestAllowed(null, "POST", "/anything")).toBe(true);
    expect(requestAllowed([], "DELETE", "/zones/1")).toBe(true);
  });

  test("method and exact path", () => {
    const rules = parseEgressRules(["GET /user/tokens/verify"]);
    expect(requestAllowed(rules, "GET", "/user/tokens/verify")).toBe(true);
    expect(requestAllowed(rules, "POST", "/user/tokens/verify")).toBe(false);
    expect(requestAllowed(rules, "GET", "/user/tokens")).toBe(false);
  });

  test("one-segment and tail wildcards", () => {
    const rules = parseEgressRules([
      "POST /zones/*/dns_records",
      "GET /zones/**",
    ]);
    expect(requestAllowed(rules, "POST", "/zones/abc123/dns_records")).toBe(
      true,
    );
    expect(
      requestAllowed(rules, "POST", "/zones/abc123/dns_records/extra"),
    ).toBe(false);
    expect(requestAllowed(rules, "GET", "/zones/abc123/dns_records/r1")).toBe(
      true,
    );
    expect(requestAllowed(rules, "DELETE", "/zones/abc123")).toBe(false);
  });

  test("any-method wildcard", () => {
    const rules = parseEgressRules(["* /sites/mysite/**"]);
    expect(requestAllowed(rules, "PUT", "/sites/mysite/deploys")).toBe(true);
    expect(requestAllowed(rules, "PUT", "/sites/other/deploys")).toBe(false);
  });

  test("malformed lines refuse to parse", () => {
    expect(parseEgressRules(["GET"])).toBe(null);
    expect(parseEgressRules(["GET nothing-absolute"])).toBe(null);
    expect(parseEgressRules(["", "  ", "GET /ok"])).toEqual([
      { method: "GET", pattern: "/ok" },
    ]);
  });
});
