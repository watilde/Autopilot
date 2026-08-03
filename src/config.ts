import { z } from 'zod';

/**
 * Configuration is parsed once, at boot, and fails loudly. A misconfigured
 * orchestrator that starts anyway is worse than one that refuses to: it will
 * accept webhooks and silently drop remediation work.
 */

/**
 * An unset variable and one set to nothing are the same thing.
 *
 * Both `.env` files and Compose express "not configured" as an empty string —
 * `${VAR:-}` substitutes to `""` and is passed to the container regardless — so
 * a field that only accepts `undefined` refuses to boot on a blank value. That
 * is not theoretical: adding `DEVIN_API_VERSION` to the compose file put the
 * container in a crash loop on the *default* path, because an empty string is
 * not a member of `('v1','v3')`.
 *
 * Applied once, to the whole environment, rather than per field: the rule is a
 * property of how environments are written, not of any one variable, and a
 * field that forgets the wrapper is a crash loop nobody finds until deploy.
 * Dropping the key outright also lets `.default()` do its job — an empty
 * `LOG_LEVEL` becomes `info` instead of failing the enum, and an empty
 * `DATABASE_PATH` becomes the default path instead of the empty one.
 */
const withoutBlanks = (env: unknown) =>
  env && typeof env === 'object'
    ? Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([, v]) => v !== ''))
    : env;

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.preprocess(
  withoutBlanks,
  z.object({
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
    /**
     * Playbook every remediation session runs under. Holds the standing
     * procedure (branch naming, when to stop, what the PR must say) so the
     * per-issue prompt only has to carry the issue. Create one with
     * `npm run devin:setup`; leaving this unset simply omits it.
     */
    DEVIN_PLAYBOOK_ID: z.string().optional(),

    AUTOPILOT_LABEL: z.string().default('autopilot'),
    /**
     * How many times a CI failure may be handed back to the same session before
     * Autopilot stops and asks for a human. An agent that cannot fix its own
     * build on the second try is usually stuck on something the contract did not
     * anticipate, and looping costs ACUs to learn nothing.
     */
    MAX_CI_REWORKS: int(2),
    /**
     * Whether a pull request whose CI has gone green may be merged with no human
     * in the loop.
     *
     * Off by default, and the default is the point. Every other action this
     * system takes is reversible by a reviewer who has not looked yet — a wrong
     * patch sits in a PR, a wrong state correction is one comment. Merging is the
     * one step that lands the change in the branch people deploy from, so turning
     * this on is a deliberate statement that the contract plus its verification
     * job is the whole gate for the categories below.
     */
    AUTO_MERGE: bool(false),
    /**
     * Which categories are eligible, lowest-stakes first. `security` is refused
     * by the orchestrator whatever this list says — see `NEVER_AUTO_MERGE`.
     */
    AUTO_MERGE_CATEGORIES: csv(['code-quality']),
    /**
     * How long a requested merge may stay unperformed before the issue is handed
     * to a human.
     *
     * Asking is not merging, and the agent can decline — Devin's tooling refuses
     * to merge into `main`/`master` unconditionally, which is a rule no
     * configuration here can see coming. Without this, that refusal lives only in
     * the session transcript: the pull request sits green and open, the issue
     * says a merge was requested, and nothing says why it never happened.
     */
    AUTO_MERGE_GRACE_MS: int(600_000),
    MAX_CONCURRENT_SESSIONS: int(3),
    RECONCILE_INTERVAL_MS: int(15_000),
    SESSION_TIMEOUT_MS: int(3_600_000),
    POST_ISSUE_COMMENTS: bool(true),

    DATABASE_PATH: z.string().default('./data/autopilot.db'),
  }),
);

export type Config = z.infer<typeof schema>;

function build(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return parsed.data;
}

export const config = build();

/** Which Devin API generation a config implies. Exported for tests. */
export function resolveApiVersion(cfg: Config = config): 'v1' | 'v3' {
  return cfg.DEVIN_API_VERSION ?? (cfg.DEVIN_API_KEY?.startsWith('cog_') ? 'v3' : 'v1');
}

/**
 * Everything required to actually *run the service*, as opposed to parse a
 * config. The split matters: `npm run report` and `npm run seed` import this
 * module but never serve a request or dispatch a session, and failing them for
 * a missing webhook secret or Devin key would be nonsense — the report is most
 * useful precisely when the service is down.
 *
 * Checked at boot rather than at first use, so a misconfigured deploy fails
 * immediately instead of 403-ing an hour later. Nothing is weakened by the
 * move: the webhook route re-checks the secret on every request, and the Devin
 * factory re-checks its own credentials.
 */
export function assertServerConfig(cfg: Config = config): void {
  const errors: string[] = [];

  if (!cfg.GITHUB_WEBHOOK_SECRET && !cfg.ALLOW_UNSIGNED_WEBHOOKS) {
    errors.push(
      'GITHUB_WEBHOOK_SECRET is required to serve webhooks.\n' +
        '    Set it, or set ALLOW_UNSIGNED_WEBHOOKS=true for a local demo.',
    );
  }

  if (cfg.DEVIN_MODE === 'live') {
    if (!cfg.DEVIN_API_KEY) {
      errors.push('DEVIN_API_KEY is required when DEVIN_MODE=live.');
    }
    if (!cfg.GITHUB_TOKEN) {
      errors.push('GITHUB_TOKEN is required when DEVIN_MODE=live (needed to read issues).');
    }
    if (cfg.DEVIN_API_KEY && resolveApiVersion(cfg) === 'v3' && !cfg.DEVIN_ORG_ID) {
      errors.push(
        'DEVIN_ORG_ID is required for the v3 API (your key starts with "cog_").\n' +
          '    Find the organization id (org-…) under Settings → Service Users.',
      );
    }
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

/** Exposed for tests so they can exercise validation without mutating process.env. */
export const __buildConfig = build;
