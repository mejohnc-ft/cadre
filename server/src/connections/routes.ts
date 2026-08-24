import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  CONNECTION_KINDS,
  type ConnectionKind,
  type ConnectionStore,
} from "./store";

/**
 * The connections vault's routes: list, save, grant. Secrets are write-only — no route returns
 * one, and the list says only whether a TOTP seed is on file. Grants are the administrator's
 * standing answers, edited here and checked at every use.
 */

const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

function isKind(value: unknown): value is ConnectionKind {
  return (
    typeof value === "string" &&
    (CONNECTION_KINDS as readonly string[]).includes(value)
  );
}

export function createConnectionRoutes(input: {
  store: ConnectionStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const admin = input.requireUser;

  app.get("/admin/connections", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ connections: await input.store.list() });
  });

  app.put("/admin/connections/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const id = context.req.param("id");
    if (!CONNECTION_ID.test(id)) {
      return context.json(
        { error: "id must be a short lower-case slug." },
        400,
      );
    }
    const body = (await context.req.json().catch(() => null)) as {
      name?: unknown;
      kind?: unknown;
      service?: unknown;
      baseUrl?: unknown;
      loginUrl?: unknown;
      username?: unknown;
      secret?: unknown;
      totpSeed?: unknown;
      notes?: unknown;
    } | null;
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return context.json({ error: "name is required." }, 400);
    }
    if (!isKind(body.kind)) {
      return context.json(
        { error: `kind must be one of ${CONNECTION_KINDS.join(", ")}.` },
        400,
      );
    }
    if (typeof body.service !== "string" || !body.service.trim()) {
      return context.json({ error: "service is required." }, 400);
    }
    try {
      const saved = await input.store.upsert({
        id,
        name: body.name.trim(),
        kind: body.kind,
        service: body.service.trim(),
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
        loginUrl: typeof body.loginUrl === "string" ? body.loginUrl : null,
        username: typeof body.username === "string" ? body.username : null,
        ...(typeof body.secret === "string" && body.secret
          ? { secret: body.secret }
          : {}),
        // null clears a stored seed; absent keeps it.
        ...(body.totpSeed === null
          ? { totpSeed: null }
          : typeof body.totpSeed === "string" && body.totpSeed
            ? { totpSeed: body.totpSeed }
            : {}),
        notes: typeof body.notes === "string" ? body.notes : null,
        actor: context.var.actor.id,
      });
      return context.json({ ok: true, created: saved.created });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.delete("/admin/connections/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const removed = await input.store.remove(
      context.req.param("id"),
      context.var.actor.id,
    );
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such connection." }, 404);
  });

  app.post("/admin/connections/:id/grants", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    if (typeof body?.agentId !== "string" || !body.agentId) {
      return context.json({ error: "agentId is required." }, 400);
    }
    const connection = await input.store.get(context.req.param("id"));
    if (!connection) return context.json({ error: "No such connection." }, 404);
    await input.store.grant(connection.id, body.agentId, context.var.actor.id);
    return context.json({ ok: true });
  });

  app.delete(
    "/admin/connections/:id/grants/:agentId",
    admin,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const revoked = await input.store.revoke(
        context.req.param("id"),
        context.req.param("agentId"),
      );
      return revoked
        ? context.json({ ok: true })
        : context.json({ error: "No such grant." }, 404);
    },
  );

  return app;
}
