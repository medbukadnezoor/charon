// ---------------------------------------------------------------------------
// Wallet Harvester — SQLite Store
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type {
  WalletRecord,
  SightingRecord,
  TokenRecord,
  RunRecord,
  ProviderRunMetric,
  Source,
  WalletTag,
  ExtractedWallet,
  DiscoveredToken,
  TradeRecord,
  PositionRecord,
  TradeContextRecord,
  WalletStrategyRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallets (
  address         TEXT PRIMARY KEY,
  sources         TEXT NOT NULL DEFAULT '[]',
  tags            TEXT NOT NULL DEFAULT '[]',
  wallet_label    TEXT,
  twitter_username TEXT,
  twitter_name    TEXT,
  avatar_url      TEXT,
  provider_tags   TEXT NOT NULL DEFAULT '[]',
  token_tags      TEXT NOT NULL DEFAULT '[]',
  metadata_snapshot_at INTEGER,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  token_count     INTEGER NOT NULL DEFAULT 0,
  pnl_usd         REAL,
  win_rate         REAL,
  avg_buy_usd      REAL,
  pnl_snapshot_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sightings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address  TEXT NOT NULL REFERENCES wallets(address),
  mint            TEXT NOT NULL,
  action          TEXT NOT NULL,
  amount_usd      REAL,
  token_mcap_usd  REAL,
  timestamp       INTEGER NOT NULL,
  source          TEXT NOT NULL,
  signal_type     TEXT,
  run_id          TEXT NOT NULL,
  UNIQUE(wallet_address, mint, source, timestamp, action)
);

CREATE TABLE IF NOT EXISTS tokens (
  mint                TEXT PRIMARY KEY,
  symbol              TEXT,
  name                TEXT,
  mcap_at_harvest     REAL,
  volume_24h_usd      REAL,
  holder_count        INTEGER,
  smart_wallet_count  INTEGER,
  kol_count           INTEGER,
  created_at          INTEGER,
  first_harvested_at  INTEGER NOT NULL,
  last_harvested_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  tokens_discovered   INTEGER DEFAULT 0,
  tokens_harvested    INTEGER DEFAULT 0,
  wallets_new         INTEGER DEFAULT 0,
  wallets_updated     INTEGER DEFAULT 0,
  sightings_added     INTEGER DEFAULT 0,
  errors              TEXT DEFAULT '[]',
  status              TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS provider_run_metrics (
  run_id              TEXT NOT NULL REFERENCES runs(run_id),
  provider            TEXT NOT NULL,
  calls_used          INTEGER NOT NULL DEFAULT 0,
  rate_limit_hits     INTEGER NOT NULL DEFAULT 0,
  stopped_early       INTEGER NOT NULL DEFAULT 0,
  wallets_extracted   INTEGER NOT NULL DEFAULT 0,
  sightings_extracted INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (run_id, provider)
);

CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address  TEXT NOT NULL,
  signature       TEXT NOT NULL UNIQUE,
  mint            TEXT NOT NULL,
  side            TEXT NOT NULL,
  token_amount    REAL NOT NULL,
  sol_amount      REAL NOT NULL,
  usd_amount      REAL,
  price_usd       REAL,
  price_sol       REAL,
  timestamp       INTEGER NOT NULL,
  program         TEXT,
  slot            INTEGER,
  raw_json        TEXT,
  collected_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_mint ON trades(wallet_address, mint, timestamp);

CREATE TABLE IF NOT EXISTS positions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address    TEXT NOT NULL,
  mint              TEXT NOT NULL,
  status            TEXT NOT NULL,
  entry_count       INTEGER NOT NULL,
  first_entry_ts    INTEGER NOT NULL,
  last_entry_ts     INTEGER NOT NULL,
  avg_entry_price   REAL,
  total_sol_in      REAL NOT NULL,
  total_token_in    REAL NOT NULL,
  entry_mcap_usd    REAL,
  exit_count        INTEGER NOT NULL,
  first_exit_ts     INTEGER,
  last_exit_ts      INTEGER,
  avg_exit_price    REAL,
  total_sol_out     REAL NOT NULL,
  total_token_out   REAL NOT NULL,
  realized_sol      REAL,
  realized_usd      REAL,
  realized_pct      REAL,
  hold_duration_s   INTEGER,
  entry_spread_s    INTEGER NOT NULL DEFAULT 0,
  exit_spread_s     INTEGER,
  is_dca            INTEGER NOT NULL DEFAULT 0,
  is_scale_in       INTEGER NOT NULL DEFAULT 0,
  is_partial_tp     INTEGER NOT NULL DEFAULT 0,
  is_full_exit      INTEGER NOT NULL DEFAULT 0,
  is_trailing_like  INTEGER NOT NULL DEFAULT 0,
  trade_ids_json    TEXT NOT NULL,
  built_at_ms       INTEGER NOT NULL,
  UNIQUE(wallet_address, mint, first_entry_ts)
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

CREATE TABLE IF NOT EXISTS trade_context (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id        INTEGER NOT NULL,
  position_id     INTEGER,
  mint            TEXT NOT NULL,
  candle_open     REAL,
  candle_high     REAL,
  candle_low      REAL,
  candle_close    REAL,
  candle_volume   REAL,
  rsi_14          REAL,
  vwap            REAL,
  bb_upper        REAL,
  bb_middle       REAL,
  bb_lower        REAL,
  bb_position     REAL,
  volume_ratio    REAL,
  ema_9           REAL,
  ema_21          REAL,
  ema_trend       TEXT,
  distance_from_high_pct REAL,
  distance_from_low_pct  REAL,
  atr_14          REAL,
  momentum_5      REAL,
  momentum_15     REAL,
  momentum_60     REAL,
  timeframe       TEXT NOT NULL,
  candles_used    INTEGER,
  computed_at_ms  INTEGER NOT NULL,
  UNIQUE(trade_id)
);
CREATE INDEX IF NOT EXISTS idx_tc_trade ON trade_context(trade_id);
CREATE INDEX IF NOT EXISTS idx_tc_position ON trade_context(position_id);
CREATE INDEX IF NOT EXISTS idx_tc_mint ON trade_context(mint);

CREATE TABLE IF NOT EXISTS wallet_strategies (
  wallet_address      TEXT PRIMARY KEY,
  total_positions     INTEGER NOT NULL,
  closed_positions    INTEGER NOT NULL,
  open_positions      INTEGER NOT NULL,
  single_entry_pct    REAL,
  dca_pct             REAL,
  scale_in_pct        REAL,
  avg_entries_per_pos REAL,
  single_exit_pct     REAL,
  partial_tp_pct      REAL,
  trailing_exit_pct   REAL,
  avg_exits_per_pos   REAL,
  median_tp_pct       REAL,
  p25_tp_pct          REAL,
  p75_tp_pct          REAL,
  median_sl_pct       REAL,
  p25_sl_pct          REAL,
  p75_sl_pct          REAL,
  trailing_detected   INTEGER NOT NULL DEFAULT 0,
  trailing_drop_pct   REAL,
  median_hold_s       INTEGER,
  avg_hold_s          INTEGER,
  median_entry_hour   INTEGER,
  median_entry_mcap   REAL,
  avg_entry_mcap      REAL,
  pct_under_200k      REAL,
  win_rate            REAL,
  avg_pnl_pct         REAL,
  median_pnl_pct      REAL,
  sharpe_like         REAL,
  archetype           TEXT NOT NULL DEFAULT 'unknown',
  is_likely_bot       INTEGER NOT NULL DEFAULT 0,
  confidence          REAL NOT NULL DEFAULT 0,
  analyzed_at_ms      INTEGER NOT NULL,
  analysis_version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sightings_wallet ON sightings(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sightings_mint ON sightings(mint);
CREATE INDEX IF NOT EXISTS idx_sightings_run ON sightings(run_id);
CREATE INDEX IF NOT EXISTS idx_wallets_token_count ON wallets(token_count DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_last_seen ON wallets(last_seen DESC);

-- Hypothesis testing views

CREATE VIEW IF NOT EXISTS v_recurrence_pnl AS
SELECT
  address,
  token_count,
  pnl_usd,
  win_rate,
  CASE WHEN token_count >= 3 THEN 'high_freq' ELSE 'low_freq' END AS freq_group
FROM wallets
WHERE pnl_usd IS NOT NULL;

CREATE VIEW IF NOT EXISTS v_cross_source AS
SELECT
  address,
  sources,
  json_array_length(sources) AS source_count,
  CASE
    WHEN sources LIKE '%gmgn%' AND sources LIKE '%okx%' THEN 'dual'
    WHEN sources LIKE '%gmgn%' THEN 'gmgn_only'
    ELSE 'okx_only'
  END AS source_type
FROM wallets;

CREATE VIEW IF NOT EXISTS v_sighting_freq AS
SELECT
  wallet_address,
  COUNT(DISTINCT mint) AS unique_tokens,
  COUNT(*) AS total_sightings
FROM sightings
GROUP BY wallet_address
ORDER BY total_sightings DESC;
`;

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

export class HarvesterStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.migrateWalletMetadataColumns();
  }

  // -------------------------------------------------------------------------
  // Run tracking
  // -------------------------------------------------------------------------

  createRun(runId: string): void {
    this.db.prepare(`
      INSERT INTO runs (run_id, started_at, status)
      VALUES (?, ?, 'running')
    `).run(runId, Date.now());
  }

  completeRun(runId: string, stats: Partial<RunRecord>): void {
    this.db.prepare(`
      UPDATE runs SET
        finished_at = ?,
        tokens_discovered = COALESCE(?, tokens_discovered),
        tokens_harvested = COALESCE(?, tokens_harvested),
        wallets_new = COALESCE(?, wallets_new),
        wallets_updated = COALESCE(?, wallets_updated),
        sightings_added = COALESCE(?, sightings_added),
        errors = COALESCE(?, errors),
        status = ?
      WHERE run_id = ?
    `).run(
      Date.now(),
      stats.tokensDiscovered ?? null,
      stats.tokensHarvested ?? null,
      stats.walletsNew ?? null,
      stats.walletsUpdated ?? null,
      stats.sightingsAdded ?? null,
      stats.errors ? JSON.stringify(stats.errors) : null,
      stats.status ?? "completed",
      runId,
    );
  }

  getLastRun(): RunRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM runs ORDER BY started_at DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  upsertProviderRunMetric(metric: Omit<ProviderRunMetric, "createdAt">): void {
    this.db.prepare(`
      INSERT INTO provider_run_metrics (
        run_id, provider, calls_used, rate_limit_hits, stopped_early,
        wallets_extracted, sightings_extracted, metadata, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider) DO UPDATE SET
        calls_used = excluded.calls_used,
        rate_limit_hits = excluded.rate_limit_hits,
        stopped_early = excluded.stopped_early,
        wallets_extracted = excluded.wallets_extracted,
        sightings_extracted = excluded.sightings_extracted,
        metadata = excluded.metadata
    `).run(
      metric.runId,
      metric.provider,
      metric.callsUsed,
      metric.rateLimitHits,
      metric.stoppedEarly ? 1 : 0,
      metric.walletsExtracted,
      metric.sightingsExtracted,
      JSON.stringify(metric.metadata),
      Date.now(),
    );
  }

  getProviderRunMetrics(runId: string): ProviderRunMetric[] {
    const rows = this.db.prepare(`
      SELECT * FROM provider_run_metrics
      WHERE run_id = ?
      ORDER BY provider
    `).all(runId) as Record<string, unknown>[];
    return rows.map(r => ({
      runId: r.run_id as string,
      provider: r.provider as Source,
      callsUsed: r.calls_used as number,
      rateLimitHits: r.rate_limit_hits as number,
      stoppedEarly: Boolean(r.stopped_early),
      walletsExtracted: r.wallets_extracted as number,
      sightingsExtracted: r.sightings_extracted as number,
      metadata: JSON.parse(r.metadata as string) as Record<string, unknown>,
      createdAt: r.created_at as number,
    }));
  }

  getLatestProviderRunMetrics(): ProviderRunMetric[] {
    const lastRun = this.getLastRun();
    return lastRun ? this.getProviderRunMetrics(lastRun.runId) : [];
  }

  // -------------------------------------------------------------------------
  // Token upsert
  // -------------------------------------------------------------------------

  upsertToken(token: DiscoveredToken): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tokens (mint, symbol, name, mcap_at_harvest, volume_24h_usd,
        holder_count, smart_wallet_count, kol_count, created_at,
        first_harvested_at, last_harvested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        mcap_at_harvest = excluded.mcap_at_harvest,
        volume_24h_usd = excluded.volume_24h_usd,
        holder_count = excluded.holder_count,
        smart_wallet_count = excluded.smart_wallet_count,
        kol_count = excluded.kol_count,
        last_harvested_at = excluded.last_harvested_at
    `).run(
      token.mint,
      token.symbol,
      token.name,
      token.marketCapUsd,
      token.volume24hUsd,
      token.holderCount,
      token.smartWalletCount,
      token.kolCount,
      token.createdAt,
      now,
      now,
    );
  }

  // -------------------------------------------------------------------------
  // Wallet upsert (with source/tag merging)
  // -------------------------------------------------------------------------

  upsertWallet(wallet: ExtractedWallet): { isNew: boolean } {
    const existing = this.db.prepare(`
      SELECT sources, tags, token_count, first_seen, wallet_label, twitter_username,
        twitter_name, avatar_url, provider_tags, token_tags, metadata_snapshot_at
      FROM wallets WHERE address = ?
    `).get(wallet.address) as {
      sources: string;
      tags: string;
      token_count: number;
      first_seen: number;
      wallet_label: string | null;
      twitter_username: string | null;
      twitter_name: string | null;
      avatar_url: string | null;
      provider_tags: string;
      token_tags: string;
      metadata_snapshot_at: number | null;
    } | undefined;

    const now = Date.now();
    const countsAsNewToken = wallet.mint
      ? !this.hasWalletTokenSighting(wallet.address, wallet.mint)
      : false;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO wallets (address, sources, tags, first_seen, last_seen,
          token_count, pnl_usd, win_rate, avg_buy_usd, pnl_snapshot_at,
          wallet_label, twitter_username, twitter_name, avatar_url,
          provider_tags, token_tags, metadata_snapshot_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        wallet.address,
        JSON.stringify([wallet.source]),
        JSON.stringify(wallet.tags),
        now,
        now,
        countsAsNewToken ? 1 : 0,
        wallet.pnlUsd,
        wallet.winRate,
        wallet.avgBuyUsd,
        wallet.pnlUsd != null ? now : null,
        normalizedText(wallet.walletLabel),
        normalizedText(wallet.twitterUsername),
        normalizedText(wallet.twitterName),
        normalizedText(wallet.avatarUrl),
        JSON.stringify(uniqueStrings(wallet.providerTags ?? [])),
        JSON.stringify(uniqueStrings(wallet.tokenTags ?? [])),
        wallet.metadataSnapshotAt ?? (hasPublicMetadata(wallet) ? now : null),
      );
      return { isNew: true };
    }

    // Merge sources
    const existingSources: Source[] = JSON.parse(existing.sources);
    if (!existingSources.includes(wallet.source)) {
      existingSources.push(wallet.source);
    }

    // Merge tags
    const existingTags: WalletTag[] = JSON.parse(existing.tags);
    for (const tag of wallet.tags) {
      if (!existingTags.includes(tag)) {
        existingTags.push(tag);
      }
    }

    const providerTags = mergeStringArrays(parseStringArray(existing.provider_tags), wallet.providerTags ?? []);
    const tokenTags = mergeStringArrays(parseStringArray(existing.token_tags), wallet.tokenTags ?? []);
    const incomingMetadataAt = wallet.metadataSnapshotAt ?? (hasPublicMetadata(wallet) ? now : null);
    const metadataSnapshotAt = incomingMetadataAt
      ? Math.max(existing.metadata_snapshot_at ?? 0, incomingMetadataAt)
      : existing.metadata_snapshot_at;

    this.db.prepare(`
      UPDATE wallets SET
        sources = ?,
        tags = ?,
        wallet_label = COALESCE(NULLIF(?, ''), wallet_label),
        twitter_username = COALESCE(NULLIF(?, ''), twitter_username),
        twitter_name = COALESCE(NULLIF(?, ''), twitter_name),
        avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
        provider_tags = ?,
        token_tags = ?,
        metadata_snapshot_at = COALESCE(?, metadata_snapshot_at),
        last_seen = ?,
        token_count = token_count + ?,
        pnl_usd = COALESCE(?, pnl_usd),
        win_rate = COALESCE(?, win_rate),
        avg_buy_usd = COALESCE(?, avg_buy_usd),
        pnl_snapshot_at = CASE WHEN ? IS NOT NULL THEN ? ELSE pnl_snapshot_at END
      WHERE address = ?
    `).run(
      JSON.stringify(existingSources),
      JSON.stringify(existingTags),
      normalizedText(wallet.walletLabel) ?? "",
      normalizedText(wallet.twitterUsername) ?? "",
      normalizedText(wallet.twitterName) ?? "",
      normalizedText(wallet.avatarUrl) ?? "",
      JSON.stringify(providerTags),
      JSON.stringify(tokenTags),
      metadataSnapshotAt,
      now,
      countsAsNewToken ? 1 : 0,
      wallet.pnlUsd,
      wallet.winRate,
      wallet.avgBuyUsd,
      wallet.pnlUsd, now,
      wallet.address,
    );
    return { isNew: false };
  }

  updateWalletPublicMetadata(wallet: ExtractedWallet): boolean {
    const existing = this.db.prepare(`
      SELECT sources, tags, wallet_label, twitter_username, twitter_name, avatar_url,
        provider_tags, token_tags, metadata_snapshot_at
      FROM wallets WHERE address = ?
    `).get(wallet.address) as {
      sources: string;
      tags: string;
      wallet_label: string | null;
      twitter_username: string | null;
      twitter_name: string | null;
      avatar_url: string | null;
      provider_tags: string;
      token_tags: string;
      metadata_snapshot_at: number | null;
    } | undefined;
    if (!existing) return false;

    const sources = mergeStringArrays(parseStringArray(existing.sources), [wallet.source]) as Source[];
    const tags = mergeStringArrays(parseStringArray(existing.tags), wallet.tags);
    const providerTags = mergeStringArrays(parseStringArray(existing.provider_tags), wallet.providerTags ?? []);
    const tokenTags = mergeStringArrays(parseStringArray(existing.token_tags), wallet.tokenTags ?? []);
    const metadataAt = wallet.metadataSnapshotAt ?? (hasPublicMetadata(wallet) ? Date.now() : null);
    const metadataSnapshotAt = metadataAt
      ? Math.max(existing.metadata_snapshot_at ?? 0, metadataAt)
      : existing.metadata_snapshot_at;

    this.db.prepare(`
      UPDATE wallets SET
        sources = ?,
        tags = ?,
        wallet_label = COALESCE(NULLIF(?, ''), wallet_label),
        twitter_username = COALESCE(NULLIF(?, ''), twitter_username),
        twitter_name = COALESCE(NULLIF(?, ''), twitter_name),
        avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
        provider_tags = ?,
        token_tags = ?,
        metadata_snapshot_at = COALESCE(?, metadata_snapshot_at)
      WHERE address = ?
    `).run(
      JSON.stringify(sources),
      JSON.stringify(tags),
      normalizedText(wallet.walletLabel) ?? "",
      normalizedText(wallet.twitterUsername) ?? "",
      normalizedText(wallet.twitterName) ?? "",
      normalizedText(wallet.avatarUrl) ?? "",
      JSON.stringify(providerTags),
      JSON.stringify(tokenTags),
      metadataSnapshotAt,
      wallet.address,
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Sighting insert (skip duplicates)
  // -------------------------------------------------------------------------

  insertSighting(sighting: SightingRecord): boolean {
    try {
      this.db.prepare(`
        INSERT INTO sightings (wallet_address, mint, action, amount_usd,
          token_mcap_usd, timestamp, source, signal_type, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sighting.walletAddress,
        sighting.mint,
        sighting.action,
        sighting.amountUsd,
        sighting.tokenMcapUsd,
        sighting.timestamp,
        sighting.source,
        sighting.signalType,
        sighting.runId,
      );
      return true;
    } catch (err: unknown) {
      // UNIQUE constraint violation = duplicate sighting, skip silently
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        return false;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Batch operations (transactional)
  // -------------------------------------------------------------------------

  ingestWallets(wallets: ExtractedWallet[], runId: string): { newCount: number; updatedCount: number; sightingCount: number } {
    let newCount = 0;
    let updatedCount = 0;
    let sightingCount = 0;

    const txn = this.db.transaction(() => {
      for (const w of wallets) {
        const { isNew } = this.upsertWallet(w);
        if (isNew) newCount++;
        else updatedCount++;

        const inserted = this.insertSighting({
          walletAddress: w.address,
          mint: w.mint,
          action: w.action,
          amountUsd: w.amountUsd,
          tokenMcapUsd: w.tokenMcapUsd,
          timestamp: w.timestamp,
          source: w.source,
          signalType: w.signalType,
          runId,
        });
        if (inserted) sightingCount++;
      }
    });
    txn();

    return { newCount, updatedCount, sightingCount };
  }

  private hasWalletTokenSighting(walletAddress: string, mint: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM sightings
      WHERE wallet_address = ? AND mint = ?
      LIMIT 1
    `).get(walletAddress, mint);
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  getWalletCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM wallets").get() as { cnt: number };
    return row.cnt;
  }

  getSightingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM sightings").get() as { cnt: number };
    return row.cnt;
  }

  getTokenCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM tokens").get() as { cnt: number };
    return row.cnt;
  }

  getRunCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM runs").get() as { cnt: number };
    return row.cnt;
  }

  getTopWalletsByTokenCount(limit = 50): WalletRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM wallets ORDER BY token_count DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.mapWalletRow(r));
  }

  getDualSourceWallets(): WalletRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM wallets
      WHERE sources LIKE '%gmgn%' AND sources LIKE '%okx%'
      ORDER BY token_count DESC
    `).all() as Record<string, unknown>[];
    return rows.map(r => this.mapWalletRow(r));
  }

  getWalletSourceCounts(): { gmgnOnly: number; okxOnly: number; dualSource: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN sources LIKE '%gmgn%' AND sources NOT LIKE '%okx%' THEN 1 ELSE 0 END) AS gmgn_only,
        SUM(CASE WHEN sources LIKE '%okx%' AND sources NOT LIKE '%gmgn%' THEN 1 ELSE 0 END) AS okx_only,
        SUM(CASE WHEN sources LIKE '%gmgn%' AND sources LIKE '%okx%' THEN 1 ELSE 0 END) AS dual_source
      FROM wallets
    `).get() as { gmgn_only: number | null; okx_only: number | null; dual_source: number | null };
    return {
      gmgnOnly: row.gmgn_only ?? 0,
      okxOnly: row.okx_only ?? 0,
      dualSource: row.dual_source ?? 0,
    };
  }

  getSightingSourceCounts(): { gmgn: number; okx: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN source = 'gmgn' THEN 1 ELSE 0 END) AS gmgn,
        SUM(CASE WHEN source = 'okx' THEN 1 ELSE 0 END) AS okx
      FROM sightings
    `).get() as { gmgn: number | null; okx: number | null };
    return {
      gmgn: row.gmgn ?? 0,
      okx: row.okx ?? 0,
    };
  }

  getWalletReviewRows(limit = 2000): Array<{
    address: string;
    sources: Source[];
    tags: WalletTag[];
    walletLabel: string | null;
    twitterUsername: string | null;
    twitterName: string | null;
    avatarUrl: string | null;
    providerTags: string[];
    tokenTags: string[];
    metadataSnapshotAt: number | null;
    sourceType: "dual" | "gmgn_only" | "okx_only";
    tokenCount: number;
    totalSightings: number;
    gmgnSightings: number;
    okxSightings: number;
    pnlUsd: number | null;
    winRate: number | null;
    avgBuyUsd: number | null;
    firstSeen: number;
    lastSeen: number;
  }> {
    const rows = this.db.prepare(`
      SELECT
        w.address,
        w.sources,
        w.tags,
        w.wallet_label,
        w.twitter_username,
        w.twitter_name,
        w.avatar_url,
        w.provider_tags,
        w.token_tags,
        w.metadata_snapshot_at,
        w.token_count,
        w.pnl_usd,
        w.win_rate,
        w.avg_buy_usd,
        w.first_seen,
        w.last_seen,
        COUNT(s.id) AS total_sightings,
        SUM(CASE WHEN s.source = 'gmgn' THEN 1 ELSE 0 END) AS gmgn_sightings,
        SUM(CASE WHEN s.source = 'okx' THEN 1 ELSE 0 END) AS okx_sightings
      FROM wallets w
      LEFT JOIN sightings s ON s.wallet_address = w.address
      GROUP BY w.address
      ORDER BY
        CASE WHEN w.sources LIKE '%gmgn%' AND w.sources LIKE '%okx%' THEN 0 ELSE 1 END,
        w.token_count DESC,
        w.last_seen DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map(r => {
      const sources = JSON.parse(r.sources as string) as Source[];
      const tags = JSON.parse(r.tags as string) as WalletTag[];
      const hasGmgn = sources.includes("gmgn");
      const hasOkx = sources.includes("okx");
      return {
        address: r.address as string,
        sources,
        tags,
        walletLabel: r.wallet_label as string | null,
        twitterUsername: r.twitter_username as string | null,
        twitterName: r.twitter_name as string | null,
        avatarUrl: r.avatar_url as string | null,
        providerTags: parseStringArray(r.provider_tags as string),
        tokenTags: parseStringArray(r.token_tags as string),
        metadataSnapshotAt: r.metadata_snapshot_at as number | null,
        sourceType: hasGmgn && hasOkx ? "dual" : hasGmgn ? "gmgn_only" : "okx_only",
        tokenCount: r.token_count as number,
        totalSightings: r.total_sightings as number,
        gmgnSightings: (r.gmgn_sightings as number | null) ?? 0,
        okxSightings: (r.okx_sightings as number | null) ?? 0,
        pnlUsd: r.pnl_usd as number | null,
        winRate: r.win_rate as number | null,
        avgBuyUsd: r.avg_buy_usd as number | null,
        firstSeen: r.first_seen as number,
        lastSeen: r.last_seen as number,
      };
    });
  }

  getGmgnRenownedMintContexts(limit?: number): DiscoveredToken[] {
    const limitClause = limit && limit > 0 ? "LIMIT ?" : "";
    const params = limit && limit > 0 ? [limit] : [];
    const rows = this.db.prepare(`
      SELECT
        s.mint,
        COALESCE(t.symbol, '') AS symbol,
        COALESCE(t.name, '') AS name,
        COALESCE(t.mcap_at_harvest, 0) AS market_cap_usd,
        COALESCE(t.volume_24h_usd, 0) AS volume_24h_usd,
        COALESCE(t.holder_count, 0) AS holder_count,
        COALESCE(t.smart_wallet_count, 0) AS smart_wallet_count,
        COALESCE(t.kol_count, 0) AS kol_count,
        COALESCE(t.created_at, 0) AS created_at,
        MAX(s.timestamp) AS last_seen
      FROM sightings s
      LEFT JOIN tokens t ON t.mint = s.mint
      WHERE s.source = 'gmgn'
        AND s.mint <> ''
        AND s.signal_type LIKE 'renowned_%'
      GROUP BY s.mint
      ORDER BY last_seen DESC
      ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map(row => ({
      mint: row.mint as string,
      symbol: row.symbol as string,
      name: row.name as string,
      chain: "sol",
      marketCapUsd: row.market_cap_usd as number,
      volume24hUsd: row.volume_24h_usd as number,
      holderCount: row.holder_count as number,
      smartWalletCount: row.smart_wallet_count as number,
      kolCount: row.kol_count as number,
      createdAt: (row.created_at as number) || (row.last_seen as number) || Date.now(),
      discoverySource: "gmgn",
      discoveryMethod: "gmgn_renowned_backfill",
    }));
  }

  // -------------------------------------------------------------------------
  // Trade history
  // -------------------------------------------------------------------------

  upsertTrade(trade: TradeRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO trades (
        wallet_address, signature, mint, side, token_amount, sol_amount,
        usd_amount, price_usd, price_sol, timestamp, program, slot,
        raw_json, collected_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.walletAddress,
      trade.signature,
      trade.mint,
      trade.side,
      trade.tokenAmount,
      trade.solAmount,
      trade.usdAmount,
      trade.priceUsd,
      trade.priceSol,
      trade.timestamp,
      trade.program,
      trade.slot,
      trade.rawJson,
      trade.collectedAtMs,
    );
    return result.changes > 0;
  }

  getTradeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM trades").get() as { cnt: number };
    return row.cnt;
  }

  getWalletTradeCollectionState(address: string): { lastCollectedAt: number | null; tradeCount: number } {
    const row = this.db.prepare(`
      SELECT MAX(collected_at_ms) AS last_collected_at, COUNT(*) AS trade_count
      FROM trades
      WHERE wallet_address = ?
    `).get(address) as { last_collected_at: number | null; trade_count: number };
    return {
      lastCollectedAt: row.last_collected_at,
      tradeCount: row.trade_count,
    };
  }

  getAllWalletAddresses(): string[] {
    const rows = this.db.prepare("SELECT address FROM wallets ORDER BY address").all() as Array<{ address: string }>;
    return rows.map(r => r.address);
  }

  getTradesForWalletMint(walletAddress: string, mint: string): TradeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM trades
      WHERE wallet_address = ? AND mint = ?
      ORDER BY timestamp ASC
    `).all(walletAddress, mint) as Record<string, unknown>[];
    return rows.map(r => ({
      walletAddress: r.wallet_address as string,
      signature: r.signature as string,
      mint: r.mint as string,
      side: r.side as "buy" | "sell",
      tokenAmount: r.token_amount as number,
      solAmount: r.sol_amount as number,
      usdAmount: r.usd_amount as number | null,
      priceUsd: r.price_usd as number | null,
      priceSol: r.price_sol as number | null,
      timestamp: r.timestamp as number,
      program: r.program as string | null,
      slot: r.slot as number | null,
      rawJson: r.raw_json as string | null,
      collectedAtMs: r.collected_at_ms as number,
    }));
  }

  getDistinctWalletMintPairs(): Array<{ wallet_address: string; mint: string }> {
    return this.db.prepare(`
      SELECT DISTINCT wallet_address, mint FROM trades ORDER BY wallet_address, mint
    `).all() as Array<{ wallet_address: string; mint: string }>;
  }

  upsertPosition(pos: PositionRecord): boolean {
    const result = this.db.prepare(`
      INSERT INTO positions (
        wallet_address, mint, status, entry_count, first_entry_ts, last_entry_ts,
        avg_entry_price, total_sol_in, total_token_in, entry_mcap_usd,
        exit_count, first_exit_ts, last_exit_ts, avg_exit_price,
        total_sol_out, total_token_out, realized_sol, realized_usd, realized_pct,
        hold_duration_s, entry_spread_s, exit_spread_s,
        is_dca, is_scale_in, is_partial_tp, is_full_exit, is_trailing_like,
        trade_ids_json, built_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(wallet_address, mint, first_entry_ts) DO UPDATE SET
        status = excluded.status,
        entry_count = excluded.entry_count,
        last_entry_ts = excluded.last_entry_ts,
        avg_entry_price = excluded.avg_entry_price,
        total_sol_in = excluded.total_sol_in,
        total_token_in = excluded.total_token_in,
        entry_mcap_usd = excluded.entry_mcap_usd,
        exit_count = excluded.exit_count,
        first_exit_ts = excluded.first_exit_ts,
        last_exit_ts = excluded.last_exit_ts,
        avg_exit_price = excluded.avg_exit_price,
        total_sol_out = excluded.total_sol_out,
        total_token_out = excluded.total_token_out,
        realized_sol = excluded.realized_sol,
        realized_usd = excluded.realized_usd,
        realized_pct = excluded.realized_pct,
        hold_duration_s = excluded.hold_duration_s,
        entry_spread_s = excluded.entry_spread_s,
        exit_spread_s = excluded.exit_spread_s,
        is_dca = excluded.is_dca,
        is_scale_in = excluded.is_scale_in,
        is_partial_tp = excluded.is_partial_tp,
        is_full_exit = excluded.is_full_exit,
        is_trailing_like = excluded.is_trailing_like,
        trade_ids_json = excluded.trade_ids_json,
        built_at_ms = excluded.built_at_ms
    `).run(
      pos.walletAddress,
      pos.mint,
      pos.status,
      pos.entryCount,
      pos.firstEntryTs,
      pos.lastEntryTs,
      pos.avgEntryPrice,
      pos.totalSolIn,
      pos.totalTokenIn,
      pos.entryMcapUsd,
      pos.exitCount,
      pos.firstExitTs,
      pos.lastExitTs,
      pos.avgExitPrice,
      pos.totalSolOut,
      pos.totalTokenOut,
      pos.realizedSol,
      pos.realizedUsd,
      pos.realizedPct,
      pos.holdDurationS,
      pos.entrySpreadS,
      pos.exitSpreadS,
      pos.isDca,
      pos.isScaleIn,
      pos.isPartialTp,
      pos.isFullExit,
      pos.isTrailingLike,
      pos.tradeIdsJson,
      pos.builtAtMs,
    );
    return result.changes > 0;
  }

  getPositionCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM positions").get() as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Trade context (S3)
  // -------------------------------------------------------------------------

  upsertTradeContext(ctx: TradeContextRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR REPLACE INTO trade_context (
        trade_id, position_id, mint,
        candle_open, candle_high, candle_low, candle_close, candle_volume,
        rsi_14, vwap, bb_upper, bb_middle, bb_lower, bb_position,
        volume_ratio, ema_9, ema_21, ema_trend,
        distance_from_high_pct, distance_from_low_pct,
        atr_14, momentum_5, momentum_15, momentum_60,
        timeframe, candles_used, computed_at_ms
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      ctx.tradeId,
      ctx.positionId,
      ctx.mint,
      ctx.candleOpen,
      ctx.candleHigh,
      ctx.candleLow,
      ctx.candleClose,
      ctx.candleVolume,
      ctx.rsi14,
      ctx.vwap,
      ctx.bbUpper,
      ctx.bbMiddle,
      ctx.bbLower,
      ctx.bbPosition,
      ctx.volumeRatio,
      ctx.ema9,
      ctx.ema21,
      ctx.emaTrend,
      ctx.distanceFromHighPct,
      ctx.distanceFromLowPct,
      ctx.atr14,
      ctx.momentum5,
      ctx.momentum15,
      ctx.momentum60,
      ctx.timeframe,
      ctx.candlesUsed,
      ctx.computedAtMs,
    );
    return result.changes > 0;
  }

  getTradeContextCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM trade_context").get() as { cnt: number };
    return row.cnt;
  }

  getTradesWithoutContext(): TradeRecord[] {
    const rows = this.db.prepare(`
      SELECT t.* FROM trades t
      LEFT JOIN trade_context tc ON tc.trade_id = t.id
      WHERE tc.trade_id IS NULL
      ORDER BY t.timestamp ASC
    `).all() as Record<string, unknown>[];
    return rows.map(r => ({
      walletAddress: r.wallet_address as string,
      signature: r.signature as string,
      mint: r.mint as string,
      side: r.side as "buy" | "sell",
      tokenAmount: r.token_amount as number,
      solAmount: r.sol_amount as number,
      usdAmount: r.usd_amount as number | null,
      priceUsd: r.price_usd as number | null,
      priceSol: r.price_sol as number | null,
      timestamp: r.timestamp as number,
      program: r.program as string | null,
      slot: r.slot as number | null,
      rawJson: r.raw_json as string | null,
      collectedAtMs: r.collected_at_ms as number,
      id: r.id as number,
    } as TradeRecord & { id: number }));
  }

  getDistinctMintsFromTrades(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT mint FROM trades ORDER BY mint"
    ).all() as Array<{ mint: string }>;
    return rows.map(r => r.mint);
  }

  /** Raw SQL query for hypothesis testing */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  // -------------------------------------------------------------------------
  // Strategy classifier (S4)
  // -------------------------------------------------------------------------

  getAllWalletAddressesWithPositions(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT wallet_address FROM positions ORDER BY wallet_address
    `).all() as Array<{ wallet_address: string }>;
    return rows.map(r => r.wallet_address);
  }

  getPositionsForWallet(walletAddress: string): PositionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM positions WHERE wallet_address = ? ORDER BY first_entry_ts ASC
    `).all(walletAddress) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      walletAddress: r.wallet_address as string,
      mint: r.mint as string,
      status: r.status as "open" | "closed",
      entryCount: r.entry_count as number,
      firstEntryTs: r.first_entry_ts as number,
      lastEntryTs: r.last_entry_ts as number,
      avgEntryPrice: r.avg_entry_price as number | null,
      totalSolIn: r.total_sol_in as number,
      totalTokenIn: r.total_token_in as number,
      entryMcapUsd: r.entry_mcap_usd as number | null,
      exitCount: r.exit_count as number,
      firstExitTs: r.first_exit_ts as number | null,
      lastExitTs: r.last_exit_ts as number | null,
      avgExitPrice: r.avg_exit_price as number | null,
      totalSolOut: r.total_sol_out as number,
      totalTokenOut: r.total_token_out as number,
      realizedSol: r.realized_sol as number | null,
      realizedUsd: r.realized_usd as number | null,
      realizedPct: r.realized_pct as number | null,
      holdDurationS: r.hold_duration_s as number | null,
      entrySpreadS: r.entry_spread_s as number,
      exitSpreadS: r.exit_spread_s as number | null,
      isDca: r.is_dca as number,
      isScaleIn: r.is_scale_in as number,
      isPartialTp: r.is_partial_tp as number,
      isFullExit: r.is_full_exit as number,
      isTrailingLike: r.is_trailing_like as number,
      tradeIdsJson: r.trade_ids_json as string,
      builtAtMs: r.built_at_ms as number,
    }));
  }

  getTradeContextForTrades(tradeIds: number[]): TradeContextRecord[] {
    if (tradeIds.length === 0) return [];
    const placeholders = tradeIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM trade_context WHERE trade_id IN (${placeholders})
    `).all(...tradeIds) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      tradeId: r.trade_id as number,
      positionId: r.position_id as number | null,
      mint: r.mint as string,
      candleOpen: r.candle_open as number | null,
      candleHigh: r.candle_high as number | null,
      candleLow: r.candle_low as number | null,
      candleClose: r.candle_close as number | null,
      candleVolume: r.candle_volume as number | null,
      rsi14: r.rsi_14 as number | null,
      vwap: r.vwap as number | null,
      bbUpper: r.bb_upper as number | null,
      bbMiddle: r.bb_middle as number | null,
      bbLower: r.bb_lower as number | null,
      bbPosition: r.bb_position as number | null,
      volumeRatio: r.volume_ratio as number | null,
      ema9: r.ema_9 as number | null,
      ema21: r.ema_21 as number | null,
      emaTrend: r.ema_trend as string | null,
      distanceFromHighPct: r.distance_from_high_pct as number | null,
      distanceFromLowPct: r.distance_from_low_pct as number | null,
      atr14: r.atr_14 as number | null,
      momentum5: r.momentum_5 as number | null,
      momentum15: r.momentum_15 as number | null,
      momentum60: r.momentum_60 as number | null,
      timeframe: r.timeframe as string,
      candlesUsed: r.candles_used as number | null,
      computedAtMs: r.computed_at_ms as number,
    }));
  }

  upsertWalletStrategy(s: WalletStrategyRecord): boolean {
    const result = this.db.prepare(`
      INSERT INTO wallet_strategies (
        wallet_address, total_positions, closed_positions, open_positions,
        single_entry_pct, dca_pct, scale_in_pct, avg_entries_per_pos,
        single_exit_pct, partial_tp_pct, trailing_exit_pct, avg_exits_per_pos,
        median_tp_pct, p25_tp_pct, p75_tp_pct,
        median_sl_pct, p25_sl_pct, p75_sl_pct,
        trailing_detected, trailing_drop_pct,
        median_hold_s, avg_hold_s, median_entry_hour,
        median_entry_mcap, avg_entry_mcap, pct_under_200k,
        win_rate, avg_pnl_pct, median_pnl_pct, sharpe_like,
        archetype, is_likely_bot, confidence,
        analyzed_at_ms, analysis_version
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(wallet_address) DO UPDATE SET
        total_positions = excluded.total_positions,
        closed_positions = excluded.closed_positions,
        open_positions = excluded.open_positions,
        single_entry_pct = excluded.single_entry_pct,
        dca_pct = excluded.dca_pct,
        scale_in_pct = excluded.scale_in_pct,
        avg_entries_per_pos = excluded.avg_entries_per_pos,
        single_exit_pct = excluded.single_exit_pct,
        partial_tp_pct = excluded.partial_tp_pct,
        trailing_exit_pct = excluded.trailing_exit_pct,
        avg_exits_per_pos = excluded.avg_exits_per_pos,
        median_tp_pct = excluded.median_tp_pct,
        p25_tp_pct = excluded.p25_tp_pct,
        p75_tp_pct = excluded.p75_tp_pct,
        median_sl_pct = excluded.median_sl_pct,
        p25_sl_pct = excluded.p25_sl_pct,
        p75_sl_pct = excluded.p75_sl_pct,
        trailing_detected = excluded.trailing_detected,
        trailing_drop_pct = excluded.trailing_drop_pct,
        median_hold_s = excluded.median_hold_s,
        avg_hold_s = excluded.avg_hold_s,
        median_entry_hour = excluded.median_entry_hour,
        median_entry_mcap = excluded.median_entry_mcap,
        avg_entry_mcap = excluded.avg_entry_mcap,
        pct_under_200k = excluded.pct_under_200k,
        win_rate = excluded.win_rate,
        avg_pnl_pct = excluded.avg_pnl_pct,
        median_pnl_pct = excluded.median_pnl_pct,
        sharpe_like = excluded.sharpe_like,
        archetype = excluded.archetype,
        is_likely_bot = excluded.is_likely_bot,
        confidence = excluded.confidence,
        analyzed_at_ms = excluded.analyzed_at_ms,
        analysis_version = excluded.analysis_version
    `).run(
      s.walletAddress,
      s.totalPositions,
      s.closedPositions,
      s.openPositions,
      s.singleEntryPct,
      s.dcaPct,
      s.scaleInPct,
      s.avgEntriesPerPos,
      s.singleExitPct,
      s.partialTpPct,
      s.trailingExitPct,
      s.avgExitsPerPos,
      s.medianTpPct,
      s.p25TpPct,
      s.p75TpPct,
      s.medianSlPct,
      s.p25SlPct,
      s.p75SlPct,
      s.trailingDetected,
      s.trailingDropPct,
      s.medianHoldS,
      s.avgHoldS,
      s.medianEntryHour,
      s.medianEntryMcap,
      s.avgEntryMcap,
      s.pctUnder200k,
      s.winRate,
      s.avgPnlPct,
      s.medianPnlPct,
      s.sharpeLike,
      s.archetype,
      s.isLikelyBot,
      s.confidence,
      s.analyzedAtMs,
      s.analysisVersion,
    );
    return result.changes > 0;
  }

  getWalletStrategyCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM wallet_strategies").get() as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // S5 report read methods
  // -------------------------------------------------------------------------

  getAllWalletStrategies(): WalletStrategyRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM wallet_strategies ORDER BY wallet_address"
    ).all() as Record<string, unknown>[];
    return rows.map(r => ({
      walletAddress: r.wallet_address as string,
      totalPositions: r.total_positions as number,
      closedPositions: r.closed_positions as number,
      openPositions: r.open_positions as number,
      singleEntryPct: r.single_entry_pct as number | null,
      dcaPct: r.dca_pct as number | null,
      scaleInPct: r.scale_in_pct as number | null,
      avgEntriesPerPos: r.avg_entries_per_pos as number | null,
      singleExitPct: r.single_exit_pct as number | null,
      partialTpPct: r.partial_tp_pct as number | null,
      trailingExitPct: r.trailing_exit_pct as number | null,
      avgExitsPerPos: r.avg_exits_per_pos as number | null,
      medianTpPct: r.median_tp_pct as number | null,
      p25TpPct: r.p25_tp_pct as number | null,
      p75TpPct: r.p75_tp_pct as number | null,
      medianSlPct: r.median_sl_pct as number | null,
      p25SlPct: r.p25_sl_pct as number | null,
      p75SlPct: r.p75_sl_pct as number | null,
      trailingDetected: r.trailing_detected as number,
      trailingDropPct: r.trailing_drop_pct as number | null,
      medianHoldS: r.median_hold_s as number | null,
      avgHoldS: r.avg_hold_s as number | null,
      medianEntryHour: r.median_entry_hour as number | null,
      medianEntryMcap: r.median_entry_mcap as number | null,
      avgEntryMcap: r.avg_entry_mcap as number | null,
      pctUnder200k: r.pct_under_200k as number | null,
      winRate: r.win_rate as number | null,
      avgPnlPct: r.avg_pnl_pct as number | null,
      medianPnlPct: r.median_pnl_pct as number | null,
      sharpeLike: r.sharpe_like as number | null,
      archetype: r.archetype as string,
      isLikelyBot: r.is_likely_bot as number,
      confidence: r.confidence as number,
      analyzedAtMs: r.analyzed_at_ms as number,
      analysisVersion: r.analysis_version as number,
    }));
  }

  getClosedPositionsWithPnl(): PositionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM positions
      WHERE status = 'closed' AND realized_pct IS NOT NULL
      ORDER BY wallet_address, first_entry_ts
    `).all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      walletAddress: r.wallet_address as string,
      mint: r.mint as string,
      status: r.status as "open" | "closed",
      entryCount: r.entry_count as number,
      firstEntryTs: r.first_entry_ts as number,
      lastEntryTs: r.last_entry_ts as number,
      avgEntryPrice: r.avg_entry_price as number | null,
      totalSolIn: r.total_sol_in as number,
      totalTokenIn: r.total_token_in as number,
      entryMcapUsd: r.entry_mcap_usd as number | null,
      exitCount: r.exit_count as number,
      firstExitTs: r.first_exit_ts as number | null,
      lastExitTs: r.last_exit_ts as number | null,
      avgExitPrice: r.avg_exit_price as number | null,
      totalSolOut: r.total_sol_out as number,
      totalTokenOut: r.total_token_out as number,
      realizedSol: r.realized_sol as number | null,
      realizedUsd: r.realized_usd as number | null,
      realizedPct: r.realized_pct as number | null,
      holdDurationS: r.hold_duration_s as number | null,
      entrySpreadS: r.entry_spread_s as number,
      exitSpreadS: r.exit_spread_s as number | null,
      isDca: r.is_dca as number,
      isScaleIn: r.is_scale_in as number,
      isPartialTp: r.is_partial_tp as number,
      isFullExit: r.is_full_exit as number,
      isTrailingLike: r.is_trailing_like as number,
      tradeIdsJson: r.trade_ids_json as string,
      builtAtMs: r.built_at_ms as number,
    }));
  }

  getEntryTradeContextForPositions(): Array<{ position: PositionRecord; context: TradeContextRecord | null }> {
    const positions = this.getClosedPositionsWithPnl();
    const result: Array<{ position: PositionRecord; context: TradeContextRecord | null }> = [];

    for (const pos of positions) {
      let tradeIds: number[] = [];
      try {
        const parsed = JSON.parse(pos.tradeIdsJson) as unknown;
        if (Array.isArray(parsed)) {
          tradeIds = parsed.filter((v): v is number => typeof v === "number");
        }
      } catch {
        // malformed JSON — skip
      }

      if (tradeIds.length === 0) {
        result.push({ position: pos, context: null });
        continue;
      }

      // Find the first entry trade (lowest id among all trade ids)
      const firstTradeId = Math.min(...tradeIds);

      const ctxRow = this.db.prepare(
        "SELECT * FROM trade_context WHERE trade_id = ?"
      ).get(firstTradeId) as Record<string, unknown> | undefined;

      if (!ctxRow) {
        result.push({ position: pos, context: null });
        continue;
      }

      const context: TradeContextRecord = {
        id: ctxRow.id as number,
        tradeId: ctxRow.trade_id as number,
        positionId: ctxRow.position_id as number | null,
        mint: ctxRow.mint as string,
        candleOpen: ctxRow.candle_open as number | null,
        candleHigh: ctxRow.candle_high as number | null,
        candleLow: ctxRow.candle_low as number | null,
        candleClose: ctxRow.candle_close as number | null,
        candleVolume: ctxRow.candle_volume as number | null,
        rsi14: ctxRow.rsi_14 as number | null,
        vwap: ctxRow.vwap as number | null,
        bbUpper: ctxRow.bb_upper as number | null,
        bbMiddle: ctxRow.bb_middle as number | null,
        bbLower: ctxRow.bb_lower as number | null,
        bbPosition: ctxRow.bb_position as number | null,
        volumeRatio: ctxRow.volume_ratio as number | null,
        ema9: ctxRow.ema_9 as number | null,
        ema21: ctxRow.ema_21 as number | null,
        emaTrend: ctxRow.ema_trend as string | null,
        distanceFromHighPct: ctxRow.distance_from_high_pct as number | null,
        distanceFromLowPct: ctxRow.distance_from_low_pct as number | null,
        atr14: ctxRow.atr_14 as number | null,
        momentum5: ctxRow.momentum_5 as number | null,
        momentum15: ctxRow.momentum_15 as number | null,
        momentum60: ctxRow.momentum_60 as number | null,
        timeframe: ctxRow.timeframe as string,
        candlesUsed: ctxRow.candles_used as number | null,
        computedAtMs: ctxRow.computed_at_ms as number,
      };

      result.push({ position: pos, context });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private mapWalletRow(r: Record<string, unknown>): WalletRecord {
    return {
      address: r.address as string,
      sources: JSON.parse(r.sources as string) as Source[],
      tags: JSON.parse(r.tags as string) as WalletTag[],
      walletLabel: r.wallet_label as string | null,
      twitterUsername: r.twitter_username as string | null,
      twitterName: r.twitter_name as string | null,
      avatarUrl: r.avatar_url as string | null,
      providerTags: parseStringArray(r.provider_tags as string),
      tokenTags: parseStringArray(r.token_tags as string),
      metadataSnapshotAt: r.metadata_snapshot_at as number | null,
      firstSeen: r.first_seen as number,
      lastSeen: r.last_seen as number,
      tokenCount: r.token_count as number,
      pnlUsd: r.pnl_usd as number | null,
      winRate: r.win_rate as number | null,
      avgBuyUsd: r.avg_buy_usd as number | null,
      pnlSnapshotAt: r.pnl_snapshot_at as number | null,
    };
  }

  private mapRunRow(r: Record<string, unknown>): RunRecord {
    return {
      runId: r.run_id as string,
      startedAt: r.started_at as number,
      finishedAt: r.finished_at as number | null,
      tokensDiscovered: r.tokens_discovered as number,
      tokensHarvested: r.tokens_harvested as number,
      walletsNew: r.wallets_new as number,
      walletsUpdated: r.wallets_updated as number,
      sightingsAdded: r.sightings_added as number,
      errors: JSON.parse(r.errors as string) as string[],
      status: r.status as RunRecord["status"],
    };
  }

  close(): void {
    this.db.close();
  }

  private migrateWalletMetadataColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>;
    const existing = new Set(columns.map(column => column.name));
    const additions: Array<[string, string]> = [
      ["wallet_label", "TEXT"],
      ["twitter_username", "TEXT"],
      ["twitter_name", "TEXT"],
      ["avatar_url", "TEXT"],
      ["provider_tags", "TEXT NOT NULL DEFAULT '[]'"],
      ["token_tags", "TEXT NOT NULL DEFAULT '[]'"],
      ["metadata_snapshot_at", "INTEGER"],
    ];

    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.db.prepare(`ALTER TABLE wallets ADD COLUMN ${name} ${definition}`).run();
      }
    }
  }
}

function normalizedText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function mergeStringArrays(existing: string[], incoming: string[]): string[] {
  return uniqueStrings([...existing, ...incoming]);
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? uniqueStrings(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

function hasPublicMetadata(wallet: ExtractedWallet): boolean {
  return Boolean(
    normalizedText(wallet.walletLabel) ||
    normalizedText(wallet.twitterUsername) ||
    normalizedText(wallet.twitterName) ||
    normalizedText(wallet.avatarUrl) ||
    (wallet.providerTags?.length ?? 0) > 0 ||
    (wallet.tokenTags?.length ?? 0) > 0
  );
}
