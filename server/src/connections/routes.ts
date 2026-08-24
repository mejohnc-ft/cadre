import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { pollDeviceCode, startDeviceCode } from "./msauth";
import {
  CONNECTION_KINDS,
  type ConnectionKind,
  type ConnectionStore,
} from "./store";
import type { ConnectionVerifier } from "./verify";

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

/** Device-code sign-ins in flight, keyed by connection id. Lives only in this process. */
const pendingDeviceCodes = new Map<
  string,
  { deviceCode: string; tenant: string; clientId: string; expiresAt: number }
>();

export function createConnectionRoutes(input: {
  store: ConnectionStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Absent when this deployment has no computer gateway; the verify route then answers 503. */
  verifier?: ConnectionVerifier;
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
      allowedPaths?: unknown;
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
    let allowedPaths: string[] | null | undefined;
    if (Array.isArray(body.allowedPaths)) {
      const lines = body.allowedPaths.filter(
        (line): line is string => typeof line === "string",
      );
      const { parseEgressRules } = await import("./egress-rules");
      if (parseEgressRules(lines) === null) {
        return context.json(
          {
            error:
              'Each allowed path is "METHOD /path", like "POST /zones/*/dns_records" or "GET /zones/**".',
          },
          400,
        );
      }
      allowedPaths = lines.length > 0 ? lines : null;
    } else if (body.allowedPaths === null) {
      allowedPaths = null;
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
        ...(allowedPaths !== undefined ? { allowedPaths } : {}),
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

  /**
   * Intake's affirmation: walk a granted coworker's browser through the real sign-in and record
   * what happened. The response carries the outcome; the connection remembers it.
   */
  app.post("/admin/connections/:id/verify", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!input.verifier) {
      return context.json(
        { error: "This deployment has no computer to verify with." },
        503,
      );
    }
    const connection = await input.store.get(context.req.param("id"));
    if (!connection) return context.json({ error: "No such connection." }, 404);
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const botId =
      typeof body?.agentId === "string" && body.agentId
        ? body.agentId
        : connection.grants[0];
    if (!botId) {
      return context.json(
        {
          error:
            "Grant the connection to a coworker first; the verification runs in its computer.",
        },
        400,
      );
    }
    const outcome = await input.verifier.verify(connection.id, botId, {
      id: context.var.actor.id,
    });
    return context.json(outcome);
  });

  /** Supervised connect: open the sign-in page + take control, so a person signs in themselves. */
  app.post("/admin/connections/:id/connect-begin", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!input.verifier) {
      return context.json({ error: "This deployment has no computer." }, 503);
    }
    const connection = await input.store.get(context.req.param("id"));
    if (!connection) return context.json({ error: "No such connection." }, 404);
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const botId =
      typeof body?.agentId === "string" && body.agentId
        ? body.agentId
        : connection.grants[0];
    if (!botId) {
      return context.json(
        {
          error:
            "Grant the connection to a coworker first; the sign-in runs in its computer.",
        },
        400,
      );
    }
    const outcome = await input.verifier.connectBegin(connection.id, botId, {
      id: context.var.actor.id,
    });
    return context.json({ ...outcome, botId });
  });

  /** Supervised connect: capture the session the person just signed into. */
  app.post("/admin/connections/:id/connect-capture", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!input.verifier) {
      return context.json({ error: "This deployment has no computer." }, 503);
    }
    const connection = await input.store.get(context.req.param("id"));
    if (!connection) return context.json({ error: "No such connection." }, 404);
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const botId =
      typeof body?.agentId === "string" && body.agentId
        ? body.agentId
        : connection.grants[0];
    if (!botId)
      return context.json({ error: "No coworker to capture from." }, 400);
    const outcome = await input.verifier.connectCapture(connection.id, botId, {
      id: context.var.actor.id,
    });
    return context.json(outcome);
  });

  /**
   * Microsoft device-code sign-in — start. Ensures the connection exists, asks Microsoft for a
   * code, and returns the code + the URL the person opens in their OWN browser. Their password
   * never comes here.
   */
  app.post(
    "/admin/connections/:id/ms-connect/start",
    admin,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const id = context.req.param("id");
      const body = (await context.req.json().catch(() => null)) as {
        name?: unknown;
        tenant?: unknown;
        clientId?: unknown;
      } | null;
      // Create the connection on first connect, so the UI needs no prior setup.
      const existing = await input.store.get(id);
      if (!existing) {
        await input.store.upsert({
          id,
          name: typeof body?.name === "string" ? body.name : id,
          kind: "web",
          service: "microsoft",
          actor: context.var.actor.id,
        });
      }
      try {
        const started = await startDeviceCode({
          ...(typeof body?.tenant === "string" ? { tenant: body.tenant } : {}),
          ...(typeof body?.clientId === "string"
            ? { clientId: body.clientId }
            : {}),
        });
        pendingDeviceCodes.set(id, {
          deviceCode: started.deviceCode,
          tenant:
            typeof body?.tenant === "string" ? body.tenant : "organizations",
          clientId:
            typeof body?.clientId === "string"
              ? body.clientId
              : "14d82eec-204b-4c2f-b7e8-296a70dab67e",
          expiresAt: Date.now() + started.expiresIn * 1000,
        });
        return context.json({
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresIn: started.expiresIn,
          interval: started.interval,
        });
      } catch (error) {
        return context.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    },
  );

  /** Microsoft device-code sign-in — poll. Captures the token once the person has signed in. */
  app.post("/admin/connections/:id/ms-connect/poll", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const id = context.req.param("id");
    const state = pendingDeviceCodes.get(id);
    if (!state) return context.json({ status: "no-pending" });
    if (Date.now() > state.expiresAt) {
      pendingDeviceCodes.delete(id);
      return context.json({ status: "expired" });
    }
    try {
      const tokens = await pollDeviceCode({
        deviceCode: state.deviceCode,
        tenant: state.tenant,
        clientId: state.clientId,
      });
      if (!tokens) return context.json({ status: "pending" });
      pendingDeviceCodes.delete(id);
      await input.store.storeSession(id, JSON.stringify(tokens), null);
      return context.json({ status: "connected" });
    } catch (error) {
      pendingDeviceCodes.delete(id);
      return context.json({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
