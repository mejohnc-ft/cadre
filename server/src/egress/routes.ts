import { Hono } from "hono";
import type { ProviderStore } from "../providers/store";

/**
 * The model egress proxy: the provider key never enters a computer.
 *
 * A harness inside a computer is pointed at `/api/egress/:providerId` as its model endpoint and
 * authenticates with the computer token — a secret it already holds and which opens nothing but
 * this proxy. The proxy swaps that for the provider's real key, held encrypted in the provider
 * table and decrypted per call, forwards the request to the provider's endpoint, and streams the
 * answer back. A prompt-injected agent that dumps its environment finds no provider key to steal.
 *
 * Only POSTs to known API paths are forwarded, so the proxy is a model wire and not a general
 * tunnel: /v1/messages (anthropic shapes), /chat/completions and /v1/chat/completions,
 * /responses-shaped paths are refused until the translation lands.
 */

const ALLOWED_PATHS = [
  /^\/v1\/messages$/,
  /^\/v1\/messages\/count_tokens$/,
  /^\/chat\/completions$/,
  /^\/v1\/chat\/completions$/,
  /^\/models$/,
  /^\/v1\/models$/,
];

export function createEgressRoutes(input: {
  providers: ProviderStore;
  computerToken: string | undefined;
  fetchImpl?: typeof fetch;
}) {
  const app = new Hono();
  const doFetch = input.fetchImpl ?? fetch;

  app.all("/egress/:providerId/*", async (context) => {
    const offered =
      context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      context.req.header("x-api-key") ??
      "";
    if (!input.computerToken || offered !== input.computerToken) {
      return context.json({ error: "Not a computer." }, 401);
    }
    const providerId = context.req.param("providerId");
    const provider = await input.providers.get(providerId);
    if (!provider) return context.json({ error: "No such provider." }, 404);
    const subPath = new URL(context.req.url).pathname.replace(
      new RegExp(`^.*/egress/${providerId}`),
      "",
    );
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(subPath))) {
      return context.json(
        { error: `The egress proxy does not forward ${subPath}.` },
        404,
      );
    }
    const key = await input.providers.secretOf(providerId);
    if (!key) return context.json({ error: "The provider has no key." }, 503);

    const base = (
      provider.baseUrl ??
      (provider.kind === "anthropic"
        ? "https://api.anthropic.com"
        : "https://api.openai.com")
    ).replace(/\/$/, "");

    const headers = new Headers();
    // Only the headers a model call needs travel; everything else stays behind.
    for (const name of [
      "content-type",
      "accept",
      "anthropic-version",
      "anthropic-beta",
    ]) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }
    if (provider.kind.startsWith("anthropic") && provider.baseUrl === null) {
      headers.set("x-api-key", key);
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01");
      }
    } else {
      headers.set("authorization", `Bearer ${key}`);
    }

    let upstream: Response;
    try {
      upstream = await doFetch(`${base}${subPath}`, {
        method: context.req.method,
        headers,
        body:
          context.req.method === "GET" || context.req.method === "HEAD"
            ? undefined
            : await context.req.arrayBuffer(),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      return context.json(
        {
          error: `The provider could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        },
        502,
      );
    }
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

  return app;
}
