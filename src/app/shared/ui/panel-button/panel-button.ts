import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { HardwareBridgeService } from '../../hardware-bridge/hardware-bridge.service';

/** Visual variants of {@link PanelButton}. */
export type PanelButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * Touch button for the front panel.
 * Guarantees the minimum touch target size and plays the click tone.
 *
 * Usage: `<app-panel-button variant="primary" (pressed)="save()">保存</app-panel-button>`
 */
@Component({
  selector: 'app-panel-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [class]="'panel-button panel-button--' + variant()"
      [disabled]="disabled()"
      [attr.data-ui-id]="uiId()"
      (click)="press()"
    >
      <ng-content />
    </button>
  `,
  styles: `
    .panel-button {
      min-width: var(--panel-touch-target-min);
      min-height: var(--panel-touch-target-min);
      padding: 0 20px;
      border: none;
      border-radius: var(--panel-radius);
      font: inherit;
      color: var(--panel-color-text);
      background: var(--panel-color-surface-raised);
    }
    .panel-button--primary {
      background: var(--panel-color-primary);
    }
    .panel-button--danger {
      background: var(--panel-color-danger);
    }
    .panel-button:disabled {
      opacity: 0.4;
    }
  `,
})
export class PanelButton {
  private readonly hardware = inject(HardwareBridgeService);

  readonly variant = input<PanelButtonVariant>('secondary');
  readonly disabled = input(false);
  /** Design ID (`data-ui-id`) from ui-bindings.yaml; also used by subsystem tests. */
  readonly uiId = input<string | null>(null);
  readonly pressed = output<void>();

  protected press(): void {
    this.hardware.beep('click');
    this.pressed.emit();
  }
}
