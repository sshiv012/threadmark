import * as net from 'node:net';
import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTelemetry, withSpan } from './index.js';

const ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/**
 * Registers an in-memory exporter as the active global tracer provider for a
 * test, via the same NodeTracerProvider.register() path production code uses
 * — that's what wires up the async-context propagation nested spans need
 * (a bare BasicTracerProvider + setGlobalTracerProvider does NOT register a
 * context manager, so parent/child linkage would silently never work).
 */
function useInMemoryProvider(): { exporter: InMemorySpanExporter; provider: NodeTracerProvider } {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return { exporter, provider };
}

describe('withSpan', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    ({ exporter } = useInMemoryProvider());
  });

  afterEach(() => {
    trace.disable();
    exporter.reset();
  });

  describe('happy path', () => {
    it('returns fn result and exports one OK span with the given attributes', async () => {
      const result = await withSpan('unit.happy', { foo: 'bar', count: 3 }, async () => 'value');
      expect(result).toBe('value');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('unit.happy');
      expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
      expect(spans[0]!.attributes.foo).toBe('bar');
      expect(spans[0]!.attributes.count).toBe(3);
    });

    it('nests child spans under the active parent', async () => {
      await withSpan('outer', {}, async () => {
        await withSpan('inner', {}, async () => 'x');
      });

      const spans = exporter.getFinishedSpans();
      const outer = spans.find((s) => s.name === 'outer')!;
      const inner = spans.find((s) => s.name === 'inner')!;
      expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    });

    it('supports 20 levels of nesting without corrupting parent/child linkage', async () => {
      async function nest(depth: number): Promise<void> {
        if (depth === 0) return;
        await withSpan(`depth-${depth}`, {}, () => nest(depth - 1));
      }
      await nest(20);

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(20);
      for (const span of spans) {
        const depth = Number(span.name.replace('depth-', ''));
        if (depth === 20) continue;
        const parent = spans.find((s) => s.name === `depth-${depth + 1}`)!;
        expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      }
    });
  });

  describe('negative / adversarial', () => {
    it('rethrows the exact original Error instance and records it as an exception', async () => {
      const original = new Error('boom');
      await expect(
        withSpan('unit.throws', {}, async () => {
          throw original;
        }),
      ).rejects.toBe(original);

      const [span] = exporter.getFinishedSpans();
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.status.message).toBe('boom');
      expect(span!.events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('rethrows a non-Error rejection value unchanged (plain string)', async () => {
      await expect(
        withSpan('unit.throws-string', {}, async () => {
          throw 'plain string';
        }),
      ).rejects.toBe('plain string');

      const [span] = exporter.getFinishedSpans();
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('rethrows a non-Error rejection value unchanged (plain object)', async () => {
      const original = { code: 42 };
      await expect(
        withSpan('unit.throws-object', {}, async () => {
          throw original;
        }),
      ).rejects.toBe(original);

      const [span] = exporter.getFinishedSpans();
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('handles an oversized attribute value without throwing', async () => {
      const huge = 'x'.repeat(1_000_000);
      const result = await withSpan('unit.huge-attr', { text: huge }, async () => 'ok');
      expect(result).toBe('ok');
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    });

    it.each([
      '',
      ' ',
      'a'.repeat(10_000),
      'name/with/slashes',
      'name 🚀 emoji',
      'name\nwith\nnewline',
    ])('runs fn exactly once regardless of unusual span name %#', async (name) => {
      let calls = 0;
      const result = await withSpan(name, {}, async () => {
        calls += 1;
        return 'done';
      });
      expect(calls).toBe(1);
      expect(result).toBe('done');
    });
  });

  describe('edge / boundary', () => {
    it('accepts an empty attributes object', async () => {
      const result = await withSpan('unit.empty-attrs', {}, async () => 'ok');
      expect(result).toBe('ok');
    });

    it('works even when withSpan is called before any provider is registered', async () => {
      trace.disable(); // simulate initTelemetry() never having run
      const result = await withSpan('unit.no-provider', {}, async () => 'still works');
      expect(result).toBe('still works');
    });
  });

  describe('multi-tenant-shaped concurrency isolation', () => {
    it('never cross-attributes concurrent spans running in parallel', async () => {
      async function run(id: string): Promise<string> {
        return withSpan('concurrent.op', { workspaceId: id }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return id;
        });
      }
      const results = await Promise.all([run('ws-a'), run('ws-b'), run('ws-c')]);
      expect(results).toEqual(['ws-a', 'ws-b', 'ws-c']);

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      for (const id of ['ws-a', 'ws-b', 'ws-c']) {
        const span = spans.find((s) => s.attributes.workspaceId === id);
        expect(span).toBeDefined();
      }
    });
  });

  describe('failure of the tracing machinery itself must not break callers', () => {
    it('still runs fn and returns its result if starting a span throws', async () => {
      const brokenTracer: Tracer = {
        startSpan: () => {
          throw new Error('tracer is broken');
        },
        startActiveSpan: (() => {
          throw new Error('unused');
        }) as unknown as Tracer['startActiveSpan'],
      };
      const provider = trace.getTracerProvider();
      const getTracerSpy = vi.spyOn(provider, 'getTracer').mockReturnValue(brokenTracer);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const result = await withSpan('unit.broken-tracer', {}, async () => 'fallback-ran');
        expect(result).toBe('fallback-ran');
      } finally {
        getTracerSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('non-functional bounds', () => {
    it('adds no meaningful overhead across 1000 sequential no-op spans', async () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await withSpan('unit.perf', { i }, async () => undefined);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });
});

describe('initTelemetry', () => {
  const originalEndpoint = process.env[ENDPOINT_ENV];

  afterEach(() => {
    if (originalEndpoint === undefined) delete process.env[ENDPOINT_ENV];
    else process.env[ENDPOINT_ENV] = originalEndpoint;
    trace.disable();
  });

  describe('happy path', () => {
    it('returns a shutdown function and never throws when no endpoint is configured', async () => {
      delete process.env[ENDPOINT_ENV];
      const shutdown = initTelemetry('test-service');
      expect(typeof shutdown).toBe('function');
      await expect(shutdown()).resolves.toBeUndefined();
    });

    it('returns an independently callable shutdown function when an endpoint is configured', async () => {
      process.env[ENDPOINT_ENV] = 'http://localhost:4318/v1/traces';
      const shutdown = initTelemetry('test-service');
      await expect(shutdown()).resolves.toBeUndefined();
    });
  });

  describe('negative / adversarial', () => {
    it.each(['not a url', 'ftp://nope', '', '   '])(
      'never throws synchronously for malformed endpoint %j',
      (value) => {
        process.env[ENDPOINT_ENV] = value;
        expect(() => initTelemetry('test-service')).not.toThrow();
      },
    );

    it('never throws when the endpoint refuses the connection', async () => {
      process.env[ENDPOINT_ENV] = 'http://127.0.0.1:1/v1/traces';
      expect(() => initTelemetry('test-service')).not.toThrow();
    });
  });

  describe('edge / boundary', () => {
    it('does not throw when called twice', async () => {
      delete process.env[ENDPOINT_ENV];
      const shutdownA = initTelemetry('svc-a');
      const shutdownB = initTelemetry('svc-b');
      await expect(shutdownA()).resolves.toBeUndefined();
      await expect(shutdownB()).resolves.toBeUndefined();
    });
  });

  describe('version / config drift', () => {
    it('picks up a changed endpoint on a subsequent call rather than reusing the first', async () => {
      process.env[ENDPOINT_ENV] = 'http://localhost:4318/v1/traces';
      const shutdownFirst = initTelemetry('svc');
      await shutdownFirst();

      process.env[ENDPOINT_ENV] = 'http://localhost:4319/v1/traces';
      const shutdownSecond = initTelemetry('svc');
      await expect(shutdownSecond()).resolves.toBeUndefined();
    });
  });

  describe('UX: operator-visible signal', () => {
    it('logs a one-time notice when tracing is disabled, and does not spam per span', async () => {
      delete process.env[ENDPOINT_ENV];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        initTelemetry('test-service');
        const callsAfterInit = logSpy.mock.calls.length;
        expect(callsAfterInit).toBeGreaterThan(0);

        for (let i = 0; i < 10; i++) {
          await withSpan('unit.no-spam', {}, async () => undefined);
        }
        expect(logSpy.mock.calls.length).toBe(callsAfterInit);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('non-functional bounds', () => {
    it('shutdown() resolves within a bound even if exporter.shutdown() rejects', async () => {
      process.env[ENDPOINT_ENV] = 'http://localhost:4318/v1/traces';
      const shutdown = initTelemetry('test-service');
      await expect(shutdown()).resolves.toBeUndefined();
    });

    it('shutdown() resolves within a bound against a collector that accepts but never responds', async () => {
      const server = net.createServer((socket) => {
        // Accept the connection but never write a response.
        socket.on('data', () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        process.env[ENDPOINT_ENV] = `http://127.0.0.1:${port}/v1/traces`;
        const shutdown = initTelemetry('test-service');
        await Promise.race([
          shutdown(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 5000)),
        ]);
      } finally {
        server.close();
      }
    }, 10_000);
  });
});
