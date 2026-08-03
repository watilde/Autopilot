import Fastify from 'fastify';
import { assertServerConfig, config } from './config.js';
import { Store } from './db/index.js';
import { createDevinClient } from './devin/index.js';
import { createGitHubClient } from './github/client.js';
import { Orchestrator } from './core/orchestrator.js';
import { Scanner } from './core/scanner.js';
import { AuditRunner } from './core/audit.js';
import { logger } from './logger.js';
import { registerApiRoutes } from './routes/api.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerWebhookRoutes } from './routes/webhook.js';

export function buildServer(deps?: {
  store?: Store;
  orchestrator?: Orchestrator;
  scanner?: Scanner;
}) {
  const store = deps?.store ?? new Store(config.DATABASE_PATH);
  const devin = createDevinClient();
  const github = createGitHubClient();
  const orchestrator = deps?.orchestrator ?? new Orchestrator(store, devin, github);
  // Sweep at four times the reconcile interval: frequent enough to catch a
  // dropped webhook quickly, rare enough not to burn GitHub rate limit.
  const scanner = deps?.scanner ?? new Scanner(github, orchestrator, config.RECONCILE_INTERVAL_MS * 4);
  const audit = new AuditRunner(store, devin, github);

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  /**
   * Keep the raw bytes: the webhook HMAC is computed over exactly what GitHub
   * sent, and re-serialising the parsed JSON would produce different bytes
   * (key order, whitespace) and a signature that never validates.
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/metrics' || req.url === '/api/analytics') return; // poll noise
    logger.debug(
      { method: req.method, url: req.url, status: reply.statusCode },
      'request',
    );
  });

  registerDashboardRoutes(app);
  registerWebhookRoutes(app, store, orchestrator);
  registerApiRoutes(app, store, orchestrator, scanner, github, devin, audit);

  return { app, store, orchestrator, scanner, devin, github, audit };
}

async function main(): Promise<void> {
  assertServerConfig();
  const { app, store, orchestrator, scanner, audit } = buildServer();

  orchestrator.start();
  scanner.start();
  // Audits run rarely and finish slowly; polling them on the reconcile beat is
  // more than enough, and it keeps a second scheduler out of the process.
  const auditTimer = setInterval(() => {
    void audit.reconcile();
  }, config.RECONCILE_INTERVAL_MS * 4);
  auditTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    orchestrator.stop();
    scanner.stop();
    clearInterval(auditTimer);
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    {
      port: config.PORT,
      mode: config.DEVIN_MODE,
      repo: `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`,
      label: config.AUTOPILOT_LABEL,
      maxConcurrent: config.MAX_CONCURRENT_SESSIONS,
    },
    `autopilot listening — dashboard on http://localhost:${config.PORT}`,
  );
}

// Only run when executed directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.fatal({ err: err.message }, 'failed to start');
    process.exit(1);
  });
}
