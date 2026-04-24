/**
 * 轻量结构化日志（stdout JSON）。
 * 支持 child logger 携带默认上下文（例如 `requestId`）。
 */
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const levelFromEnv = (): Level => {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : 'info';
};

let currentLevel: Level = levelFromEnv();

const shouldLog = (level: Level): boolean =>
  LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);

const write = (
  level: Level,
  msg: string,
  context: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void => {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...context,
    ...(extra ?? {}),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

export interface Logger {
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>) => Logger;
  setLevel: (l: Level) => void;
}

const createLogger = (context: Record<string, unknown>): Logger => ({
  debug: (msg, extra) => write('debug', msg, context, extra),
  info: (msg, extra) => write('info', msg, context, extra),
  warn: (msg, extra) => write('warn', msg, context, extra),
  error: (msg, extra) => write('error', msg, context, extra),
  child: (ctx) => createLogger({ ...context, ...ctx }),
  setLevel: (l) => {
    currentLevel = l;
  },
});

export const log: Logger = createLogger({});
