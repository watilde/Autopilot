import { config } from '../config.js';
import { logger } from '../logger.js';
import { DevinV1Client } from './client-v1.js';
import { DevinV3Client } from './client-v3.js';
import { DevinMockClient } from './mock.js';
import { inferApiVersion, type DevinClient } from './types.js';

export * from './types.js';
export { DevinV1Client, normalizeV1 } from './client-v1.js';
export { DevinV3Client, normalizeV3 } from './client-v3.js';
export { DevinMockClient } from './mock.js';

/**
 * Picks a client from the credential rather than making the operator declare
 * it. Using a `cog_` key against v1 fails with a bare 403 and no explanation,
 * which is a miserable thing to debug at deploy time — so infer, log the
 * choice, and fail with an actionable message when v3 is missing its org id.
 */
export function createDevinClient(): DevinClient {
  if (config.DEVIN_MODE !== 'live') {
    logger.warn('devin client: mock (no API calls will be made, no ACUs spent)');
    return new DevinMockClient();
  }

  const apiKey = config.DEVIN_API_KEY!;
  const version = config.DEVIN_API_VERSION ?? inferApiVersion(apiKey);
  const baseUrl = config.DEVIN_API_BASE_URL.replace(/\/v[13]\/?$/, '');

  if (version === 'v3') {
    if (!config.DEVIN_ORG_ID) {
      throw new Error(
        'DEVIN_ORG_ID is required for the v3 API.\n' +
          '  Your key starts with "cog_", which is a v3 service-user credential.\n' +
          '  Find the organization id (org-…) under Settings → Service Users.',
      );
    }
    logger.info({ baseUrl, orgId: config.DEVIN_ORG_ID }, 'devin client: live (v3)');
    return new DevinV3Client({ apiKey, baseUrl: `${baseUrl}/v3`, orgId: config.DEVIN_ORG_ID });
  }

  logger.info({ baseUrl }, 'devin client: live (v1, deprecated)');
  return new DevinV1Client({ apiKey, baseUrl: `${baseUrl}/v1` });
}
