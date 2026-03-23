/**
 * Structured logger for HANDLED.
 *
 * In development: coloured human-readable output.
 * In production:  JSON lines — easy to parse in Railway's log viewer
 *                 and ingest into Datadog / Logtail / etc.
 *
 * Usage:
 *   import { logger } from './lib/logger';
 *   logger.info('SMS sent', { to: '+447700...', sid: 'SM...' });
 *   logger.error('Twilio failed', { error: err.message, owner_id });
 *
 * Child loggers carry context automatically:
 *   const log = logger.child({ owner_id: '...' });
 *   log.info('Job created', { job_id });  // includes owner_id in every line
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

const MIN_LEVEL: Level =
  (process.env.LOG_LEVEL as Level | undefined) ??
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const IS_PROD = process.env.NODE_ENV === 'production';

// Terminal colours (dev only)
const COLOURS: Record<Level, string> = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function formatDev(level: Level, msg: string, fields: Fields): string {
  const prefix = `${COLOURS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  const extras = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : '';
  return `${prefix} ${msg}${extras}`;
}

function formatProd(level: Level, msg: string, fields: Fields): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
}

class Logger {
  private context: Fields;

  constructor(context: Fields = {}) {
    this.context = context;
  }

  private write(level: Level, msg: string, fields: Fields = {}): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

    const merged = { ...this.context, ...fields };
    const line = IS_PROD
      ? formatProd(level, msg, merged)
      : formatDev(level, msg, merged);

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(msg: string, fields?: Fields): void { this.write('debug', msg, fields); }
  info (msg: string, fields?: Fields): void { this.write('info',  msg, fields); }
  warn (msg: string, fields?: Fields): void { this.write('warn',  msg, fields); }
  error(msg: string, fields?: Fields): void { this.write('error', msg, fields); }

  /** Returns a new Logger that always includes `context` in every log line. */
  child(context: Fields): Logger {
    return new Logger({ ...this.context, ...context });
  }
}

export const logger = new Logger();
