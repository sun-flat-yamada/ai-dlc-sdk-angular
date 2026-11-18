import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PanelButton } from '../../shared/ui/panel-button/panel-button';
import { PanelStatusService } from '../../core/panel-status/panel-status.service';

/** One tile of the home menu. */
export interface HomeMenuItem {
  id: string;
  label: string;
  route: string;
}

/** Menu entries. New feature screens append an entry here (extensible list). */
export const HOME_MENU: readonly HomeMenuItem[] = [
  { id: 'network', label: 'ネットワーク設定', route: '/network-legacy' },
];

/** Home screen: device summary and the menu of setting screens. */
@Component({
  selector: 'app-home-page',
  imports: [PanelButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="home" data-ui-id="home-page">
      <h1 class="home__title">メニュー</h1>
      <p class="home__firmware" data-ui-id="firmware-version">
        ファームウェア {{ status().firmwareVersion }}
      </p>
      <nav class="home__menu">
        @for (item of menu; track item.id) {
          <app-panel-button [uiId]="'menu-' + item.id" (pressed)="open(item)">
            {{ item.label }}
          </app-panel-button>
        }
      </nav>
    </section>
  `,
  styles: `
    .home {
      padding: 16px;
    }
    .home__title {
      margin: 0 0 4px;
      font-size: var(--panel-font-size-lg);
    }
    .home__firmware {
      margin: 0 0 16px;
      color: var(--panel-color-text-muted);
      font-size: var(--panel-font-size-sm);
    }
    .home__menu {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--panel-gap);
    }
  `,
})
export class HomePage {
  private readonly router = inject(Router);
  protected readonly status = inject(PanelStatusService).status;
  protected readonly menu = HOME_MENU;

  protected open(item: HomeMenuItem): void {
    void this.router.navigateByUrl(item.route);
  }
}
