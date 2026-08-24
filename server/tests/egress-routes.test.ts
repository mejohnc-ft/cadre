import { describe, expect, test } from "bun:test";
import { createEgressRoutes } from "../src/egress/routes";
import type { ProviderStore } from "../src/providers/store";

/**
 * The egress proxy: the computer token opens it, the provider's real key is injected on the way
 * out and never sent to the computer, only model paths are forwarded, and a bad token is refused.
 */

function fakeStore(): ProviderStore {
  return {
    get: async (id: string) =>
      id === "zai"
        ? {
            id: "zai",
            name: "Z",
            kind: "openai-compatible",
            baseUrl: "https://upstream.test/v1",
            defaultModel: "m",
            isDefault: true,
            updatedAt: "",
          }
        : null,
    secretOf: async (id: string) => (id === "zai" ? "REAL-PROVIDER-KEY" : null),
  } as unknown as ProviderStore;
}

function app(seen: { url?: string; auth?: string; body?: string }) {
  return createEgressRoutes({
    providers: fakeStore(),
    computerToken: "computer-secret",
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
      seen.body = init?.body
        ? new TextDecoder().decode(init.body as ArrayBuffer)
        : "";
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
}

describe("egress proxy", () => {
  test("forwards a chat completion, injecting the provider key, keeping the computer token off the wire", async () => {
    const seen: { url?: string; auth?: string; body?: string } = {};
    const response = await app(seen).request(
      "http://x/egress/zai/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer computer-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "m", messages: [] }),
      },
    );
    expect(response.status).toBe(200);
    expect(seen.url).toBe("https://upstream.test/v1/chat/completions");
    expect(seen.auth).toBe("Bearer REAL-PROVIDER-KEY");
    expect(seen.auth).not.toContain("computer-secret");
    expect(seen.body).toContain('"model":"m"');
  });

  test("refuses a bad computer token", async () => {
    const response = await app({}).request(
      "http://x/egress/zai/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
  });

  test("refuses a path that is not a model API", async () => {
    const response = await app({}).request("http://x/egress/zai/etc/passwd", {
      method: "POST",
      headers: { authorization: "Bearer computer-secret" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  test("unknown provider is a 404", async () => {
    const response = await app({}).request(
      "http://x/egress/nope/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer computer-secret" },
        body: "{}",
      },
    );
    expect(response.status).toBe(404);
  });
});
