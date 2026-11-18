import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { PanelStatusService } from '../../core/panel-status/panel-status.service';
import { HardwareBridgeService } from '../../shared/hardware-bridge/hardware-bridge.service';
import { HOME_MENU, HomePage } from './home-page';

describe('HomePage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: HardwareBridgeService, useValue: { beep: vi.fn() } },
        {
          provide: PanelStatusService,
          useValue: {
            status: signal({ deviceName: 'P', firmwareVersion: '3.2.0', state: 'ready', alerts: [] }),
          },
        },
      ],
    });
  });

  it('renders the firmware version and one button per menu item', async () => {
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-ui-id="firmware-version"]')?.textContent).toContain('3.2.0');
    expect(el.querySelectorAll('button')).toHaveLength(HOME_MENU.length);
  });

  it('navigates to the route of the pressed item', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();

    (fixture.nativeElement.querySelector('[data-ui-id="menu-network"]') as HTMLButtonElement).click();

    expect(navigate).toHaveBeenCalledWith(HOME_MENU[0]!.route);
  });
});
