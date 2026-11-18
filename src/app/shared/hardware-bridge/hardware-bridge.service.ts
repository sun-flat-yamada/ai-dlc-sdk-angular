import { Injectable, InjectionToken, inject } from '@angular/core';

/** Sounds the device buzzer can play. */
export type BuzzerTone = 'click' | 'accept' | 'error';

/**
 * Native bridge exposed by the device firmware on `window.panelBridge`.
 * Absent when the application runs in a desktop browser.
 */
export interface NativePanelBridge {
  beep(tone: BuzzerTone): void;
  setBacklight(level: number): void;
}

/** Resolves the native bridge; tests replace it with a fake. */
export const NATIVE_PANEL_BRIDGE = new InjectionToken<NativePanelBridge | null>(
  'NATIVE_PANEL_BRIDGE',
  {
    providedIn: 'root',
    factory: () => (globalThis as { panelBridge?: NativePanelBridge }).panelBridge ?? null,
  },
);

/**
 * Hardware access for the front panel (buzzer, backlight).
 * Every touch feedback MUST go through this service so that the behaviour
 * is identical on the device and is a no-op in a browser.
 */
@Injectable({ providedIn: 'root' })
export class HardwareBridgeService {
  private readonly bridge = inject(NATIVE_PANEL_BRIDGE);

  /** True when the application runs on the real device. */
  get isNative(): boolean {
    return this.bridge !== null;
  }

  /** Plays a buzzer tone. No-op outside the device. */
  beep(tone: BuzzerTone = 'click'): void {
    this.bridge?.beep(tone);
  }

  /** Sets the backlight level, clamped to 0-100. */
  setBacklight(level: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    this.bridge?.setBacklight(clamped);
  }
}
