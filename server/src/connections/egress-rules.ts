/**
 * Per-connection egress rules: which requests a granted coworker may actually send.
 *
 * A grant says "this coworker may use this credential"; a rule list says what using it means. One
 * rule per line, "METHOD /path", where the path may hold `*` for one segment and `**` for any
 * tail: "GET /zones/ **" and "POST /zones/ * /dns_records" (without the spaces). `*` as the method matches every method. An
 * empty list means the base URL's whole API — the token's own scopes are then the only limit,
 * which is fine for a token minted narrow and not for an account-wide one.
 */

export type EgressRule = { method: string; pattern: string };

export function parseEgressRules(lines: string[]): EgressRule[] | null {
  const rules: EgressRule[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const match = /^([A-Za-z*]+)\s+(\/\S*)$/.exec(text);
    if (!match) return null;
    rules.push({
      method: (match[1] as string).toUpperCase(),
      pattern: match[2] as string,
    });
  }
  return rules;
}

export function requestAllowed(
  rules: EgressRule[] | null | undefined,
  method: string,
  path: string,
): boolean {
  // No rules: the connection allows its whole API. Scoping lives in the token, or here — a
  // deployment chooses per connection.
  if (!rules || rules.length === 0) return true;
  const wanted = method.toUpperCase();
  return rules.some(
    (rule) =>
      (rule.method === "*" || rule.method === wanted) &&
      pathMatches(rule.pattern, path),
  );
}

function pathMatches(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  let i = 0;
  for (; i < patternParts.length; i++) {
    const part = patternParts[i] as string;
    if (part === "**") return true;
    if (i >= pathParts.length) return false;
    if (part !== "*" && part !== pathParts[i]) return false;
  }
  return i === pathParts.length;
}
