export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra fields merged into the JSON error body (e.g. a list of problems). */
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (message = "Sign in required") => new HttpError(401, "unauthorized", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
