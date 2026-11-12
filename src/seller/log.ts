/**
 * Structured JSON-lines logger with secret scrubbing.
 * Secrets registered via `registerSecret` are replaced with [REDACTED] in every line,
 * and keys that look secret are dropped, as defence in depth: no code path should
 * ever pass a secret here in the first place.
 */
const secrets = new Set<string>();
const SECRET_KEYS = /^(private_?key|privatekey|api_?key|apikey|authorization|secret|mnemonic|raw|rawtx)$/i;

export function registerSecret(s: string | null | undefined): void {
  if (s && s.length >= 8) {
    secrets.add(s);
    if (s.startsWith('0x')) secrets.add(s.slice(2));
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join('[REDACTED]');
    return out.length > 2000 ? out.slice(0, 2000) + '…' : out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    return o;
  }
  return value;
}

export type Level = 'debug' | 'info' | 'warn' | 'error';
let minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let sink: (line: string) => void = (l) => process.stdout.write(l + '\n');

export function setLogSink(fn: (line: string) => void, level: Level = 'debug'): void {
  sink = fn;
  minLevel = level;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg: scrub(msg), ...(scrub(fields) as object) }));
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};
