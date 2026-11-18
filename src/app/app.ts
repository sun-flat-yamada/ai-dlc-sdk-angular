import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PanelStatusService } from './core/panel-status/panel-status.service';
import { StatusBar } from './shared/ui/status-bar/status-bar';

/** Application shell: status bar on top, the active screen below. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, StatusBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-status-bar />
    <main class="screen">
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--panel-width);
      height: var(--panel-height);
    }
    .screen {
      flex: 1;
      overflow: auto;
    }
  `,
})
export class App implements OnInit {
  private readonly panelStatus = inject(PanelStatusService);

  ngOnInit(): void {
    this.panelStatus.start();
  }
}
