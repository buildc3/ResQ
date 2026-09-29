/**
 * Common gridded domain for the convective nowcast (SIH26084). Bounds are
 * derived from the existing station registry (stations.ts) rather than
 * hardcoded, so the grid always covers exactly the area this project already
 * has real geography for. Cell size is ~1.5km — fine enough to be a
 * meaningful "1-3km resolution" demo, coarse enough to keep the exported
 * JSON small on a static site with no backend to page data from.
 */
import { STATIONS } from './stations.js';

const LAT_PAD_DEG = 0.05; // ~5.5km margin so storm cells can exist just outside the station ring
const LON_PAD_DEG = 0.06;

const lats = STATIONS.map((s) => s.lat);
const lons = STATIONS.map((s) => s.lon);

export const GRID_LAT_MIN = Math.min(...lats) - LAT_PAD_DEG;
export const GRID_LAT_MAX = Math.max(...lats) + LAT_PAD_DEG;
export const GRID_LON_MIN = Math.min(...lons) - LON_PAD_DEG;
export const GRID_LON_MAX = Math.max(...lons) + LON_PAD_DEG;

// ~1.5km in degrees at this latitude (1 deg lat ~= 111km everywhere;
// 1 deg lon ~= 111km * cos(latitude), narrower this far north).
const MEAN_LAT_RAD = ((GRID_LAT_MIN + GRID_LAT_MAX) / 2) * (Math.PI / 180);
export const CELL_SIZE_LAT_DEG = 1.5 / 111;
export const CELL_SIZE_LON_DEG = 1.5 / (111 * Math.cos(MEAN_LAT_RAD));

export interface GridCell {
  id: string;
  row: number;
  col: number;
  lat: number; // cell center
  lon: number;
}

function buildGrid(): GridCell[] {
  const rows = Math.ceil((GRID_LAT_MAX - GRID_LAT_MIN) / CELL_SIZE_LAT_DEG);
  const cols = Math.ceil((GRID_LON_MAX - GRID_LON_MIN) / CELL_SIZE_LON_DEG);
  const cells: GridCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        id: `${row}_${col}`,
        row,
        col,
        lat: GRID_LAT_MIN + (row + 0.5) * CELL_SIZE_LAT_DEG,
        lon: GRID_LON_MIN + (col + 0.5) * CELL_SIZE_LON_DEG,
      });
    }
  }
  return cells;
}

export const GRID_CELLS: GridCell[] = buildGrid();
export const GRID_ROWS = Math.max(...GRID_CELLS.map((c) => c.row)) + 1;
export const GRID_COLS = Math.max(...GRID_CELLS.map((c) => c.col)) + 1;

export function cellIndexAt(lat: number, lon: number): { row: number; col: number } {
  const row = Math.floor((lat - GRID_LAT_MIN) / CELL_SIZE_LAT_DEG);
  const col = Math.floor((lon - GRID_LON_MIN) / CELL_SIZE_LON_DEG);
  return { row, col };
}

export function neighborsOf(row: number, col: number, radius = 1): GridCell[] {
  return GRID_CELLS.filter((c) => Math.abs(c.row - row) <= radius && Math.abs(c.col - col) <= radius);
}

/** Fixed 10-minute-step lead-time axis, T+0..T+6h — structural only in
 *  Milestone 1 (see forecast placeholder note in pipeline/README/app.js);
 *  no pipeline data is generated for lead > 0 yet. */
export const LEAD_TIME_MINUTES: number[] = Array.from({ length: 37 }, (_, i) => i * 10);
