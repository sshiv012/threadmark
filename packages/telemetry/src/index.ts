/**
 * @threadmark/telemetry — OpenTelemetry primitives shared by every runtime
 * (worker activities today, a future agent step-loop later). Two exports
 * only: `initTelemetry` bootstraps trace export for a process, `withSpan`
 * wraps an async operation in a span. Both must be safe to call even if the
 * other was never invoked — a package that unit-tests `withSpan` without
 * calling `initTelemetry` first must still get a valid (if inert) span.
 */
import { SpanStatusCode, context, trace, type Attributes, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export const PACKAGE_NAME = '@threadmark/telemetry';

const TRACER_NAME = '@threadmark/telemetry';

/**
 * Bootstrap trace export for this process. Reads OTEL_EXPORTER_OTLP_ENDPOINT;
 * when unset (the default until an operator opts in), registers a provider
 * with no exporter — spans are created and end normally, nothing is sent
 * anywhere, and no network I/O is attempted. Never throws synchronously, even
 * for a malformed endpoint value. Returns a shutdown function that flushes
 * and closes the provider; safe to call multiple times / from multiple
 * initTelemetry() calls.
 */
export function initTelemetry(serviceName: string): () => Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

  let provider: NodeTracerProvider;
  try {
    if (endpoint && endpoint.trim() !== '') {
      const exporter = new OTLPTraceExporter({ url: endpoint });
      provider = new NodeTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
    } else {
      provider = new NodeTracerProvider({ resource, spanProcessors: [] });
      console.log(
        `[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled for "${serviceName}"`,
      );
    }
    provider.register();
  } catch (error) {
    console.warn('[telemetry] initTelemetry failed, tracing disabled:', error);
    return () => Promise.resolve();
  }

  return async () => {
    try {
      await provider.shutdown();
    } catch (error) {
      console.warn('[telemetry] provider shutdown failed:', error);
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * Run `fn` inside a span named `name` with `attributes`. Never puts raw
 * evidence/query/prompt text on a span — callers must only pass ids, counts,
 * lengths, and model/provider names as attributes.
 *
 * On success: span status OK. On error: records the exception, sets span
 * status ERROR, then rethrows the EXACT original error/value unchanged —
 * this is a transparent wrapper, never a fail-open swallow (unlike this
 * codebase's Redis cache, which does swallow errors as an optimization).
 *
 * Safe to call before initTelemetry() (falls back to the OTel API's own
 * global no-op provider) and safe even if the tracer itself is broken (runs
 * `fn` unspanned rather than let telemetry become an availability dependency).
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  try {
    span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes });
  } catch (error) {
    console.warn('[telemetry] failed to start span, continuing unspanned:', error);
    return fn(undefined);
  }

  const activeContext = trace.setSpan(context.active(), span);
  try {
    const result = await context.with(activeContext, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
    throw error;
  } finally {
    span.end();
  }
}
