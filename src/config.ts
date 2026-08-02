import { z } from 'zod';

/**
 * Configuration is parsed once, at boot, and fails loudly. A misconfigured
 * orchestrator that starts anyway is worse than one that refuses to: it will
 * accept webhooks and silently drop remediation work.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  GITHUB_OWNER: z.string().default('watilde'),
  GITHUB_REPO: z.string().default('superset'),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  ALLOW_UNSIGNED_WEBHOOKS: bool(false),

  DEVIN_MODE: z.enum(['live', 'mock']).default('mock'),
  DEVIN_API_KEY: z.string().optional(),
  /** Host only — the client appends /v1 or /v3 based on the credential. */
  DEVIN_API_BASE_URL: z.string().url().default('https://api.devin.ai'),
  /** Normally inferred from the key prefix; set only to override. */
  DEVIN_API_VERSION: z.enum(['v1', 'v3']).optional(),
  /** Required for v3 (`cog_` keys): Settings → Service Users. */
  DEVIN_ORG_ID: z.string().optional(),
  DEVIN_MAX_ACU: int(10),

  AUTOPILOT_LABEL: z.string().default('autopilot'),
  MAX_CONCURRENT_SESSIONS: int(3),
  RECONCILE_INTERVAL_MS: int(15_000),
  SESSION_TIMEOUT_MS: int(3_600_000),
  POST_ISSUE_COMMENTS: bool(true),

  DATABASE_PATH: z.string().default('./data/autopilot.db'),
});

export type Config = z.infer<typeof schema>;

function build(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  const cfg = parsed.data;

  // Cross-field rules. These are the settings that make the difference between
  // "works on my laptop" and "safe to point at a real repository".
  const errors: string[] = [];
  if (cfg.DEVIN_MODE === 'live' && !cfg.DEVIN_API_KEY) {
    errors.push('DEVIN_API_KEY is required when DEVIN_MODE=live');
  }
  // Caught here rather than at the first API call, so a misconfigured deploy
  // fails at boot instead of silently 403-ing an hour later.
  const version = cfg.DEVIN_API_VERSION ?? (cfg.DEVIN_API_KEY?.startsWith('cog_') ? 'v3' : 'v1');
  if (cfg.DEVIN_MODE === 'live' && version === 'v3' && !cfg.DEVIN_ORG_ID) {
    errors.push(
      'DEVIN_ORG_ID is required for the v3 API (your key starts with "cog_"). ' +
        'Find it under Settings → Service Users.',
    );
  }
  if (cfg.DEVIN_MODE === 'live' && !cfg.GITHUB_TOKEN) {
    errors.push('GITHUB_TOKEN is required when DEVIN_MODE=live (needed to read issues)');
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  }
  return cfg;
}

export const config = build();

/**
 * Checks that only apply when we are actually listening for webhooks.
 *
 * These live outside build() on purpose: `npm run report` and `npm run seed`
 * import this module but never expose an HTTP endpoint, and failing them for a
 * missing webhook secret would be nonsense. The webhook route enforces the
 * same rule at request time regardless, so nothing is weakened by checking it
 * here instead of at import.
 */
export function assertServerConfig(cfg: Config = config): void {
  if (!cfg.GITHUB_WEBHOOK_SECRET && !cfg.ALLOW_UNSIGNED_WEBHOOKS) {
    throw new Error(
      'Invalid configuration:\n' +
        '  GITHUB_WEBHOOK_SECRET is required to serve webhooks.\n' +
        '  Set it, or set ALLOW_UNSIGNED_WEBHOOKS=true for a local demo.',
    );
  }
}

/** Exposed for tests so they can exercise validation without mutating process.env. */
export const __buildConfig = build;
