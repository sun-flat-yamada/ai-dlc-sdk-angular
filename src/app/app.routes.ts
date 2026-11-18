import { Routes } from '@angular/router';

/**
 * Application routes. EXTENSIBLE: append new feature routes; do not change existing entries.
 * Feature screens are lazy-loaded to keep the initial bundle small on the device.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/home/home-page').then((m) => m.HomePage),
  },
  {
    path: 'network-legacy',
    loadComponent: () =>
      import('./features/legacy-network/legacy-network-page').then((m) => m.LegacyNetworkPage),
  },
  { path: '**', redirectTo: '' },
];
