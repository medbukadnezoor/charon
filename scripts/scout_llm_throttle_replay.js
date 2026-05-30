#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { extractScoutFeatureSnapshot } from '../src/scout/features.js';
import { scoreFeatureSnapshot } from '../src/scout/weights.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function parseArgs(argv) {
  const opts = {
    db: process.env.DB_PATH || '/var/oled/charon-data/trading-data/charon-scout.sqlite',
    limit: 1000,
    cooldownMs: 30 * 60_000,
    hourlyCap: 120,
    dailyCap: 1200,
    threshold: -0.02,
    reserveThreshold: 0.03,
    explorationRate: 0.08,
    minWeightConfidence: 0.2,
  };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'limit') opts.limit = Number(value);
    else if (key === 'cooldown-ms') opts.cooldownMs = Number(value);
    else if (key === 'hourly-cap') opts.hourlyCap = Number(value);
    else if (key === 'daily-cap') opts.dailyCap = Number(value);
    else if (key === 'threshold') opts.threshold = Number(value);
    else if (key === 'reserve-threshold') opts.reserveThreshold = Number(value);
    else if (key === 'exploration-rate') opts.explorationRate = Number(value);
    else if (key === 'min-weight-confidence') opts.minWeightConfidence = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function band(value, bands, fallback = 'unknown') {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  for (const item of bands) {
    if (parsed >= item.min && parsed < item.max) return item.label;
  }
  return bands.at(-1)?.label || fallback;
}

function materialBands(fields = {}) {
  return {
    route: fields.observation_path || 'unknown',
    source_count: finiteNumber(fields.source_count) ?? 0,
    saved_wallet_holders: finiteNumber(fields.saved_wallet_holders) ?? 0,
    mcap_band: band(fields.mcap_usd, [
      { label: '<10k', min: 0, max: 10_000 },
      { label: '10k-25k', min: 10_000, max: 25_000 },
      { label: '25k-50k', min: 25_000, max: 50_000 },
      { label: '50k-100k', min: 50_000, max: 100_000 },
      { label: '100k+', min: 100_000, max: Infinity },
    ]),
    liquidity_band: band(fields.liquidity_usd, [
      { label: '<8k', min: 0, max: 8_000 },
      { label: '8k-25k', min: 8_000, max: 25_000 },
      { label: '25k-75k', min: 25_000, max: 75_000 },
      { label: '75k+', min: 75_000, max: Infinity },
    ]),
    ath_band: band(fields.ath_distance_pct, [
      { label: 'near_high', min: -10, max: Infinity },
      { label: 'pulled_back', min: -45, max: -10 },
      { label: 'deep_pullback', min: -1000, max: -45 },
    ]),
    filter_passed: Boolean(fields.filter_passed),
    filter_failure_count: finiteNumber(fields.filter_failure_count) ?? 0,
  };
}

function changed(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot) return true;
  const previous = materialBands(previousSnapshot.fields);
  const current = materialBands(currentSnapshot.fields);
  return current.source_count > previous.source_count
    || current.saved_wallet_holders > previous.saved_wallet_holders
    || current.route !== previous.route
    || current.mcap_band !== previous.mcap_band
    || current.liquidity_band !== previous.liquidity_band
    || current.ath_band !== previous.ath_band
    || (!previous.filter_passed && current.filter_passed)
    || current.filter_failure_count < previous.filter_failure_count;
}

