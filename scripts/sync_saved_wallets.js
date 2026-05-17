/**
 * Sync harvester wallets into Charon's saved_wallets table.
 *
 * Dry-run by default. Pass --commit to write. Does not start Charon, Telegram,
 * providers, or trading paths. Does not read .env or secrets.
 *
 * Usage:
 *   node scripts/sync_saved_wallets.js
 *   node scripts/sync_saved_wallets.js --stats-only
 *   node scripts/sync_saved_wallets.js --commit
 *   node scripts/sync_saved_wallets.js --harvester-db=/path/to/harvester.db --commit
 *   node scripts/sync_saved_wallets.js --limit=100 --dry-run
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HARVESTER_DB = path.join(REPO_ROOT, '../moonbags/tools/wallet-harvester/data/harvester.db');
const DEFAULT_CHARON_DB = path.join(REPO_ROOT, 'charon.sqlite');
const PNL_FRESH_DAYS = 3;
const MIN_OBSERVED_DAYS_FOR_FREQ = 3;

// ---------------------------------------------------------------------------
// CLI helpers (same pattern as import_priority_wallets.js)
// ---------------------------------------------------------------------------

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const raw = argValue(name, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseRequiredProfile() {
  const requireEnriched = hasFlag('require-enriched');
  const rawProfile = argValue('require-profile', '');

  if (requireEnriched) {
    console.log('[sync] --require-enriched is deprecated, use --require-profile=both');
  }

  const profile = requireEnriched ? 'both' : rawProfile;
  if (!profile) return null;

  if (!['gmgn', 'okx', 'both', 'any'].includes(profile)) {
    throw new Error(`Invalid --require-profile=${profile}; expected gmgn, okx, both, or any`);
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Helpers copied verbatim from export_wallet_priority.js
// ---------------------------------------------------------------------------

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function pct(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// scoreWallet and tierFor — copied verbatim from export_wallet_priority.js
// ---------------------------------------------------------------------------

function scoreWallet(row) {
  const targetShare = row.total_sightings > 0 ? row.target_sightings / row.total_sightings : 0;
  const daysSinceLastSeen = row.last_seen
    ? Math.max(0, (Date.now() - Number(row.last_seen)) / 86_400_000)
    : 999;
  const observedDays = row.first_seen && row.last_seen
    ? Math.max(1, (Number(row.last_seen) - Number(row.first_seen)) / 86_400_000)
    : 1;
  const sightingsPerDay = row.total_sightings / observedDays;
  const sources = parseJsonArray(row.sources);
  const tags = parseJsonArray(row.tags);
  const pnlAgeDays = row.pnl_snapshot_at
    ? Math.max(0, (Date.now() - Number(row.pnl_snapshot_at)) / 86_400_000)
    : null;
  const pnlFresh = pnlAgeDays != null && pnlAgeDays <= PNL_FRESH_DAYS;
  const winRate = pnlFresh ? pct(row.win_rate) : null;
  const pnlUsd = pnlFresh ? pct(row.pnl_usd) : null;
  const avgBuyUsd = pct(row.avg_buy_usd);
  const frequencyScore = observedDays >= MIN_OBSERVED_DAYS_FOR_FREQ
    ? clamp(sightingsPerDay, 0, 5) * 8
    : 0;

  let score = 0;
  score += targetShare * 45;
  score += Math.min(row.target_tokens, 8) * 10;
  score += Math.min(row.target_sightings, 12) * 3;
  score += Math.min(row.token_count, 20) * 2;
  score += frequencyScore;
  score += Math.max(0, 20 - daysSinceLastSeen) * 1.5;
  score += sources.includes('gmgn') && sources.includes('okx') ? 20 : 0;
  score += tags.includes('smart_degen') ? 10 : 0;
  score += tags.includes('renowned') ? 5 : 0;
  score += winRate != null ? clamp(winRate, 0, 1) * 15 : 0;
  score += pnlUsd != null && pnlUsd > 0 ? Math.min(Math.log10(pnlUsd + 1) * 6, 24) : 0;
  score += avgBuyUsd != null && avgBuyUsd > 0 && avgBuyUsd <= 10_000 ? 8 : 0;
  score -= row.target_sightings === 0 ? 45 : 0;
  score -= daysSinceLastSeen > 14 ? 15 : 0;
  score -= row.total_sightings < 2 ? 12 : 0;

  return {
    score: Math.round(score * 10) / 10,
    targetShare,
    daysSinceLastSeen: Math.round(daysSinceLastSeen * 10) / 10,
    observedDays: Math.round(observedDays * 10) / 10,
    sightingsPerDay: Math.round(sightingsPerDay * 100) / 100,
    frequencyCounted: observedDays >= MIN_OBSERVED_DAYS_FOR_FREQ,
    pnlFresh,
    pnlAgeDays: pnlAgeDays == null ? null : Math.round(pnlAgeDays * 10) / 10,
    sources,
    tags,
    providerTags: parseJsonArray(row.provider_tags),
    tokenTags: parseJsonArray(row.token_tags),
  };
}

function tierFor(row, metrics) {
  if (metrics.score >= 115 && row.target_sightings >= 3 && metrics.daysSinceLastSeen <= 7) return 'A';
  if (metrics.score >= 80 && row.target_sightings >= 2) return 'B';
  if (metrics.score >= 50 && row.target_sightings >= 1) return 'C';
  return 'watch';
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function hasTable(db, name) {
  const row = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

function sanitizeLabel(raw) {
  return String(raw || '')
    .trim()
    .replace(/\W+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function generateLabel(row, tags) {
  if (row.manual_label) {
    return sanitizeLabel(row.manual_label);
  }
  if (row.gmgn_twitter_username) {
    return sanitizeLabel(`@${row.gmgn_twitter_username}`).slice(0, 64);
  }
  const meaningfulTags = tags.filter(t => t && t !== 'unknown');
  if (meaningfulTags.length > 0) {
    return sanitizeLabel(`${meaningfulTags[0]}_${row.address.slice(0, 4)}`).slice(0, 64);
  }
  return `${row.address.slice(0, 4)}...${row.address.slice(-4)}`;
}

function uniqueLabel(base, usedLabels) {
  if (!usedLabels.has(base)) {
    usedLabels.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}_${suffix}`.slice(0, 64);
  while (usedLabels.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`.slice(0, 64);
  }
  usedLabels.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const harvesterDbPath = path.resolve(
    argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB)
  );
  const charonDbPath = path.resolve(
    argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB)
  );
  const commit = hasFlag('commit');
  const statsOnly = hasFlag('stats-only');
  const limit = argNumber('limit', Infinity);
  const newOnly = hasFlag('new-only');
  const requireProfile = parseRequiredProfile();
  // dry-run is the default when --commit is not passed

  // ------------------------------------------------------------------
  // Open harvester DB (read-only)
  // ------------------------------------------------------------------
  const harvDb = new Database(harvesterDbPath, { readonly: true });

  // Build JOIN clause based on which tables exist
  const hasProfiles = hasTable(harvDb, 'wallet_profiles');
  const hasOwnerLabels = hasTable(harvDb, 'owner_labels');

  let selectSql = `
    SELECT w.*,
           COUNT(s.id)                                          AS total_sightings,
           COUNT(DISTINCT s.mint)                               AS total_tokens_seen,
           SUM(CASE WHEN s.token_mcap_usd > 0 THEN 1 ELSE 0 END) AS target_sightings,
           COUNT(DISTINCT CASE WHEN s.token_mcap_usd > 0 THEN s.mint END) AS target_tokens`;

  if (hasProfiles) {
    selectSql += `,
           wp.gmgn_winrate,
           wp.gmgn_realized_profit_usd,
           wp.gmgn_tags,
           wp.gmgn_twitter_username,
           wp.gmgn_snapshot_at,
           wp.okx_win_rate,
           wp.okx_realized_pnl_usd,
           wp.okx_preferred_mcap,
           wp.okx_snapshot_at`;
  } else {
    selectSql += `,
           NULL AS gmgn_winrate,
           NULL AS gmgn_realized_profit_usd,
           NULL AS gmgn_tags,
           NULL AS gmgn_twitter_username,
           NULL AS gmgn_snapshot_at,
           NULL AS okx_win_rate,
           NULL AS okx_realized_pnl_usd,
           NULL AS okx_preferred_mcap,
           NULL AS okx_snapshot_at`;
  }

  if (hasOwnerLabels) {
    selectSql += `,
           ol.manual_label,
           ol.manual_notes`;
  } else {
    selectSql += `,
           NULL AS manual_label,
           NULL AS manual_notes`;
  }

  selectSql += `
    FROM wallets w
    LEFT JOIN sightings s ON s.wallet_address = w.address`;

  if (hasProfiles) {
    selectSql += `
    LEFT JOIN wallet_profiles wp ON w.address = wp.address`;
  }
  if (hasOwnerLabels) {
    selectSql += `
    LEFT JOIN owner_labels ol ON w.address = ol.address`;
  }

  selectSql += `
    GROUP BY w.address`;

  const harvesterRows = harvDb.prepare(selectSql).all();
  harvDb.close();

  // ------------------------------------------------------------------
  // Open Charon DB
  // ------------------------------------------------------------------
  const charonDb = new Database(charonDbPath);

  // Load existing manual wallet addresses
  const existingRows = charonDb.prepare('SELECT address, source, last_synced_at FROM saved_wallets').all();
  const manualAddresses = new Set(
    existingRows
      .filter(r => r.source === 'manual' || r.source == null)
      .map(r => r.address)
  );
  const existingHarvesterAddresses = new Set(
    existingRows
      .filter(r => r.source === 'harvester')
      .map(r => r.address)
  );
  // Map of address → last_synced_at for --new-only freshness check
  const charonSyncedMap = new Map(
    existingRows.map(r => [r.address, { source: r.source, last_synced_at: r.last_synced_at }])
  );

  // Seed usedLabels with all existing labels so we don't collide
  const usedLabels = new Set(
    charonDb.prepare('SELECT label FROM saved_wallets').all().map(r => r.label)
  );

  const now = Date.now();

  // ------------------------------------------------------------------
  // Score and classify all harvester wallets
  // ------------------------------------------------------------------
  const tierCounts = { A: 0, B: 0, C: 0, universe: 0 };
  let staleGmgn = 0;
  let staleJupiter = 0;
  let missingJupiter = 0;

  const toProcess = [];
  let skippedMissingGmgnProfile = 0;
  let skippedMissingOkxProfile = 0;
  let skippedMissingBothProfiles = 0;
  let skippedUpToDate = 0;

  for (const row of harvesterRows) {
    const metrics = scoreWallet(row);
    const rawTier = tierFor(row, metrics);
    // Map 'watch' → 'universe' per arch plan
    const tier = rawTier === 'watch' ? 'universe' : rawTier;
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;

    // Staleness checks
    const gmgnSnapshotAt = numberOrNull(row.gmgn_snapshot_at);
    if (gmgnSnapshotAt != null) {
      const ageDays = (now - gmgnSnapshotAt) / 86_400_000;
      if (ageDays > 3) staleGmgn++;
    }
    const jupSnapshotAt = numberOrNull(row.pnl_snapshot_at);
    if (jupSnapshotAt == null) {
      missingJupiter++;
    } else {
      const ageDays = (now - jupSnapshotAt) / 86_400_000;
      if (ageDays > 1) staleJupiter++;
    }

    // --require-profile: skip wallets that do not meet the requested profile gate.
    if (requireProfile) {
      const hasGmgnProfile = Boolean(numberOrNull(row.gmgn_snapshot_at));
      const hasOkxProfile = Boolean(numberOrNull(row.okx_snapshot_at));

      if (requireProfile === 'gmgn' && !hasGmgnProfile) {
        skippedMissingGmgnProfile++;
        continue;
      }
      if (requireProfile === 'okx' && !hasOkxProfile) {
        skippedMissingOkxProfile++;
        continue;
      }
      if (requireProfile === 'both' && (!hasGmgnProfile || !hasOkxProfile)) {
        if (!hasGmgnProfile) skippedMissingGmgnProfile++;
        if (!hasOkxProfile) skippedMissingOkxProfile++;
        if (!hasGmgnProfile && !hasOkxProfile) skippedMissingBothProfiles++;
        continue;
      }
      if (requireProfile === 'any' && !hasGmgnProfile && !hasOkxProfile) {
        skippedMissingBothProfiles++;
        continue;
      }
    }

    // --new-only: skip wallets already synced with up-to-date profiles
    if (newOnly) {
      const existing = charonSyncedMap.get(row.address);
      if (existing && existing.source === 'harvester') {
        const lastSync = existing.last_synced_at || 0;
        const gmgnAt = numberOrNull(row.gmgn_snapshot_at) || 0;
        const okxAt = numberOrNull(row.okx_snapshot_at) || 0;
        const profileFresher = gmgnAt > lastSync || okxAt > lastSync;
        if (!profileFresher) {
          skippedUpToDate++;
          continue;
        }
      }
    }

    toProcess.push({ row, metrics, tier });
  }

  // ------------------------------------------------------------------
  // --stats-only: print and exit
  // ------------------------------------------------------------------
  if (statsOnly) {
    console.log('Stats: saved_wallets sync from harvester');
    console.log(`  Harvester wallets: ${harvesterRows.length}`);
    console.log(`  Manual (protected): ${manualAddresses.size}`);
    console.log(`  Tier distribution: ${tierCounts.A} A, ${tierCounts.B} B, ${tierCounts.C} C, ${tierCounts.universe} universe`);
    console.log(`  Stale GMGN (>3d): ${staleGmgn}`);
    console.log(`  Stale Jupiter (>1d): ${staleJupiter}`);
    console.log(`  Missing Jupiter: ${missingJupiter}`);
    if (requireProfile === 'gmgn' || requireProfile === 'both') console.log(`  Skipped (missing GMGN profile): ${skippedMissingGmgnProfile}`);
    if (requireProfile === 'okx' || requireProfile === 'both') console.log(`  Skipped (missing OKX profile): ${skippedMissingOkxProfile}`);
    if (requireProfile === 'both' || requireProfile === 'any') console.log(`  Skipped (missing both profiles): ${skippedMissingBothProfiles}`);
    if (newOnly) console.log(`  Skipped (already up to date): ${skippedUpToDate}`);
    charonDb.close();
    return;
  }

  // ------------------------------------------------------------------
  // Build upsert rows (respecting --limit)
  // ------------------------------------------------------------------
  const upsertStmt = charonDb.prepare(`
    INSERT INTO saved_wallets (
      label, address, created_at_ms,
      tags_json, tier, quality_score, source,
      gmgn_winrate, gmgn_realized_pnl, gmgn_tags_json, gmgn_twitter, gmgn_snapshot_at,
      okx_winrate, okx_realized_pnl, okx_preferred_mcap, okx_snapshot_at,
      jup_total_pnl, jup_winrate, jup_total_trades, jup_snapshot_at,
      owner_label, owner_notes,
      last_synced_at, harvester_last_seen
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, 'harvester',
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, NULL, ?,
      ?, ?,
      ?, ?
    )
    ON CONFLICT(address) DO UPDATE SET
      tags_json            = excluded.tags_json,
      tier                 = excluded.tier,
      quality_score        = excluded.quality_score,
      gmgn_winrate         = excluded.gmgn_winrate,
      gmgn_realized_pnl    = excluded.gmgn_realized_pnl,
      gmgn_tags_json       = excluded.gmgn_tags_json,
      gmgn_twitter         = excluded.gmgn_twitter,
      gmgn_snapshot_at     = excluded.gmgn_snapshot_at,
      okx_winrate          = excluded.okx_winrate,
      okx_realized_pnl     = excluded.okx_realized_pnl,
      okx_preferred_mcap   = excluded.okx_preferred_mcap,
      okx_snapshot_at      = excluded.okx_snapshot_at,
      jup_total_pnl        = excluded.jup_total_pnl,
      jup_winrate          = excluded.jup_winrate,
      jup_snapshot_at      = excluded.jup_snapshot_at,
      owner_label          = excluded.owner_label,
      owner_notes          = excluded.owner_notes,
      last_synced_at       = excluded.last_synced_at,
      harvester_last_seen  = excluded.harvester_last_seen
    WHERE saved_wallets.source != 'manual'
  `);

  let wouldInsert = 0;
  let wouldUpdate = 0;
  let skippedManual = 0;
  let actualInserted = 0;
  let actualUpdated = 0;
  let processed = 0;

  const txn = charonDb.transaction(() => {
    for (const { row, metrics, tier } of toProcess) {
      if (processed >= limit) break;

      const address = String(row.address || '').trim();
      if (!address) continue;

      // Skip manual/protected wallets
      if (manualAddresses.has(address)) {
        skippedManual++;
        continue;
      }

      // Merge tags
      const walletTags = parseJsonArray(row.tags);
      const providerTags = parseJsonArray(row.provider_tags);
      const gmgnTags = parseJsonArray(row.gmgn_tags);
      const mergedTags = JSON.stringify([...new Set([...walletTags, ...providerTags, ...gmgnTags])]);

      // Generate label
      const baseLabel = generateLabel(
        {
          manual_label: row.manual_label,
          gmgn_twitter_username: row.gmgn_twitter_username,
          address,
        },
        [...walletTags, ...providerTags, ...gmgnTags]
      );
      const label = uniqueLabel(baseLabel, usedLabels);

      const isExistingHarvester = existingHarvesterAddresses.has(address);

      if (isExistingHarvester) {
        wouldUpdate++;
      } else {
        wouldInsert++;
      }

      if (!commit) {
        processed++;
        continue;
      }

      const result = upsertStmt.run(
        label,
        address,
        now,
        // tags / tier / score
        mergedTags,
        tier,
        metrics.score,
        // gmgn
        numberOrNull(row.gmgn_winrate),
        numberOrNull(row.gmgn_realized_profit_usd),
        row.gmgn_tags || null,
        row.gmgn_twitter_username || null,
        numberOrNull(row.gmgn_snapshot_at),
        // okx
        numberOrNull(row.okx_win_rate),
        numberOrNull(row.okx_realized_pnl_usd),
        row.okx_preferred_mcap || null,
        numberOrNull(row.okx_snapshot_at),
        // jup
        numberOrNull(row.pnl_usd),
        numberOrNull(row.win_rate),
        numberOrNull(row.pnl_snapshot_at),
        // owner
        row.manual_label || null,
        row.manual_notes || null,
        // housekeeping
        now,
        numberOrNull(row.last_seen)
      );

      if (result.changes > 0) {
        if (isExistingHarvester) {
          actualUpdated++;
        } else {
          actualInserted++;
        }
      }

      processed++;
    }
  });

  txn();
  charonDb.close();

  // ------------------------------------------------------------------
  // Summary output
  // ------------------------------------------------------------------
  const mode = commit ? 'Sync' : '[dry-run] Sync';
  const modeFlags = [newOnly && '--new-only', requireProfile && `--require-profile=${requireProfile}`].filter(Boolean).join(' ');
  console.log(`${mode} saved_wallets from harvester${modeFlags ? ` (${modeFlags})` : ''}`);
  console.log(`  Harvester wallets: ${harvesterRows.length}`);

  if (commit) {
    console.log(`  Inserted (new): ${actualInserted}`);
    console.log(`  Updated (existing harvester): ${actualUpdated}`);
  } else {
    console.log(`  Would insert (new): ${wouldInsert}`);
    console.log(`  Would update (existing harvester): ${wouldUpdate}`);
  }

  console.log(`  Skipped (manual/protected): ${skippedManual}`);
  if (requireProfile === 'gmgn' || requireProfile === 'both') console.log(`  Skipped (missing GMGN profile): ${skippedMissingGmgnProfile}`);
  if (requireProfile === 'okx' || requireProfile === 'both') console.log(`  Skipped (missing OKX profile): ${skippedMissingOkxProfile}`);
  if (requireProfile === 'both' || requireProfile === 'any') console.log(`  Skipped (missing both profiles): ${skippedMissingBothProfiles}`);
  if (newOnly) console.log(`  Skipped (already up to date): ${skippedUpToDate}`);
  console.log(`  Tier distribution: ${tierCounts.A} A, ${tierCounts.B} B, ${tierCounts.C} C, ${tierCounts.universe} universe`);
  console.log(`  Stale GMGN (>3d): ${staleGmgn}`);
  console.log(`  Stale Jupiter (>1d): ${staleJupiter}`);
  console.log(`  Missing Jupiter: ${missingJupiter}`);

  if (!commit) {
    console.log('Pass --commit to write.');
  }

  // Exit code 2 = nothing new to sync (signals orchestrator to skip restart)
  const nothingNew = (newOnly || requireProfile) && (commit ? (actualInserted + actualUpdated) === 0 : (wouldInsert + wouldUpdate) === 0);
  if (nothingNew) process.exit(2);
}

main();
