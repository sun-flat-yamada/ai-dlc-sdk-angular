import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { PanelStatusService } from './core/panel-status/panel-status.service';

describe('App', () => {
  it('starts the status polling and renders the status bar', async () => {
    const start = vi.fn();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: PanelStatusService,
          useValue: {
            start,
            status: signal({ deviceName: 'P', firmwareVersion: '1', state: 'ready', alerts: [] }),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    expect(start).toHaveBeenCalledOnce();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-ui-id="status-bar"]')).not.toBeNull();
  });
});
