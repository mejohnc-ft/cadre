import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { threadRuns } from "../db/schema";
import { PROVIDER_KINDS, type ProviderKind, type ProviderStore } from "./store";

/**
 * Model routing's routes: providers (keys write-only, never returned), per-coworker routes, and
 * the usage view aggregated from what the harnesses reported into the thread history.
 */

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

function isKind(value: unknown): value is ProviderKind {
  return (
    typeof value === "string" &&
    (PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

export function createProviderRoutes(input: {
  store: ProviderStore;
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const admin = input.requireUser;

  app.get("/admin/providers", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ providers: await input.store.list() });
  });

  app.put("/admin/providers/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const id = context.req.param("id");
    if (!PROVIDER_ID.test(id)) {
      return context.json(
        { error: "id must be a short lower-case slug." },
        400,
      );
    }
    const body = (await context.req.json().catch(() => null)) as {
      name?: unknown;
      kind?: unknown;
      baseUrl?: unknown;
      defaultModel?: unknown;
      isDefault?: unknown;
      key?: unknown;
    } | null;
    if (!isKind(body?.kind)) {
      return context.json(
        { error: `kind must be one of: ${PROVIDER_KINDS.join(", ")}.` },
        400,
      );
    }
    if (typeof body?.defaultModel !== "string" || !body.defaultModel.trim()) {
      return context.json({ error: "defaultModel is required." }, 400);
    }
    if (
      body.baseUrl !== undefined &&
      body.baseUrl !== null &&
      body.baseUrl !== "" &&
      !/^https?:\/\//.test(String(body.baseUrl))
    ) {
      return context.json({ error: "baseUrl must be http(s)." }, 400);
    }
    try {
      const provider = await input.store.upsert({
        id,
        name:
          typeof body.name === "string" && body.name.trim() ? body.name : id,
        kind: body.kind,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
        defaultModel: body.defaultModel.trim(),
        isDefault: body.isDefault === true,
        ...(typeof body.key === "string" && body.key ? { key: body.key } : {}),
      });
      return context.json({ provider });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.delete("/admin/providers/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const removed = await input.store.remove(context.req.param("id"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such provider." }, 404);
  });

  // ---- per-coworker route --------------------------------------------------------------------

  app.get("/admin/agents/:agentId/model-route", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      route: await input.store.routeOf(context.req.param("agentId")),
    });
  });

  app.put("/admin/agents/:agentId/model-route", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      providerId?: unknown;
      model?: unknown;
      fallbacks?: unknown;
    } | null;
    if (
      typeof body?.providerId !== "string" ||
      typeof body?.model !== "string"
    ) {
      return context.json({ error: "providerId and model are required." }, 400);
    }
    if (!(await input.store.get(body.providerId))) {
      return context.json({ error: "No such provider." }, 404);
    }
    await input.store.setRoute({
      agentId: context.req.param("agentId"),
      providerId: body.providerId,
      model: body.model,
      fallbacks: Array.isArray(body.fallbacks)
        ? (body.fallbacks as Array<{ providerId: string; model: string }>)
        : [],
    });
    return context.json({ ok: true });
  });

  app.delete("/admin/agents/:agentId/model-route", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const removed = await input.store.clearRoute(context.req.param("agentId"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No route set." }, 404);
  });

  // ---- usage ---------------------------------------------------------------------------------

  /**
   * Spend per coworker, from the `harness_usage` events the runs recorded into thread history.
   * Scanned rather than pre-aggregated: at this deployment's scale the recent runs are small, and
   * the history is already the durable record — no second ledger to drift.
   */
  app.get("/admin/usage", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const rows = await input.database
      .select({
        agentId: threadRuns.agentId,
        events: threadRuns.events,
        createdAt: threadRuns.createdAt,
      })
      .from(threadRuns);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const byAgent = new Map<
      string,
      { runs: number; costUsd: number; durationMs: number }
    >();
    for (const row of rows) {
      if (row.createdAt.getTime() < since) continue;
      const entry = byAgent.get(row.agentId) ?? {
        runs: 0,
        costUsd: 0,
        durationMs: 0,
      };
      entry.runs += 1;
      for (const event of (row.events as Array<Record<string, unknown>>) ??
        []) {
        if (event.type === "CUSTOM" && event.name === "harness_usage") {
          const value = event.value as Record<string, unknown> | undefined;
          if (typeof value?.costUsd === "number")
            entry.costUsd += value.costUsd;
          if (typeof value?.durationMs === "number") {
            entry.durationMs += value.durationMs;
          }
        }
      }
      byAgent.set(row.agentId, entry);
    }
    return context.json({
      days: 30,
      usage: [...byAgent.entries()]
        .map(([agentId, u]) => ({ agentId, ...u }))
        .sort((a, b) => b.runs - a.runs),
    });
  });

  return app;
}
