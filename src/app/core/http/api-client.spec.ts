import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimeoutError, firstValueFrom } from 'rxjs';
import { ApiClient } from './api-client';
import { ApiError } from './api-error';

describe('ApiClient', () => {
  let client: ApiClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('prefixes the API base URL', async () => {
    const result = firstValueFrom(client.get<{ ok: boolean }>('/status'));
    http.expectOne('/api/v1/status').flush({ ok: true });
    expect(await result).toEqual({ ok: true });
  });

  it('sends PUT / POST / DELETE to the same base URL', async () => {
    const done = Promise.all([
      firstValueFrom(client.put('a', { v: 1 })),
      firstValueFrom(client.post('b', { v: 2 })),
      firstValueFrom(client.delete('c')),
    ]);
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/a' });
    expect(put.request.body).toEqual({ v: 1 });
    put.flush({});
    http.expectOne({ method: 'POST', url: '/api/v1/b' }).flush({});
    http.expectOne({ method: 'DELETE', url: '/api/v1/c' }).flush({});
    await expect(done).resolves.toHaveLength(3);
  });

  it('normalizes a 400 response into a validation ApiError', async () => {
    const result = firstValueFrom(client.put('network/ipv4', {}));
    http
      .expectOne('/api/v1/network/ipv4')
      .flush(
        { message: 'invalid', fieldErrors: { address: 'bad' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await expect(result).rejects.toMatchObject({
      kind: 'validation',
      status: 400,
      fieldErrors: { address: 'bad' },
    });
  });

  it('maps a network failure to offline', async () => {
    const offline = firstValueFrom(client.get('status'));
    http.expectOne('/api/v1/status').error(new ProgressEvent('error'), { status: 0 });
    await expect(offline).rejects.toMatchObject({ kind: 'offline' });
  });
});

describe('ApiError.from', () => {
  const http = (status: number) => new HttpErrorResponse({ status, error: { message: 'm' } });

  it.each([
    [404, 'not-found'],
    [409, 'busy'],
    [503, 'busy'],
    [422, 'validation'],
    [500, 'server'],
  ] as const)('maps HTTP %i to %s', (status, kind) => {
    expect(ApiError.from(http(status)).kind).toBe(kind);
  });

  it('maps timeouts and unknown errors', () => {
    expect(ApiError.from(new TimeoutError()).kind).toBe('timeout');
    expect(ApiError.from(new Error('boom'))).toMatchObject({ kind: 'server', message: 'boom' });
    const same = new ApiError('busy', 503, 'x');
    expect(ApiError.from(same)).toBe(same);
  });
});
