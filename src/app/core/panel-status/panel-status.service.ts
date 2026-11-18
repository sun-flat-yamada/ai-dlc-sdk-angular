import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { ApiClient } from '../http/api-client';
import { PanelStatus } from './panel-status.model';

const OFFLINE_STATUS: PanelStatus = {
  deviceName: '—',
  firmwareVersion: '—',
  state: 'offline',
  alerts: [],
};

/**
 * Polls `GET /api/v1/status` and exposes the device status as signals.
 * Shared by the status bar and every feature screen.
 */
@Injectable({ providedIn: 'root' })
export class PanelStatusService {
  private readonly api = inject(ApiClient);
  private readonly current = signal<PanelStatus>(OFFLINE_STATUS);
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Latest device status (`offline` until the first successful poll). */
  readonly status = this.current.asReadonly();
  /** True while the device accepts operations from the panel. */
  readonly isOperable = computed(() => this.current().state === 'ready');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Starts polling. Calling it again restarts the timer. */
  start(intervalMs: number = environment.statusPollIntervalMs): void {
    this.stop();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Fetches the status once. Failures switch the status to `offline`. */
  refresh(): void {
    this.api.get<PanelStatus>('status').subscribe({
      next: (status) => this.current.set(status),
      error: () => this.current.set(OFFLINE_STATUS),
    });
  }
}
