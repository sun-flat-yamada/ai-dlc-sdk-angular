import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PanelStatus } from '../../../core/panel-status/panel-status.model';
import { PanelStatusService } from '../../../core/panel-status/panel-status.service';
import { StatusBar } from './status-bar';

describe('StatusBar', () => {
  const status = signal<PanelStatus>({
    deviceName: 'Panel-01',
    firmwareVersion: '3.2.0',
    state: 'ready',
    alerts: [],
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: PanelStatusService, useValue: { status } }],
    });
  });

  it('shows the device name and the localized state', async () => {
    const fixture = TestBed.createComponent(StatusBar);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Panel-01');
    expect(el.querySelector('[data-ui-id="device-state"]')?.textContent?.trim()).toBe('待機中');
    expect(el.querySelector('[data-ui-id="alert-count"]')).toBeNull();
  });

  it('shows the alert count when alerts exist', async () => {
    status.update((s) => ({ ...s, state: 'error', alerts: ['E-101', 'E-205'] }));
    const fixture = TestBed.createComponent(StatusBar);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-ui-id="device-state"]')?.textContent?.trim()).toBe('エラー');
    expect(el.querySelector('[data-ui-id="alert-count"]')?.textContent).toContain('2');
  });
});
