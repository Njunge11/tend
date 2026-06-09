import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const ToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  configPath: z.string().optional(),
});

const FixScopeConfigSchema = z
  .object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    includeGenerated: z.boolean().default(false),
    includeFixtures: z.boolean().default(false),
  })
  .default({
    include: [],
    exclude: [],
    includeGenerated: false,
    includeFixtures: false,
  });

export const ConfigSchema = z.object({
  maxSessions: z.number().int().positive().default(4),
  maxLoops: z.number().int().positive().default(5),
  perIssueBudget: z.number().int().positive().default(3),
  test: z.string().optional(),
  teethCheck: z.boolean().default(true),
  includeTests: z.boolean().default(false),
  /** Model passed to `claude -p` for fixes — a full model id (or an alias like sonnet/opus/haiku). */
  model: z.string().default("claude-sonnet-4-6"),
  /**
   * Model for duplication (jscpd) fixes — an alias or full model id. Cross-file
   * dedup needs more reasoning than the default model, so these go to a more
   * capable model. Unset → a built-in capable default (see model-selection.ts).
   */
  duplicationModel: z.string().optional(),
  /** Reasoning effort for fixes; unset → claude's own default. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  /** Extended-thinking token budget per fix session; unset → per-finding policy decides. */
  thinkingBudget: z.number().int().nonnegative().optional(),
  /** Report/fix scope policy. Reports stay broad; fixes default away from generated/tooling paths. */
  fix: FixScopeConfigSchema,
  tools: z.record(z.string(), ToolConfigSchema).default({}),
});

export type TendConfig = z.infer<typeof ConfigSchema>;

/** CLI flags that can override config; only defined keys take effect. */
type CliOverrides = Partial<
  Pick<
    TendConfig,
    | "maxSessions"
    | "maxLoops"
    | "perIssueBudget"
    | "test"
    | "teethCheck"
    | "includeTests"
    | "model"
    | "duplicationModel"
    | "effort"
  >
>;

/**
 * Load config via cosmiconfig (searching from `cwd`), validate with zod, and apply
 * zero-config defaults when no file is found. Invalid config throws a clear message.
 */
export async function loadConfig(cwd: string): Promise<TendConfig> {
  const explorer = cosmiconfig("tend", { stopDir: cwd });
  const found = await explorer.search(cwd);
  const raw = found?.config ?? {};

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid tend config:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** Overlay CLI flags onto a loaded config (flags win). */
export function applyCliOverrides(config: TendConfig, overrides: CliOverrides): TendConfig {
  const result = { ...config };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}
