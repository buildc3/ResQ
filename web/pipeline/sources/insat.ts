/**
 * STUB — not wired to a real feed. Documents the intended integration point
 * for INSAT-3D/3DR geostationary IR imagery.
 *
 * Real source (TO BE VERIFIED before relying on this): MOSDAC
 * (https://mosdac.gov.in) distributes INSAT-3D/3DR Level-1/1.5 imagery,
 * including thermal IR bands usable for brightness-temperature nowcasting.
 * Access typically requires a MOSDAC account and product-specific request —
 * exact cadence, resolution, latency, and license terms were not verified in
 * this session (no network access) and must be confirmed against MOSDAC's
 * own documentation before this loader is implemented for real.
 */
import type { DataSourceLoader, SatelliteFrame } from './index.js';
import { notImplemented } from './index.js';

export const insatLoader: DataSourceLoader<SatelliteFrame> = {
  sourceName: 'INSAT-3D/3DR IR (MOSDAC)',
  accessNotes: 'TO BE VERIFIED: MOSDAC account + product access terms, cadence, and resolution not confirmed in this session.',
  async fetchRange() {
    return notImplemented('INSAT');
  },
};
