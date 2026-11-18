import { TestBed } from '@angular/core/testing';
import {
  HardwareBridgeService,
  NATIVE_PANEL_BRIDGE,
  NativePanelBridge,
} from './hardware-bridge.service';

describe('HardwareBridgeService', () => {
  it('is a no-op without a native bridge', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: NATIVE_PANEL_BRIDGE, useValue: null }],
    });
    const service = TestBed.inject(HardwareBridgeService);
    expect(service.isNative).toBe(false);
    expect(() => service.beep()).not.toThrow();
    expect(() => service.setBacklight(50)).not.toThrow();
  });

  it('forwards calls to the native bridge and clamps the backlight', () => {
    const bridge: NativePanelBridge = { beep: vi.fn(), setBacklight: vi.fn() };
    TestBed.configureTestingModule({
      providers: [{ provide: NATIVE_PANEL_BRIDGE, useValue: bridge }],
    });
    const service = TestBed.inject(HardwareBridgeService);

    service.beep('error');
    service.setBacklight(150);
    service.setBacklight(-3);

    expect(service.isNative).toBe(true);
    expect(bridge.beep).toHaveBeenCalledWith('error');
    expect(bridge.setBacklight).toHaveBeenNthCalledWith(1, 100);
    expect(bridge.setBacklight).toHaveBeenNthCalledWith(2, 0);
  });
});
