import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

const HARD_LOSS_EXIT_REASONS = new Set(['SL', 'BREAKEVEN_LOCK', 'TIME_STOP_NO_TP']);
const SEVERE_LOSS_PNL_PERCENT = -25;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function holderCreatorAddress(holders) {
  const rows = Array.isArray(holders?.holders) ? holders.holders : [];
  const creator = rows.find(holder => {
    const tags = Array.isArray(holder?.tags) ? holder.tags : [];
    return tags.some(tag => String(tag).toLowerCase() === 'creator');
  });
  return firstText(creator?.address, creator?.owner, creator?.pubkey);
}

function candidateFromPosition(position) {
  const snapshot = safeJson(position?.snapshot_json, {});
  return snapshot?.candidate && typeof snapshot.candidate === 'object'
    ? snapshot.candidate
    : {};
}

export function addMintBlacklist(mint, { reason = null, source = 'manual', createdAtMs = now() } = {}) {
  if (!mint) throw new Error('mint is required');
  db.prepare(`
    INSERT INTO mint_blacklist (mint, reason, source, created_at_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      reason = excluded.reason,
      source = excluded.source,
      created_at_ms = excluded.created_at_ms
  `).run(mint, reason, source, createdAtMs);
}

export function isMintBlacklisted(mint) {
  if (!mint) return false;
  return Boolean(db.prepare('SELECT mint FROM mint_blacklist WHERE mint = ? LIMIT 1').get(mint));
}

export function lossSeverity(pnlPercent) {
  const pnl = numberOrNull(pnlPercent);
  if (pnl === null || pnl > SEVERE_LOSS_PNL_PERCENT) return null;
  if (pnl <= -50) return 'critical';
  return 'severe';
}

export function shouldRecordDeployerObservation(exitReason, pnlPercent) {
  return HARD_LOSS_EXIT_REASONS.has(exitReason) && lossSeverity(pnlPercent) !== null;
}

export function buildDeployerObservation(position, {
  exitReason,
  pnlPercent,
  pnlSol,
  mcapSample = null,
  observedAtMs = now(),
} = {}) {
  const candidate = candidateFromPosition(position);
  const token = candidate.token || {};
  const holders = candidate.holders || {};
  const trending = candidate.trending || {};
  const gmgn = candidate.gmgn || {};
  const severity = lossSeverity(pnlPercent);

  return {
    mint: position?.mint || token.mint || null,
    deployer: firstText(token.deployer, token.deployerAddress, gmgn.deployer, gmgn.creator, trending.deployer),
    creator: firstText(token.creator, token.creatorAddress, holderCreatorAddress(holders), gmgn.creator, trending.creator),
    exitReason,
    lossSeverity: severity,
    pnlPercent: numberOrNull(pnlPercent),
    pnlSol: numberOrNull(pnlSol),
    rugRatio: numberOrNull(trending.rug_ratio),
    topHolderPercent: numberOrNull(holders.maxHolderPercent),
    top20HolderPercent: numberOrNull(holders.top20Percent),
    bundlerRate: numberOrNull(trending.bundler_rate),
    context: {
      source: 'position_exit',
      positionId: position?.id ?? null,
      executionMode: position?.execution_mode ?? null,
      symbol: position?.symbol ?? token.symbol ?? null,
      marketCapSource: mcapSample?.source ?? null,
      mcapSample: mcapSample ? {
        source: mcapSample.source ?? null,
        marketCapUsd: numberOrNull(mcapSample.marketCapUsd),
        priceUsd: numberOrNull(mcapSample.priceUsd),
        disagreementPercent: numberOrNull(mcapSample.disagreementPercent),
      } : null,
    },
    observedAtMs,
  };
}

export function recordDeployerObservation(position, options = {}) {
  const observation = buildDeployerObservation(position, options);
  if (!observation.mint) return null;
  if (!shouldRecordDeployerObservation(observation.exitReason, observation.pnlPercent)) return null;

  const result = db.prepare(`
    INSERT INTO deployer_observations (
      mint, deployer, creator, exit_reason, loss_severity, pnl_percent, pnl_sol,
      rug_ratio, top_holder_percent, top20_holder_percent, bundler_rate, context_json, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.mint,
    observation.deployer,
    observation.creator,
    observation.exitReason,
    observation.lossSeverity,
    observation.pnlPercent,
    observation.pnlSol,
    observation.rugRatio,
    observation.topHolderPercent,
    observation.top20HolderPercent,
    observation.bundlerRate,
    json(observation.context),
    observation.observedAtMs,
  );

  return Number(result.lastInsertRowid);
}
