import type { Settings } from "@hbe/settings";
import type { NodeOptions } from "@sentry/node";

/** Where unexpected errors go besides the logs (Sentry when SENTRY_DSN is set). */
export interface ErrorReporter {
  capture(error: unknown, context?: Record<string, string | number | undefined>): void;
  /** Sends what is queued, before the process exits. */
  flush(timeoutMs: number): Promise<void>;
}

export const noErrorReports: ErrorReporter = {
  capture() {},
  flush: async () => {},
};

/**
 * Sentry, sending only the error, its stack and the context given here: no request headers,
 * cookies, bodies or query strings, no breadcrumbs, and people only by id (PDPA; see
 * ARCHITECTURE.md §11). No tracing.
 */
export async function createErrorReporter(
  settings: Settings,
  /** Tests only: where events go instead of Sentry. */
  transport?: NodeOptions["transport"],
): Promise<ErrorReporter> {
  const dsn = settings.env.SENTRY_DSN;
  if (!dsn) return noErrorReports;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    environment: settings.env.HBE_ENV,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    maxBreadcrumbs: 0,
    ...(transport ? { transport } : {}),
    beforeSend(event) {
      delete event.request;
      delete event.extra;
      if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
      return event;
    },
  });
  return {
    capture(error, context) {
      Sentry.withScope((scope) => {
        for (const [key, value] of Object.entries(context ?? {})) {
          if (value !== undefined) scope.setTag(key, String(value));
        }
        Sentry.captureException(error);
      });
    },
    async flush(timeoutMs) {
      await Sentry.flush(timeoutMs);
    },
  };
}
