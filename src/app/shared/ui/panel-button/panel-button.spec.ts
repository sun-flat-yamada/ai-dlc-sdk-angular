import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HardwareBridgeService } from '../../hardware-bridge/hardware-bridge.service';
import { PanelButton } from './panel-button';

@Component({
  imports: [PanelButton],
  template: `<app-panel-button
    variant="primary"
    uiId="ok"
    [disabled]="disabled()"
    (pressed)="count = count + 1"
    >OK</app-panel-button
  >`,
})
class Host {
  readonly disabled = signal(false);
  count = 0;
}

describe('PanelButton', () => {
  const beep = vi.fn();

  beforeEach(() => {
    beep.mockReset();
    TestBed.configureTestingModule({
      providers: [{ provide: HardwareBridgeService, useValue: { beep } }],
    });
  });

  it('beeps and emits when pressed', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('[data-ui-id="ok"]') as HTMLButtonElement;

    button.click();

    expect(button.classList).toContain('panel-button--primary');
    expect(button.textContent?.trim()).toBe('OK');
    expect(beep).toHaveBeenCalledWith('click');
    expect(fixture.componentInstance.count).toBe(1);
  });

  it('cannot be pressed while disabled', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
  });
});
