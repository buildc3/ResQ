/**
 * STUB — not wired to a real feed. Documents the intended integration point
 * for a ground lightning detection network feed.
 *
 * Real source (TO BE VERIFIED before relying on this): candidates include
 * IMD's Lightning Location Network or a commercial provider — neither the
 * exact feed, its access terms, nor its latency/coverage over Sikkim were
 * verified in this session (no network access). Must be confirmed before
 * this loader is implemented for real.
 */
import type { DataSourceLoader, LightningEvent } from './index.js';
import { notImplemented } from './index.js';

export const lightningLoader: DataSourceLoader<LightningEvent> = {
  sourceName: 'Ground lightning detection network',
  accessNotes: 'TO BE VERIFIED: no specific feed, access terms, or Sikkim coverage confirmed in this session.',
  async fetchRange() {
    return notImplemented('Lightning');
  },
};
