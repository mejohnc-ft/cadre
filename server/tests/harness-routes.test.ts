import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { createHarnessRoutes } from "../src/harness/routes";

/**
 * The managed harness's gateway: a computer asks before its harness uses a tool, the
 * deployment's boundaries answer, and every answer is a row. Fails closed on a bad token.
 */

function app(policy: { deny: string[]; allow: string[] }) {
  const rows: AuditEventInput[] = [];
  const routes = createHarnessRoutes({
    computerToken: "computer-secret",
    policy: () => ({ mode: "enforce", ...policy }),
    audit: { insert: async (event) => void rows.push(event) },
  });
  const decide = (body: Record<string, unknown>, token = "computer-secret") =>
    routes.request("http://x/harness/coder/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-computer-token": token,
        "x-openbot-run-id": "run-9",
      },
      body: JSON.stringify(body),
    });
  return { rows, decide };
}

describe("harness decide", () => {
  test("allows a permitted command and records it", async () => {
    const { rows, decide } = app({ deny: [], allow: ["true"] });
    const response = await decide({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      session_id: "s1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      reason: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "computer.action_allowed",
      targetId: "coder",
      payload: {
        action: "harness_Bash",
        command: "ls -la",
        run: "run-9",
        session: "s1",
      },
    });
  });

  test("refuses by a deny rule, naming it, and records the refusal", async () => {
    const { rows, decide } = app({
      deny: ['tool.name == "harness_Bash" && contains(command, "rm -rf")'],
      allow: ["true"],
    });
    const response = await decide({
      tool_name: "Bash",
      tool_input: { command: "rm -rf /workspace" },
    });
    const body = (await response.json()) as {
      allowed: boolean;
      reason: string;
    };
    expect(body.allowed).toBe(false);
    expect(body.reason).toContain("rm -rf");
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("file tools carry the file into the context", async () => {
    const { rows, decide } = app({
      deny: ['file.name == ".env"'],
      allow: ["true"],
    });
    const refused = await decide({
      tool_name: "Read",
      tool_input: { file_path: "/workspace/.env" },
    });
    expect(((await refused.json()) as { allowed: boolean }).allowed).toBe(
      false,
    );
    const allowed = await decide({
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/src/index.ts" },
    });
    expect(((await allowed.json()) as { allowed: boolean }).allowed).toBe(true);
    expect(rows.map((row) => row.payload.file)).toEqual([
      "/workspace/.env",
      "/workspace/src/index.ts",
    ]);
  });

  test("a missing policy permits nothing (fail closed), and a bad token is refused", async () => {
    const { decide } = app({ deny: [], allow: [] });
    const nothing = await decide({ tool_name: "Bash", tool_input: {} });
    expect(((await nothing.json()) as { allowed: boolean }).allowed).toBe(
      false,
    );
    const wrong = await decide({ tool_name: "Bash", tool_input: {} }, "nope");
    expect(wrong.status).toBe(401);
  });

  test("an unrecognisable tool name is refused", async () => {
    const { decide } = app({ deny: [], allow: ["true"] });
    const response = await decide({ tool_name: "../x", tool_input: {} });
    expect(response.status).toBe(400);
  });
});
