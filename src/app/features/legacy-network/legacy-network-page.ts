import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * LEGACY placeholder for the network settings screen.
 * Read-only text without REST API integration. Scheduled to be replaced by
 * `features/network-settings/` (see .ai-dlc/inputs/requirements/). DELETABLE.
 */
@Component({
  selector: 'app-legacy-network-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="legacy" data-ui-id="legacy-network-page">
      <h1>ネットワーク設定 (旧)</h1>
      <p>この画面は廃止予定です。設定はサービスツールから変更してください。</p>
      <a routerLink="/">戻る</a>
    </section>
  `,
  styles: `
    .legacy {
      padding: 16px;
    }
    a {
      color: var(--panel-color-primary);
    }
  `,
})
export class LegacyNetworkPage {}
