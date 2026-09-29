/**
 * Real data-source adapter interface for the SIH26084 pivot — documented
 * schema and stub implementations only. NOT wired into the build in
 * Milestone 1: everything the pipeline generates comes from
 * ../convection.ts's seeded simulator, never from these loaders.
 *
 * Every stub throws if actually called, so a future engineer can't
 * accidentally ship a silent no-op mistaken for real data.
 */

export interface RadarFrame {
  timestamp: string;
  // Per-pixel/per-cell reflectivity (dBZ) and radial velocity (m/s),
  // already regridded to the common grid — see ../grid.ts for cell ids.
  cells: { cell_id: string; reflectivity_dbz: number; radial_velocity_ms: number }[];
}
export interface SatelliteFrame {
  timestamp: string;
  cells: { cell_id: string; ir_brightness_k: number }[];
}
export interface LightningEvent {
  lat: number;
  lon: number;
  time: string;
}

export interface DataSourceLoader<T> {
  /** Human-readable name of the real source this loader targets. */
  readonly sourceName: string;
  /** Access terms/endpoint — TO BE VERIFIED before this loader is used for anything real. */
  readonly accessNotes: string;
  fetchRange(startIso: string, endIso: string): Promise<T[]>;
}

function notImplemented(sourceName: string): never {
  throw new Error(`${sourceName} loader is a documented stub only — not wired to a real feed. See pipeline/sources/${sourceName.toLowerCase()}.ts.`);
}

export { notImplemented };
