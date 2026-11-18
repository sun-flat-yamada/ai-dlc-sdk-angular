import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PanelStatusService } from '../../../core/panel-status/panel-status.service';

const STATE_LABELS: Record<string, string> = {
  ready: '待機中',
  busy: '動作中',
  error: 'エラー',
  offline: '未接続',
};

/** Top status bar shown on every screen: device name, state and alert count. */
@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="status-bar" data-ui-id="status-bar">
      <span class="status-bar__device">{{ status().deviceName }}</span>
      <span
        class="status-bar__state"
        [class]="'status-bar__state status-bar__state--' + status().state"
        data-ui-id="device-state"
        >{{ stateLabel() }}</span
      >
      @if (status().alerts.length > 0) {
        <span class="status-bar__alerts" data-ui-id="alert-count">⚠ {{ status().alerts.length }}</span>
      }
    </header>
  `,
  styles: `
    .status-bar {
      display: flex;
      align-items: center;
      gap: var(--panel-gap);
      height: var(--panel-status-bar-height);
      padding: 0 16px;
      background: var(--panel-color-surface);
      font-size: var(--panel-font-size-sm);
    }
    .status-bar__device {
      flex: 1;
    }
    .status-bar__state--ready {
      color: var(--panel-color-success);
    }
    .status-bar__state--busy {
      color: var(--panel-color-warning);
    }
    .status-bar__state--error,
    .status-bar__state--offline {
      color: var(--panel-color-danger);
    }
    .status-bar__alerts {
      color: var(--panel-color-warning);
    }
  `,
})
export class StatusBar {
  protected readonly status = inject(PanelStatusService).status;
  protected readonly stateLabel = computed(() => STATE_LABELS[this.status().state] ?? this.status().state);
}
