import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { MeshProvider } from "./provider";
import { LOCAL_NODE, type NodeStore } from "./store";

/**
 * The mesh's routes.
 *
 * Administrators mint enrollment tokens, list nodes with live capacity, toggle placement, remove
 * nodes, and move a Bot. A node enrols itself by presenting a token: that route is unauthenticated
 * by design — the machine joining has no session — and the token, single-use and short-lived, is
 * the whole authorisation. Before a node is stored the server calls its supervisor's health, so a
 * node this server cannot reach is refused at enrolment rather than discovered at the first turn.
 */

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function createMeshRoutes(input: {
  nodes: NodeStore;
  mesh: MeshProvider;
  audit: AuditStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  fetchImpl?: typeof fetch;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const doFetch = input.fetchImpl ?? fetch;

  app.get("/admin/nodes", input.requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ nodes: await input.mesh.capacityByNode() });
  });

  app.post(
    "/admin/nodes/enrollment-tokens",
    input.requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const minted = await input.nodes.mintEnrollmentToken(
        context.var.actor.id,
      );
      return context.json(minted, 201);
    },
  );

  app.patch("/admin/nodes/:nodeId", input.requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      placementEnabled?: unknown;
    } | null;
    if (typeof body?.placementEnabled !== "boolean") {
      return context.json(
        { error: "placementEnabled must be a boolean." },
        400,
      );
    }
    const ok = await input.nodes.setPlacementEnabled(
      context.req.param("nodeId"),
      body.placementEnabled,
    );
    return ok
      ? context.json({ ok: true })
      : context.json({ error: "No such node." }, 404);
  });

  app.delete("/admin/nodes/:nodeId", input.requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const nodeId = context.req.param("nodeId");
    const removed = await input.nodes.remove(nodeId);
    if (!removed) return context.json({ error: "No such node." }, 404);
    await recordAuditEvent(input.audit, {
      eventType: "node.removed",
      targetType: "node",
      targetId: nodeId,
      actorUserId: context.var.actor.id,
      payload: { node: nodeId },
    });
    return context.json({ ok: true });
  });

  /** A machine joining. Authorised by the token alone; see the header comment. */
  app.post("/nodes/enroll", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      token?: unknown;
      id?: unknown;
      name?: unknown;
      supervisorUrl?: unknown;
      supervisorToken?: unknown;
      backend?: unknown;
    } | null;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : id;
    const supervisorUrl =
      typeof body?.supervisorUrl === "string" ? body.supervisorUrl.trim() : "";
    const supervisorToken =
      typeof body?.supervisorToken === "string" ? body.supervisorToken : "";
    const backend = typeof body?.backend === "string" ? body.backend : "docker";
    const token = typeof body?.token === "string" ? body.token : "";

    if (!NODE_ID.test(id) || id === LOCAL_NODE) {
      return context.json(
        { error: "id must be a short lower-case slug." },
        400,
      );
    }
    if (!/^https?:\/\//.test(supervisorUrl)) {
      return context.json({ error: "supervisorUrl must be http(s)." }, 400);
    }
    if (!supervisorToken) {
      return context.json({ error: "supervisorToken is required." }, 400);
    }
    if (backend !== "docker" && backend !== "apple") {
      return context.json({ error: "backend must be docker or apple." }, 400);
    }
    if (!(await input.nodes.consumeEnrollmentToken(token, id))) {
      return context.json(
        { error: "The enrollment token is missing, expired or already used." },
        403,
      );
    }

    // The server must be able to call the node, or the node is no use to it.
    try {
      const response = await doFetch(
        `${supervisorUrl.replace(/\/$/, "")}/v1/capacity`,
        {
          headers: { authorization: `Bearer ${supervisorToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        return context.json(
          {
            error: `The supervisor at ${supervisorUrl} answered ${response.status}; check its token.`,
          },
          400,
        );
      }
    } catch (error) {
      return context.json(
        {
          error: `This server cannot reach ${supervisorUrl}: ${error instanceof Error ? error.message : String(error)}. Is the node on the tailnet?`,
        },
        400,
      );
    }

    const node = await input.nodes.enroll({
      id,
      name,
      supervisorUrl,
      supervisorToken,
      backend,
    });
    await recordAuditEvent(input.audit, {
      eventType: "node.enrolled",
      targetType: "node",
      targetId: id,
      payload: { node: id, name, supervisorUrl, backend },
    });
    return context.json({ node }, 201);
  });

  app.post(
    "/admin/computers/:botId/move",
    input.requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const body = (await context.req.json().catch(() => null)) as {
        nodeId?: unknown;
      } | null;
      const nodeId = typeof body?.nodeId === "string" ? body.nodeId : "";
      if (!nodeId) return context.json({ error: "nodeId is required." }, 400);
      try {
        const moved = await input.mesh.move(
          context.req.param("botId"),
          nodeId,
          context.var.actor.id,
        );
        return context.json(moved);
      } catch (error) {
        return context.json(
          { error: error instanceof Error ? error.message : String(error) },
          409,
        );
      }
    },
  );

  app.get("/admin/computers/placements", input.requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ computers: await input.mesh.listPlaced() });
  });

  return app;
}
