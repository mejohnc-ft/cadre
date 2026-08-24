import { Hono } from "hono";
import { parseEgressRules, requestAllowed } from "../connections/egress-rules";
import type { ConnectionStore } from "../connections/store";
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
  /** The connections vault; absent, the connection egress answers 404. */
  connections?: ConnectionStore;
  fetchImpl?: typeof fetch;
}) {
  const app = new Hono();
  const doFetch = input.fetchImpl ?? fetch;

  /**
   * API-connection egress: `/egress/conn/:botId/:connectionId/<path>` forwards to the
   * connection's base URL with its token injected as a bearer. The same shape as the model
   * egress — the computer authenticates with its token, the secret never enters it — plus a
   * grant check, because a model call is what a computer is for and a Netlify deploy is not.
   */
  app.all("/egress/conn/:botId/:connectionId/*", async (context) => {
    const offered =
      context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      context.req.header("x-api-key") ??
      "";
    if (!input.computerToken || offered !== input.computerToken) {
      return context.json({ error: "Not a computer." }, 401);
    }
    const vault = input.connections;
    if (!vault) return context.json({ error: "No connections vault." }, 404);
    const botId = context.req.param("botId");
    const connectionId = context.req.param("connectionId");
    const connection = await vault.get(connectionId);
    if (!connection || connection.kind !== "api") {
      return context.json({ error: "No such connection." }, 404);
    }
    if (!connection.baseUrl) {
      return context.json({ error: "The connection has no base URL." }, 503);
    }
    if (!(await vault.allowed(connectionId, botId))) {
      return context.json(
        {
          error: `No grant: an administrator has not allowed ${botId} to use ${connectionId}.`,
        },
        403,
      );
    }
    const subPath = new URL(context.req.url).pathname.replace(
      new RegExp(`^.*/egress/conn/${botId}/${connectionId}`),
      "",
    );
    const rules = parseEgressRules(connection.allowedPaths ?? []);
    if (!requestAllowed(rules, context.req.method, subPath)) {
      return context.json(
        {
          error: `The connection ${connectionId} does not allow ${context.req.method} ${subPath}.`,
        },
        403,
      );
    }
    const key = await vault.secretOf(connectionId);
    if (!key)
      return context.json({ error: "The connection has no secret." }, 503);
    const headers = new Headers();
    for (const name of ["content-type", "accept"]) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${key}`);
    let upstream: Response;
    try {
      upstream = await doFetch(
        `${connection.baseUrl.replace(/\/$/, "")}${subPath}`,
        {
          method: context.req.method,
          headers,
          body:
            context.req.method === "GET" || context.req.method === "HEAD"
              ? undefined
              : await context.req.arrayBuffer(),
          signal: AbortSignal.timeout(120_000),
        },
      );
    } catch (error) {
      return context.json(
        {
          error: `The service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
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
