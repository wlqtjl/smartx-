/**
 * 轻量结构化日志（stdout JSON）。
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

const write = (level: Level, msg: string, extra?: Record<string, unknown>): void => {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
  setLevel: (l: Level): void => {
    currentLevel = l;
  },
};
