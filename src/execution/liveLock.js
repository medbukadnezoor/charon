import Database from 'better-sqlite3';
import { DB_PATH, INSTANCE_ID } from '../config.js';
import { now } from '../utils.js';
import { boolSetting, numSetting } from '../db/settings.js';

let lockDb = null;

function lockDbPath() {
  return process.env.GLOBAL_LIVE_LOCK_DB_PATH || DB_PATH;
}

export function getLiveLockDb() {
  if (!lockDb) {
    lockDb = new Database(lockDbPath());
    lockDb.pragma('journal_mode = WAL');
    lockDb.exec(`
      CREATE TABLE IF NOT EXISTS live_execution_locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        lane TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        amount_sol REAL NOT NULL,
        position_id INTEGER,
        reason TEXT,
        acquired_at_ms INTEGER NOT NULL,
        released_at_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_live_execution_locks_open_mint ON live_execution_locks(mint) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_live_execution_locks_status ON live_execution_locks(status, acquired_at_ms);
    `);
  }
  return lockDb;
}

export function closeLiveLockDbForTests() {
  if (!lockDb) return;
  lockDb.close();
  lockDb = null;
}

export function acquireLiveExecutionLock({
  mint,
  amountSol,
  lane = INSTANCE_ID,
  maxOpenSol = numSetting('global_live_lock_max_open_sol', 0.08),
  enabled = boolSetting('global_live_lock_enabled', true),
} = {}) {
  if (!enabled) return { acquired: true, disabled: true };
  if (!mint) return { acquired: false, reason: 'missing_mint' };
  const db = getLiveLockDb();
  return db.transaction(() => {
    const duplicate = db.prepare(`
      SELECT id, lane FROM live_execution_locks
      WHERE mint = ? AND status = 'open'
      LIMIT 1
    `).get(mint);
    if (duplicate) {
      return { acquired: false, reason: 'duplicate_mint_lock', existingLockId: duplicate.id, existingLane: duplicate.lane };
    }

    const open = db.prepare(`
      SELECT COALESCE(SUM(amount_sol), 0) AS total
      FROM live_execution_locks
      WHERE status = 'open'
    `).get();
    const totalAfter = Number(open?.total || 0) + Number(amountSol || 0);
    if (maxOpenSol > 0 && totalAfter > Number(maxOpenSol)) {
      return {
        acquired: false,
        reason: 'combined_wallet_risk_limit',
        openSol: Number(open?.total || 0),
        attemptedSol: Number(amountSol || 0),
        maxOpenSol: Number(maxOpenSol),
      };
    }

    const result = db.prepare(`
      INSERT INTO live_execution_locks (mint, lane, status, amount_sol, acquired_at_ms)
      VALUES (?, ?, 'open', ?, ?)
    `).run(mint, lane, Number(amountSol || 0), now());
    return { acquired: true, lockId: Number(result.lastInsertRowid), totalOpenSol: totalAfter };
  })();
}

export function attachLiveExecutionLockPosition(lockId, positionId) {
  if (!lockId) return;
  getLiveLockDb().prepare(`
    UPDATE live_execution_locks
    SET position_id = ?
    WHERE id = ?
  `).run(positionId, lockId);
}

export function releaseLiveExecutionLock(lockId, reason = 'released') {
  if (!lockId) return;
  getLiveLockDb().prepare(`
    UPDATE live_execution_locks
    SET status = 'released', reason = ?, released_at_ms = ?
    WHERE id = ? AND status = 'open'
  `).run(reason, now(), lockId);
}
