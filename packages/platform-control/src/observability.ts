/** Observability primitives for the platform control plane.
 *
 *  Two facts are kept deliberately simple and deployment-replaceable:
 *  - correlation: a request-scoped id that travels with audit entries, metrics and logs so one
 *    employee action can be followed from the HTTP seam to the worker launch;
 *  - metrics: in-process counters/gauges/histograms exposed as a stable JSON snapshot. A central
 *    deployment scrapes or forwards them; this module never claims they survive a restart.
 *
 *  Logging is structured JSON on stderr and never includes raw run input, prompts, credentials or
 *  sealed artifact bytes. It is an operational aid, not the audit record.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CorrelationContext {
  /** Id of the inbound request (honoured from `x-request-id` when it is a safe token). */
  requestId: string;
  /** Id shared by every fact produced while handling it (defaults to requestId). */
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Normalize an inbound correlation header; an unsafe or missing value gets a fresh id. */
export function correlationFromHeader(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && SAFE_ID.test(candidate) ? candidate : `req-${randomUUID()}`;
}

export function runWithCorrelation<T>(context: CorrelationContext, action: () => T): T {
  return storage.run(context, action);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  event: string;
  at: string;
  requestId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Deployment log level; defaults to info and never throws on a bad value. */
export function logLevel(): LogLevel {
  const value = (process.env.PLATFORM_LOG_LEVEL ?? 'info').toLowerCase();
  return value in LEVELS ? (value as LogLevel) : 'info';
}

/** Keys whose values never enter operational logs. */
const REDACTED_KEYS = /^(input|inputs|prompt|body|content|answer|secret|token|password|authorization|apiKey|api_key)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return result;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < LEVELS[logLevel()]) return;
    const correlation = currentCorrelation();
    const entry: LogEntry = {
      level,
      event,
      at: new Date().toISOString(),
      ...(correlation ? { requestId: correlation.requestId, correlationId: correlation.correlationId } : {}),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    try {
      sink(JSON.stringify(entry));
    } catch {
      // Logging must never break the operation it observes.
    }
  };
  return {
    log: emit,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const logger: Logger = createLogger();

/** Bounded metric set: counters, gauges and millisecond histograms with a fixed bucket ladder. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly startedAt = Date.now();
  constructor(private readonly maxSamples = 2048) {}

  static normalize(name: string, labels?: Record<string, string | number | boolean | undefined>): string {
    if (!labels) return name;
    const parts = Object.entries(labels)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .sort();
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }

  counter(name: string, labels?: Record<string, string | number | boolean | undefined>, by = 1): void {
    const key = Metrics.normalize(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, value: number, labels?: Record<string, string | number | boolean | undefined>): void {
    this.gauges.set(Metrics.normalize(name, labels), value);
  }

  observe(name: string, valueMs: number, labels?: Record<string, string | number | boolean | undefined>): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const key = Metrics.normalize(name, labels);
    const samples = this.histograms.get(key) ?? [];
    samples.push(valueMs);
    if (samples.length > this.maxSamples) samples.splice(0, samples.length - this.maxSamples);
    this.histograms.set(key, samples);
  }

  snapshot(): {
    startedAt: string;
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; p50: number; p95: number; p99: number; max: number }>;
  } {
    const histograms: Record<string, { count: number; p50: number; p95: number; p99: number; max: number }> = {};
    for (const [key, samples] of this.histograms) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((left, right) => left - right);
      const at = (percentile: number): number =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))];
      histograms[key] = {
        count: sorted.length,
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(sorted[sorted.length - 1]),
      };
    }
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }

  /** Prometheus text exposition for deployments that already scrape it. */
  text(): string {
    // Counter keys carry `name{label=value,...}`; the exposition format requires quoted values.
    const series = (key: string): string => key.replace(/\{([^}]*)\}/g, (_match, labels: string) =>
      `{${labels.split(',').map((pair) => {
        const index = pair.indexOf('=');
        return index < 0 ? pair : `${pair.slice(0, index)}="${pair.slice(index + 1).replaceAll('"', '\\"')}"`;
      }).join(',')}}`);
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${series(key)} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${series(key)} ${value}`);
    for (const [key, stats] of Object.entries(this.snapshot().histograms)) {
      const base = series(key);
      lines.push(`${base}_count ${stats.count}`);
      lines.push(`${base}_p50_ms ${stats.p50}`);
      lines.push(`${base}_p95_ms ${stats.p95}`);
      lines.push(`${base}_p99_ms ${stats.p99}`);
      lines.push(`${base}_max_ms ${stats.max}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

const round = (value: number): number => Math.round(value * 100) / 100;

export const metrics = new Metrics();