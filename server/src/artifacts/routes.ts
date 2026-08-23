import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactStore } from "./store";

/**
 * The artifact registry's routes, admin-scoped: list, read (a version), the version history,
 * create/update (a new version)/delete, and attach/detach to a profile. Content is text; the
 * projection into a harness happens at run time (see harness/runtime.ts), not here.
 */

function isKind(value: unknown): value is ArtifactKind {
  return (
    typeof value === "string" &&
    (ARTIFACT_KINDS as readonly string[]).includes(value)
  );
}

export function createArtifactRoutes(input: {
  store: ArtifactStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const admin = input.requireUser;

  app.get("/admin/artifacts", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const kind = context.req.query("kind");
    return context.json({
      artifacts: await input.store.list(isKind(kind) ? kind : undefined),
    });
  });

  app.get("/admin/artifacts/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const version = Number(context.req.query("version"));
    const artifact = await input.store.get(
      context.req.param("id"),
      Number.isFinite(version) ? version : undefined,
    );
    if (!artifact) return context.json({ error: "No such artifact." }, 404);
    const versions = await input.store.versions(artifact.id);
    return context.json({ artifact, versions });
  });

  app.post("/admin/artifacts", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      name?: unknown;
      description?: unknown;
      content?: unknown;
    } | null;
    if (!isKind(body?.kind)) {
      return context.json(
        { error: `kind must be one of: ${ARTIFACT_KINDS.join(", ")}.` },
        400,
      );
    }
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return context.json({ error: "name is required." }, 400);
    }
    if (typeof body?.content !== "string") {
      return context.json({ error: "content is required." }, 400);
    }
    const artifact = await input.store.create({
      kind: body.kind,
      name: body.name.trim(),
      description:
        typeof body.description === "string" ? body.description : undefined,
      content: body.content,
      createdBy: context.var.actor.id,
    });
    return context.json({ artifact }, 201);
  });

  app.post("/admin/artifacts/:id/versions", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      content?: unknown;
      description?: unknown;
    } | null;
    if (typeof body?.content !== "string") {
      return context.json({ error: "content is required." }, 400);
    }
    try {
      const version = await input.store.update(context.req.param("id"), {
        content: body.content,
        description:
          typeof body.description === "string" ? body.description : undefined,
        createdBy: context.var.actor.id,
      });
      return context.json({ version });
    } catch {
      return context.json({ error: "No such artifact." }, 404);
    }
  });

  app.delete("/admin/artifacts/:id", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const removed = await input.store.remove(context.req.param("id"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such artifact." }, 404);
  });

  // ---- profile attachment --------------------------------------------------------------------

  app.get("/admin/agents/:agentId/artifacts", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      artifacts: await input.store.forProfile(context.req.param("agentId")),
    });
  });

  app.post("/admin/agents/:agentId/artifacts", admin, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      artifactId?: unknown;
      pinnedVersion?: unknown;
    } | null;
    if (typeof body?.artifactId !== "string") {
      return context.json({ error: "artifactId is required." }, 400);
    }
    await input.store.attach(
      context.req.param("agentId"),
      body.artifactId,
      typeof body.pinnedVersion === "number" ? body.pinnedVersion : undefined,
    );
    return context.json({ ok: true });
  });

  app.delete(
    "/admin/agents/:agentId/artifacts/:artifactId",
    admin,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const removed = await input.store.detach(
        context.req.param("agentId"),
        context.req.param("artifactId"),
      );
      return removed
        ? context.json({ ok: true })
        : context.json({ error: "Not attached." }, 404);
    },
  );

  return app;
}
