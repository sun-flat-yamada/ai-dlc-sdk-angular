import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError, timeout } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiError } from './api-error';

/**
 * Single entry point to the device REST API.
 *
 * - Prefixes every path with `environment.apiBaseUrl`.
 * - Applies the request timeout.
 * - Converts every failure into {@link ApiError}.
 *
 * Feature services MUST use this client instead of injecting HttpClient directly.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  get<T>(path: string): Observable<T> {
    return this.wrap(this.http.get<T>(this.url(path)));
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(this.http.put<T>(this.url(path), body));
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(this.http.post<T>(this.url(path), body));
  }

  delete<T>(path: string): Observable<T> {
    return this.wrap(this.http.delete<T>(this.url(path)));
  }

  private url(path: string): string {
    return `${environment.apiBaseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private wrap<T>(request: Observable<T>): Observable<T> {
    return request.pipe(
      timeout(environment.requestTimeoutMs),
      catchError((error: unknown) => throwError(() => ApiError.from(error))),
    );
  }
}
