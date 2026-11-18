/** Operating state reported by the device firmware. */
export type DeviceState = 'ready' | 'busy' | 'error' | 'offline';

/** `GET /api/v1/status` response body. */
export interface PanelStatus {
  deviceName: string;
  firmwareVersion: string;
  state: DeviceState;
  /** Active alert codes, newest first. */
  alerts: string[];
}
