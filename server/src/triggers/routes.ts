import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { isValidCron } from "./cron";
import type { TriggerEngine } from "./engine";

/**
 * Trigger routes: admin CRUD, a Fire-now button, and the public webhook.
 *
 * The webhook route is unauthenticated by design — the caller is an outside system with no
 * session — and the single-use-shown token is the whole authorisation, exactly as node enrollment
 * works. Everything the firing then does runs on the ordinary governed path.
 */

export function createTriggerRoutes(input: {
  engine: TriggerEngine;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const admin = input.requireUser;

  app.get("/admin/triggers", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ triggers: await input.engine.list() });
  });

  app.post("/admin/triggers", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      name?: unknown;
      agentId?: unknown;
      kind?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      threadMode?: unknown;
    } | null;
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return context.json({ error: "name is required." }, 400);
    }
    if (typeof body?.agentId !== "string" || !body.agentId) {
      return context.json({ error: "agentId is required." }, 400);
    }
    if (body.kind !== "cron" && body.kind !== "webhook") {
      return context.json({ error: "kind must be cron or webhook." }, 400);
    }
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
      return context.json({ error: "prompt is required." }, 400);
    }
    if (body.kind === "cron") {
      if (typeof body.schedule !== "string" || !isValidCron(body.schedule)) {
        return context.json(
          {
            error:
              'schedule must be a five-field cron expression, like "0 7 * * 1-5".',
          },
          400,
        );
      }
    }
    const created = await input.engine.create({
      name: body.name.trim(),
      agentId: body.agentId,
      kind: body.kind,
      ...(typeof body.schedule === "string" ? { schedule: body.schedule } : {}),
      prompt: body.prompt,
      threadMode: body.threadMode === "new" ? "new" : "continue",
      createdBy: context.var.actor.id,
    });
    // The webhook token appears in this response and nowhere ever again.
    return context.json(created, 201);
  });

  app.patch("/admin/triggers/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const patch: Record<string, unknown> = {};
    if (typeof body?.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (typeof body?.prompt === "string" && body.prompt.trim()) {
      patch.prompt = body.prompt;
    }
    if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
    if (body?.threadMode === "new" || body?.threadMode === "continue") {
      patch.threadMode = body.threadMode;
    }
    if (typeof body?.schedule === "string") {
      if (!isValidCron(body.schedule)) {
        return context.json(
          { error: "schedule is not a valid cron expression." },
          400,
        );
      }
      patch.schedule = body.schedule;
    }
    if (Object.keys(patch).length === 0) {
      return context.json({ error: "Nothing to change." }, 400);
    }
    const ok = await input.engine.update(context.req.param("id"), patch);
    return ok
      ? context.json({ ok: true })
      : context.json({ error: "No such trigger." }, 404);
  });

  app.delete("/admin/triggers/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const removed = await input.engine.remove(context.req.param("id"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such trigger." }, 404);
  });

  /** Fire now, from the page. Waits for the firing so the caller sees the outcome. */
  app.post("/admin/triggers/:id/fire", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const trigger = await input.engine.get(context.req.param("id"));
    if (!trigger) return context.json({ error: "No such trigger." }, 404);
    const outcome = await input.engine.fire(trigger, "manual");
    return context.json(outcome);
  });

  /**
   * The webhook. Token in the X-Cadre-Token header or ?token=. The request body, if any, is
   * handed to the coworker beneath the trigger's prompt.
   */
  app.post("/hooks/:id", async (context) => {
    const id = context.req.param("id");
    const token =
      context.req.header("x-cadre-token") ?? context.req.query("token") ?? "";
    if (!(await input.engine.verifyWebhook(id, token))) {
      return context.json({ error: "Unknown hook." }, 404);
    }
    const trigger = await input.engine.get(id);
    if (!trigger) return context.json({ error: "Unknown hook." }, 404);
    const body = await context.req.text().catch(() => "");
    // Fired without waiting: a webhook caller wants an ack, not a transcript.
    void input.engine
      .fire(trigger, "webhook", body || undefined)
      .catch(() => {});
    return context.json({ accepted: true }, 202);
  });

  return app;
}
