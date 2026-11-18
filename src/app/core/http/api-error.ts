import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

/** Error categories every screen handles in the same way. */
export type ApiErrorKind = 'validation' | 'busy' | 'not-found' | 'timeout' | 'offline' | 'server';

/** Normalized REST API error. Every feature receives this type instead of raw HTTP errors. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
    /** Field-level validation messages keyed by request field name (HTTP 400 / 422). */
    readonly fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Converts any error thrown by HttpClient / RxJS into an {@link ApiError}. */
  static from(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }
    if (error instanceof TimeoutError) {
      return new ApiError('timeout', 0, 'The device did not respond in time.');
    }
    if (error instanceof HttpErrorResponse) {
      const body = (error.error ?? {}) as {
        message?: string;
        fieldErrors?: Record<string, string>;
      };
      const message = body.message ?? error.message;
      if (error.status === 0) {
        return new ApiError('offline', 0, 'The device is not reachable.');
      }
      if (error.status === 400 || error.status === 422) {
        return new ApiError('validation', error.status, message, body.fieldErrors ?? {});
      }
      if (error.status === 404) {
        return new ApiError('not-found', 404, message);
      }
      if (error.status === 409 || error.status === 503) {
        return new ApiError('busy', error.status, message);
      }
      return new ApiError('server', error.status, message);
    }
    return new ApiError('server', -1, error instanceof Error ? error.message : String(error));
  }
}
