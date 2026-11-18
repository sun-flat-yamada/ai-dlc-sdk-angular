/** Runtime settings for the front-panel application. */
export const environment = {
  /** Base URL of the device REST API (served by the device firmware). */
  apiBaseUrl: '/api/v1',
  /** Interval for polling the device status, in milliseconds. */
  statusPollIntervalMs: 5000,
  /** Timeout for a single REST API request, in milliseconds. */
  requestTimeoutMs: 8000,
} as const;
