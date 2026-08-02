import { config } from '../config.js';
import { logger } from '../logger.js';
import { DevinHttpClient } from './client.js';
import { DevinMockClient } from './mock.js';
import type { DevinClient } from './types.js';

export * from './types.js';
export { DevinHttpClient } from './client.js';
export { DevinMockClient } from './mock.js';

export function createDevinClient(): DevinClient {
  if (config.DEVIN_MODE === 'live') {
    logger.info({ baseUrl: config.DEVIN_API_BASE_URL }, 'devin client: live');
    return new DevinHttpClient({
      apiKey: config.DEVIN_API_KEY!,
      baseUrl: config.DEVIN_API_BASE_URL,
    });
  }
  logger.warn('devin client: mock (no API calls will be made, no ACUs spent)');
  return new DevinMockClient();
}
