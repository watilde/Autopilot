import { describe, expect, it } from 'vitest';
import { __buildConfig, assertServerConfig, resolveApiVersion } from '../src/config.js';

/**
 * The split between build() and assertServerConfig() is load-bearing:
 * build() must stay permissive enough that `npm run report` works when the
 * service is down and half the credentials are absent, while the server must
 * still refuse to start misconfigured.
 */

const base = { DATABASE_PATH: ':memory:', LOG_LEVEL: 'fatal' } as NodeJS.ProcessEnv;

describe('config parsing', () => {
  it('applies defaults with an empty environment', () => {
    const cfg = __buildConfig(base);
    expect(cfg.DEVIN_MODE).toBe('mock');
    expect(cfg.PORT).toBe(8080);
    expect(cfg.MAX_CONCURRENT_SESSIONS).toBe(3);
    expect(cfg.AUTOPILOT_LABEL).toBe('autopilot');
  });

  /**
   * The one irreversible action in the system defaults to off. A deployment
   * that merges unattended has to have said so.
   */
  it('leaves auto-merge off unless the environment turns it on', () => {
    expect(__buildConfig(base).AUTO_MERGE).toBe(false);
    expect(__buildConfig({ ...base, AUTO_MERGE: 'true' }).AUTO_MERGE).toBe(true);
  });

  it('reads the auto-merge allowlist as a comma-separated list', () => {
    expect(__buildConfig(base).AUTO_MERGE_CATEGORIES).toEqual(['code-quality']);
    expect(
      __buildConfig({ ...base, AUTO_MERGE_CATEGORIES: 'code-quality, Dependency ' })
        .AUTO_MERGE_CATEGORIES,
    ).toEqual(['code-quality', 'dependency']);
    // Empty means "use the default", not "allow nothing" — an env file with a
    // blank line under the key should not silently change behaviour.
    expect(__buildConfig({ ...base, AUTO_MERGE_CATEGORIES: '' }).AUTO_MERGE_CATEGORIES).toEqual([
      'code-quality',
    ]);
  });

  /**
   * Compose substitutes `${VAR:-}` to an empty string and passes it anyway, so
   * "not configured" reaches the process as `''`, not as absent. A schema that
   * only accepts `undefined` therefore refuses to boot on a blank value — which
   * is exactly how adding DEVIN_API_VERSION to the compose file put the
   * container in a crash loop on the default, credential-free path.
   */
  it('treats a variable set to nothing as unset', () => {
    const blanked = {
      ...base,
      DEVIN_API_VERSION: '',
      DEVIN_API_KEY: '',
      DEVIN_ORG_ID: '',
      DEVIN_PLAYBOOK_ID: '',
      DEVIN_API_BASE_URL: '',
      GITHUB_TOKEN: '',
      GITHUB_WEBHOOK_SECRET: '',
    };
    expect(() => __buildConfig(blanked)).not.toThrow();

    const cfg = __buildConfig(blanked);
    expect(cfg.DEVIN_API_VERSION).toBeUndefined();
    expect(cfg.GITHUB_TOKEN).toBeUndefined();
    // A blank still falls back to the default rather than failing `.url()`.
    expect(cfg.DEVIN_API_BASE_URL).toBe('https://api.devin.ai');
  });

  /**
   * The same rule has to hold for the fields that carry a default, or the fix
   * just moves the crash: a blank `LOG_LEVEL` fails the enum exactly like a
   * blank `DEVIN_API_VERSION` did, and a blank `DATABASE_PATH` is worse than a
   * crash — it boots and writes the database to nowhere.
   */
  it('falls back to the default when a variable with one is set to nothing', () => {
    const cfg = __buildConfig({
      DATABASE_PATH: '',
      LOG_LEVEL: '',
      DEVIN_MODE: '',
      AUTOPILOT_LABEL: '',
      HOST: '',
      PORT: '',
    });
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.DEVIN_MODE).toBe('mock');
    expect(cfg.DATABASE_PATH).toBe('./data/autopilot.db');
    expect(cfg.AUTOPILOT_LABEL).toBe('autopilot');
    expect(cfg.HOST).toBe('0.0.0.0');
    expect(cfg.PORT).toBe(8080);
  });

  it('still rejects a value that is present and wrong', () => {
    expect(() => __buildConfig({ ...base, DEVIN_API_VERSION: 'v2' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('rejects a malformed value', () => {
    expect(() => __buildConfig({ ...base, PORT: 'not-a-number' })).toThrow(/Invalid configuration/);
  });

  it('rejects an unknown Devin mode', () => {
    expect(() => __buildConfig({ ...base, DEVIN_MODE: 'sorta-live' })).toThrow();
  });

  // Reporting tools import config but need no credentials; parsing must not
  // fail just because live-mode secrets are absent.
  it('parses a live-mode environment with no credentials at all', () => {
    expect(() => __buildConfig({ ...base, DEVIN_MODE: 'live' })).not.toThrow();
  });
});

describe('API version resolution', () => {
  it('infers v3 from a cog_ key', () => {
    expect(resolveApiVersion(__buildConfig({ ...base, DEVIN_API_KEY: 'cog_abc' }))).toBe('v3');
  });

  it('infers v1 from an apk_ key', () => {
    expect(resolveApiVersion(__buildConfig({ ...base, DEVIN_API_KEY: 'apk_abc' }))).toBe('v1');
  });

  it('lets an explicit override win over inference', () => {
    const cfg = __buildConfig({ ...base, DEVIN_API_KEY: 'cog_abc', DEVIN_API_VERSION: 'v1' });
    expect(resolveApiVersion(cfg)).toBe('v1');
  });
});

describe('server preflight', () => {
  const live = (extra: NodeJS.ProcessEnv = {}) =>
    __buildConfig({
      ...base,
      DEVIN_MODE: 'live',
      ALLOW_UNSIGNED_WEBHOOKS: 'true',
      DEVIN_API_KEY: 'cog_abc',
      GITHUB_TOKEN: 'ghp_abc',
      DEVIN_ORG_ID: 'org-abc',
      ...extra,
    });

  it('passes a fully configured live environment', () => {
    expect(() => assertServerConfig(live())).not.toThrow();
  });

  it('passes a mock environment with no credentials', () => {
    expect(() =>
      assertServerConfig(__buildConfig({ ...base, ALLOW_UNSIGNED_WEBHOOKS: 'true' })),
    ).not.toThrow();
  });

  it('demands a webhook secret unless unsigned webhooks are explicitly allowed', () => {
    expect(() => assertServerConfig(__buildConfig(base))).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it('demands an org id for a v3 credential', () => {
    expect(() => assertServerConfig(live({ DEVIN_ORG_ID: '' }))).toThrow(/DEVIN_ORG_ID/);
  });

  it('does not demand an org id for a v1 credential', () => {
    expect(() =>
      assertServerConfig(live({ DEVIN_ORG_ID: '', DEVIN_API_KEY: 'apk_abc' })),
    ).not.toThrow();
  });

  it('demands Devin and GitHub credentials in live mode', () => {
    expect(() => assertServerConfig(live({ DEVIN_API_KEY: '' }))).toThrow(/DEVIN_API_KEY/);
    expect(() => assertServerConfig(live({ GITHUB_TOKEN: '' }))).toThrow(/GITHUB_TOKEN/);
  });

  // A half-configured deploy should surface everything at once rather than
  // making the operator rediscover one missing variable per restart.
  it('reports every problem in a single error', () => {
    let message = '';
    try {
      assertServerConfig(__buildConfig({ ...base, DEVIN_MODE: 'live', DEVIN_API_KEY: 'cog_abc' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/GITHUB_WEBHOOK_SECRET/);
    expect(message).toMatch(/GITHUB_TOKEN/);
    expect(message).toMatch(/DEVIN_ORG_ID/);
  });
});