function deterministicExplore(mint, atMs, rate) {
  const boundedRate = Math.max(0, Math.min(1, Number(rate) || 0));
  if (boundedRate <= 0) return false;
  const digest = crypto.createHash('sha256').update(`${mint}:${Math.floor(atMs / HOUR_MS)}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff < boundedRate;
}

function currentPolicyVersion(db) {
  const version = db.prepare("SELECT value FROM settings WHERE key = 'scout_policy_active_version'").get()?.value || 'scout-v1';
  return db.prepare('SELECT id, version FROM scout_policy_versions WHERE version = ?').get(version)
    || db.prepare('SELECT id, version FROM scout_policy_versions ORDER BY id DESC LIMIT 1').get()
    || null;
}

function weightsMap(db, policyVersionId, minConfidence) {
  if (!policyVersionId) return new Map();
  const rows = db.prepare(`
    SELECT feature_key, weight, confidence
    FROM scout_policy_weights
    WHERE policy_version_id = ?
      AND feature_key NOT LIKE 'llm:%'
  `).all(policyVersionId);
  return new Map(rows
    .filter(row => Number(row.confidence || 0) >= minConfidence)
    .map(row => [row.feature_key, row]));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) throw new Error(`Scout DB not found: ${opts.db}`);
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const policy = currentPolicyVersion(db);
  const weights = weightsMap(db, policy?.id, opts.minWeightConfidence);
  const candidates = db.prepare(`
    SELECT *
    FROM candidates
    WHERE status != 'filtered'
    ORDER BY created_at_ms DESC
    LIMIT ?
  `).all(opts.limit).reverse();
  const recentAdmits = [];
  const lastAdmittedByMint = new Map();
  const reasonCounts = {};
  const admittedMints = new Set();
  const replayRows = [];

  for (const row of candidates) {
    const candidate = safeJson(row.candidate_json, {});
    const snapshot = extractScoutFeatureSnapshot(candidate, {
      asOfMs: row.created_at_ms,
      llmDecision: null,
      decisionPath: candidate?.signals?.route || null,
    });
    snapshot.fields.filter_passed = Boolean(candidate?.filters?.passed);
    snapshot.fields.filter_failure_count = Array.isArray(candidate?.filters?.failures)
      ? candidate.filters.failures.length
      : (candidate?.filters?.passed ? 0 : 1);
    snapshot.feature_keys = [...new Set((snapshot.feature_keys || []).filter(key => !String(key).startsWith('llm:')))];
    const scored = scoreFeatureSnapshot(snapshot, weights);
    const hourUsed = recentAdmits.filter(item => item >= row.created_at_ms - HOUR_MS).length;
    const dayUsed = recentAdmits.filter(item => item >= row.created_at_ms - DAY_MS).length;
    const previous = lastAdmittedByMint.get(row.mint);
    const inCooldown = previous && previous.atMs >= row.created_at_ms - opts.cooldownMs;
    const materialChanged = !inCooldown || changed(previous?.snapshot, snapshot);
    const exploration = deterministicExplore(row.mint, row.created_at_ms, opts.explorationRate);
    let admitted = true;
    let reason = 'score_admit';
    if ((opts.hourlyCap > 0 && hourUsed >= opts.hourlyCap) || (opts.dailyCap > 0 && dayUsed >= opts.dailyCap)) {
      admitted = false;
      reason = 'budget_cap_exhausted';
    } else if (inCooldown && !materialChanged) {
      admitted = false;
      reason = 'cooldown_skip';
    } else if (scored.score >= opts.reserveThreshold) {
      reason = 'high_score_admit';
    } else if (scored.score >= opts.threshold) {
      reason = inCooldown ? 'material_change_admit' : 'score_admit';
    } else if (exploration) {
      admitted = true;
      reason = 'exploration_admit';
    } else {
      admitted = false;
      reason = 'score_skip';
    }
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (admitted) {
      recentAdmits.push(row.created_at_ms);
      lastAdmittedByMint.set(row.mint, { atMs: row.created_at_ms, snapshot });
      admittedMints.add(row.mint);
    }
    replayRows.push({ candidate_id: row.id, mint: row.mint, admitted, reason, pre_score: scored.score });
  }

  const historicalPositions = db.prepare(`
    SELECT id, mint, opened_at_ms
    FROM dry_run_positions
    WHERE strategy_id = 'scout'
    ORDER BY id ASC
  `).all();
  const historicalCoverage = historicalPositions.map(position => ({
    position_id: position.id,
    mint: position.mint,
    admitted_in_replay: admittedMints.has(position.mint),
  }));
  const admitted = replayRows.filter(row => row.admitted).length;
  const reduction = replayRows.length ? 1 - admitted / replayRows.length : null;
  console.log(JSON.stringify({
    db: opts.db,
    policy_version: policy?.version || null,
    candidates_replayed: replayRows.length,
    admitted,
    skipped: replayRows.length - admitted,
    admission_rate: replayRows.length ? admitted / replayRows.length : null,
    estimated_llm_reduction: reduction,
    target_70_85_percent_reduction_met: reduction == null ? null : reduction >= 0.70 && reduction <= 0.85,
    reason_counts: reasonCounts,
    historical_scout_entries: historicalCoverage,
    historical_scout_entries_all_admitted: historicalCoverage.every(row => row.admitted_in_replay),
  }, null, 2));
  db.close();
}

main();
