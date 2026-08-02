import pino from 'pino';
import { config } from './config.js';

/**
 * One structured logger for the whole process. Every remediation-relevant log
 * line carries `issue` and `session` fields so a single grep reconstructs the
 * full lifecycle of any one fix.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'autopilot' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
