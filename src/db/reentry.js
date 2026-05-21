// src/db/reentry.js
// CRUD for reentry_watchlist — tracks mints to re-enter after SL exit.

import { db } from './connection.js';
import { now } from '../utils.js';

/**
 * Insert a new re-entry watch for a mint that just hit SL.
 */
export function insertReentryWatch({ mint, originalPositionId, entryMcap, slMcap, windowMs = 86400000 }) {
  const stoppedAt = now();
  const expiresAt = stoppedAt + windowMs;
  db.prepare(`
    INSERT INTO reentry_watchlist
      (mint, original_position_id, entry_mcap, sl_mcap, stopped_at_ms, expires_at_ms, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(mint, originalPositionId, entryMcap, slMcap, stoppedAt, expiresAt, stoppedAt);
}

/**
 * Get the active (non-expired, non-triggered) re-entry watch for a mint.
 * Returns null if none exists.
 */
export function getActiveReentryWatch(mint) {
  return db.prepare(`
    SELECT * FROM reentry_watchlist
    WHERE mint = ?
      AND reentry_triggered = 0
      AND expires_at_ms > ?
    ORDER BY created_at_ms DESC
    LIMIT 1
  `).get(mint, now()) || null;
}

/**
 * Mark a re-entry watch as triggered with the new position ID.
 */
export function markReentryTriggered(id, reentryPositionId) {
  db.prepare(`
    UPDATE reentry_watchlist
    SET reentry_triggered = 1, reentry_position_id = ?
    WHERE id = ?
  `).run(reentryPositionId, id);
}

/**
 * Prune expired and triggered watches older than 48h.
 */
export function pruneReentryWatches() {
  const cutoff = now() - 48 * 60 * 60 * 1000;
  db.prepare(`
    DELETE FROM reentry_watchlist
    WHERE (expires_at_ms < ? OR reentry_triggered = 1)
      AND created_at_ms < ?
  `).run(now(), cutoff);
}

/**
 * Get all active watches (for diagnostics).
 */
export function activeReentryWatches() {
  return db.prepare(`
    SELECT * FROM reentry_watchlist
    WHERE reentry_triggered = 0 AND expires_at_ms > ?
    ORDER BY created_at_ms DESC
  `).all(now());
}
