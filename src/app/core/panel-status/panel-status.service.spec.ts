import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PanelStatus } from './panel-status.model';
import { PanelStatusService } from './panel-status.service';

const status = (state: PanelStatus['state']): PanelStatus => ({
  deviceName: 'Panel-01',
  firmwareVersion: '3.2.0',
  state,
  alerts: [],
});

describe('PanelStatusService', () => {
  let service: PanelStatusService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PanelStatusService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.stop();
    http.verify();
  });

  it('starts offline', () => {
    expect(service.status().state).toBe('offline');
    expect(service.isOperable()).toBe(false);
  });

  it('updates the status from the API', () => {
    service.refresh();
    http.expectOne('/api/v1/status').flush(status('ready'));
    expect(service.status().deviceName).toBe('Panel-01');
    expect(service.isOperable()).toBe(true);
  });

  it('falls back to offline on failure', () => {
    service.refresh();
    http.expectOne('/api/v1/status').flush(null, { status: 500, statusText: 'Error' });
    expect(service.status().state).toBe('offline');
  });

  it('polls until stopped', () => {
    vi.useFakeTimers();
    try {
      service.start(1000);
      http.expectOne('/api/v1/status').flush(status('busy'));
      vi.advanceTimersByTime(1000);
      http.expectOne('/api/v1/status').flush(status('ready'));
      expect(service.isOperable()).toBe(true);
      service.stop();
      vi.advanceTimersByTime(5000);
      http.expectNone('/api/v1/status');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sends a second poll while the first one is still in flight', () => {
    vi.useFakeTimers();
    try {
      service.start(1000);
      const slow = http.expectOne('/api/v1/status');
      vi.advanceTimersByTime(3000); // three polls come due while the device is still answering
      http.expectNone('/api/v1/status');
      slow.flush(status('busy'));
      expect(service.status().state).toBe('busy');
      vi.advanceTimersByTime(1000);
      http.expectOne('/api/v1/status').flush(status('ready'));
      expect(service.isOperable()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the request in flight on stop', () => {
    service.start(1000);
    const pending = http.expectOne('/api/v1/status');
    service.stop();
    expect(pending.cancelled).toBe(true);
    expect(service.status().state).toBe('offline');
  });
});
