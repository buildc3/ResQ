/**
 * STUB — not wired to a real feed. Documents the intended integration point
 * for IMD Doppler Weather Radar products.
 *
 * Real source (TO BE VERIFIED before relying on this): India Meteorological
 * Department operates a DWR network (https://mausam.imd.gov.in) producing
 * reflectivity (Z) and radial velocity products. Public access to raw/
 * gridded DWR data, its refresh cadence, and licensing terms were not
 * verified in this session (no network access) and must be confirmed
 * against IMD's own documentation before this loader is implemented for
 * real.
 */
import type { DataSourceLoader, RadarFrame } from './index.js';
import { notImplemented } from './index.js';

export const dwrLoader: DataSourceLoader<RadarFrame> = {
  sourceName: 'IMD Doppler Weather Radar',
  accessNotes: 'TO BE VERIFIED: public access terms, refresh cadence, and grid resolution not confirmed in this session.',
  async fetchRange() {
    return notImplemented('DWR');
  },
};
