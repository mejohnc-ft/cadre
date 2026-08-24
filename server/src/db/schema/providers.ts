import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";

/**
 * Providers and model routing: where a coworker's model lives, as data.
 *
 * A provider is an endpoint plus an encrypted key — Anthropic, OpenAI, or anything speaking one of
 * their wire shapes (Z.ai, OpenRouter, a vLLM box). One provider is the deployment default; a
 * model route overrides it per coworker. The key is AES-GCM under KEY_ENCRYPTION_KEY, written by
 * an administrator and never returned by any route, exactly as the mesh holds node tokens.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const modelProviders = pgTable("model_providers", {
  /** A slug the administrator recognises: "zai", "anthropic", "openrouter". */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Which wire shape the endpoint speaks. */
  kind: text("kind").notNull(), // "anthropic" | "openai" | "openai-compatible" | "anthropic-compatible"
  /** Null uses the vendor's own endpoint (api.anthropic.com / api.openai.com). */
  baseUrl: text("base_url"),
  keyEncrypted: text("key_encrypted").notNull(),
  /** The model used when a route names none. */
  defaultModel: text("default_model").notNull(),
  /** Exactly one provider should hold this; the store enforces it on write. */
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Per-coworker override: this Bot runs this model on this provider. */
export const modelRoutes = pgTable("model_routes", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  providerId: text("provider_id")
    .notNull()
    .references(() => modelProviders.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  /** Ordered fallbacks: [{providerId, model}, …]. Stored; automatic retry is later work. */
  fallbacks:
    jsonb("fallbacks").$type<Array<{ providerId: string; model: string }>>(),
  createdAt: createdAt(),
});
