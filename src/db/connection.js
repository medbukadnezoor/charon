import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      candidate_count INTEGER,
      request_bytes INTEGER,
      response_bytes INTEGER,
      latency_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      token_estimate_method TEXT,
      estimated_cost_usd REAL,
      error_class TEXT
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      effective_sl_percent REAL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      breakeven_armed INTEGER NOT NULL DEFAULT 0,
      breakeven_armed_at_ms INTEGER,
      breakeven_lock_percent REAL NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      batch_at_ms INTEGER,
      signal_batch_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS screening_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      mint TEXT NOT NULL,
      strategy_id TEXT,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      reason_code TEXT,
      reason_text TEXT,
      signal_key TEXT,
      candidate_id INTEGER,
      batch_id INTEGER,
      execution_mode TEXT,
      source_count INTEGER,
      sources_json TEXT NOT NULL,
      route TEXT,
      age_ms INTEGER,
      age_threshold_ms INTEGER,
      has_fee_claim INTEGER,
      fee_claim_sol REAL,
      market_cap_usd REAL,
      holder_count INTEGER,
      max_holder_percent REAL,
      saved_wallet_holders INTEGER,
      gmgn_total_fee_sol REAL,
      graduated_volume_usd REAL,
      trending_source TEXT,
      trending_volume_usd REAL,
      trending_swaps INTEGER,
      trending_rug_ratio REAL,
      trending_bundler_rate REAL,
      trending_is_wash_trading INTEGER,
      provider_fields_json TEXT NOT NULL,
      config_snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mint_blacklist (
      mint TEXT PRIMARY KEY,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployer_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      deployer TEXT,
      creator TEXT,
      exit_reason TEXT NOT NULL,
      loss_severity TEXT NOT NULL,
      pnl_percent REAL,
      pnl_sol REAL,
      rug_ratio REAL,
      top_holder_percent REAL,
      top20_holder_percent REAL,
      bundler_rate REAL,
      context_json TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_observation_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      source_instance TEXT NOT NULL,
      execution_lane TEXT NOT NULL,
      decision_stage TEXT NOT NULL,
      decision_action TEXT NOT NULL,
      decision_event_key TEXT NOT NULL UNIQUE,
      candidate_id INTEGER,
      screening_event_id INTEGER,
      batch_id INTEGER,
      position_id INTEGER,
      strategy_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      tier TEXT NOT NULL DEFAULT 'B',
      watch_status TEXT NOT NULL DEFAULT 'active',
      eligibility_reason TEXT,
      filter_blocker_count INTEGER NOT NULL DEFAULT 0,
      rug_risk_score REAL,
      next_observe_at_ms INTEGER NOT NULL,
      max_observation_until_ms INTEGER NOT NULL,
      claimed_at_ms INTEGER,
      lease_owner TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      baseline_snapshot_json TEXT NOT NULL,
      schedule_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      source_instance TEXT NOT NULL,
      execution_lane TEXT NOT NULL,
      observation_kind TEXT NOT NULL,
      provider_set TEXT NOT NULL,
      quality_flags_json TEXT NOT NULL,
      baseline_observation_id INTEGER,
      delta_metrics_json TEXT NOT NULL,
      price_usd REAL,
      market_cap_usd REAL,
      liquidity_usd REAL,
      volume_24h_usd REAL,
      holder_count INTEGER,
      top_holder_percent REAL,
      top20_holder_percent REAL,
      fee_claim_sol REAL,
      gmgn_total_fee_sol REAL,
      saved_wallet_holders INTEGER,
      saved_wallet_strong_count INTEGER,
      saved_wallet_kol_count INTEGER,
      trending_source TEXT,
      trending_volume_usd REAL,
      trending_swaps INTEGER,
      trending_rug_ratio REAL,
      trending_bundler_rate REAL,
      trending_is_wash_trading INTEGER,
      ohlcv_interval TEXT,
      ohlcv_candle_start_ms INTEGER,
      ohlcv_candle_end_ms INTEGER,
      ohlcv_open REAL,
      ohlcv_high REAL,
      ohlcv_low REAL,
      ohlcv_close REAL,
      ohlcv_volume REAL,
      ohlcv_finalized INTEGER,
      feature_snapshot_json TEXT NOT NULL,
      provider_payload_refs_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_call_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      source_instance TEXT,
      execution_lane TEXT,
      queue_id INTEGER,
      observation_id INTEGER,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      mint TEXT,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      cache_key TEXT,
      time_bucket TEXT,
      ttl_ms INTEGER,
      cache_age_ms INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      retry_after_ms INTEGER,
      skip_reason TEXT,
      native_cost_unit_kind TEXT,
      native_cost_unit_estimate REAL,
      error_class TEXT,
      error_message TEXT,
      payload_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS telemetry_collector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      collector_id TEXT NOT NULL,
      source_instance TEXT,
      execution_lane TEXT,
      status TEXT NOT NULL,
      claimed_count INTEGER NOT NULL DEFAULT 0,
      observed_count INTEGER NOT NULL DEFAULT 0,
      provider_ok_count INTEGER NOT NULL DEFAULT 0,
      provider_error_count INTEGER NOT NULL DEFAULT 0,
      cache_hit_count INTEGER NOT NULL DEFAULT 0,
      budget_skip_count INTEGER NOT NULL DEFAULT 0,
      stale_skip_count INTEGER NOT NULL DEFAULT 0,
      dropped_count INTEGER NOT NULL DEFAULT 0,
      stuck_lease_count INTEGER NOT NULL DEFAULT 0,
      overdue_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_response_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      mint TEXT,
      time_bucket TEXT,
      fetched_at_ms INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reentry_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      original_position_id INTEGER NOT NULL,
      entry_mcap REAL NOT NULL,
      sl_mcap REAL NOT NULL,
      stopped_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      reentry_triggered INTEGER DEFAULT 0,
      reentry_position_id INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_screening_events_at ON screening_events(at_ms);
    CREATE INDEX IF NOT EXISTS idx_screening_events_mint_at ON screening_events(mint, at_ms);
    CREATE INDEX IF NOT EXISTS idx_screening_events_stage_reason ON screening_events(stage, reason_code, at_ms);
    CREATE INDEX IF NOT EXISTS idx_screening_events_candidate ON screening_events(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_deployer_observations_mint ON deployer_observations(mint, observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_deployer_observations_deployer ON deployer_observations(deployer, observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created ON llm_usage_events(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_events_status ON llm_usage_events(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_token_observation_queue_due ON token_observation_queue(status, next_observe_at_ms);
    CREATE INDEX IF NOT EXISTS idx_token_observation_queue_mint ON token_observation_queue(mint, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_token_observation_queue_lane ON token_observation_queue(source_instance, execution_lane, status);
    CREATE INDEX IF NOT EXISTS idx_token_observations_mint_time ON token_observations(mint, observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_token_observations_queue ON token_observations(queue_id, observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_provider_call_ledger_mint_time ON provider_call_ledger(provider, endpoint, mint, at_ms);
    CREATE INDEX IF NOT EXISTS idx_provider_call_ledger_queue ON provider_call_ledger(queue_id, at_ms);
    CREATE INDEX IF NOT EXISTS idx_collector_runs_started ON telemetry_collector_runs(started_at_ms);
    CREATE INDEX IF NOT EXISTS idx_provider_response_cache_provider ON provider_response_cache(provider, endpoint, mint, time_bucket);
    CREATE INDEX IF NOT EXISTS idx_reentry_watchlist_mint ON reentry_watchlist (mint, reentry_triggered, expires_at_ms);
  `);
  // WP-M5-1: extend saved_wallets with cached intelligence columns
  ensureColumn('saved_wallets', 'tags_json', "TEXT DEFAULT '[]'");
  ensureColumn('saved_wallets', 'tier', "TEXT DEFAULT 'universe'");
  ensureColumn('saved_wallets', 'quality_score', 'REAL');
  ensureColumn('saved_wallets', 'source', "TEXT DEFAULT 'manual'");
  ensureColumn('saved_wallets', 'gmgn_winrate', 'REAL');
  ensureColumn('saved_wallets', 'gmgn_realized_pnl', 'REAL');
  ensureColumn('saved_wallets', 'gmgn_tags_json', 'TEXT');
  ensureColumn('saved_wallets', 'gmgn_twitter', 'TEXT');
  ensureColumn('saved_wallets', 'gmgn_snapshot_at', 'INTEGER');
  ensureColumn('saved_wallets', 'okx_winrate', 'REAL');
  ensureColumn('saved_wallets', 'okx_realized_pnl', 'REAL');
  ensureColumn('saved_wallets', 'okx_preferred_mcap', 'TEXT');
  ensureColumn('saved_wallets', 'okx_snapshot_at', 'INTEGER');
  ensureColumn('saved_wallets', 'jup_total_pnl', 'REAL');
  ensureColumn('saved_wallets', 'jup_winrate', 'REAL');
  ensureColumn('saved_wallets', 'jup_total_trades', 'INTEGER');
  ensureColumn('saved_wallets', 'jup_snapshot_at', 'INTEGER');
  ensureColumn('saved_wallets', 'owner_label', 'TEXT');
  ensureColumn('saved_wallets', 'owner_notes', 'TEXT');
  ensureColumn('saved_wallets', 'last_synced_at', 'INTEGER');
  ensureColumn('saved_wallets', 'harvester_last_seen', 'INTEGER');
  db.exec("UPDATE saved_wallets SET source = 'manual' WHERE source IS NULL");

  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('signal_events', 'batch_at_ms', 'INTEGER');
  ensureColumn('signal_events', 'signal_batch_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_events_batch ON signal_events(signal_batch_id, batch_at_ms)');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'breakeven_armed', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'breakeven_armed_at_ms', 'INTEGER');
  ensureColumn('dry_run_positions', 'breakeven_lock_percent', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'effective_sl_percent', 'REAL');
  ensureColumn('dry_run_positions', 'cutoff_checks', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'next_cutoff_at_ms', 'INTEGER');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
  ensureColumn('llm_batches', 'conclusion_count', 'INTEGER');
  ensureColumn('llm_batches', 'critical_count', 'INTEGER');
  ensureColumn('llm_batches', 'payload_size_bytes', 'INTEGER');
  ensureColumn('llm_batches', 'trim_stages', 'TEXT');
  ensureColumn('llm_batches', 'candidate_count', 'INTEGER');
  ensureColumn('llm_batches', 'rpc_enrichment_used', 'INTEGER DEFAULT 0');
  ensureColumn('screening_events', 'screening_path', "TEXT DEFAULT 'primary'");
  ensureColumn('screening_events', 'alternate_quality_score', 'INTEGER');

  const telemetryDefaults = {
    ledger_writer_enabled: process.env.LEDGER_WRITER_ENABLED || 'false',
    telemetry_tier_a_watch_ms: process.env.TELEMETRY_DEFAULT_WATCH_MS || String(24 * 60 * 60_000),
    telemetry_tier_b_watch_ms: process.env.TELEMETRY_TIER_B_WATCH_MS || String(6 * 60 * 60_000),
    telemetry_tier_c_watch_ms: process.env.TELEMETRY_TIER_C_WATCH_MS || String(60 * 60_000),
    telemetry_followup_buckets_ms: process.env.TELEMETRY_FOLLOWUP_BUCKETS_MS || '300000,900000,3600000,21600000,86400000',
    telemetry_initial_observe_delay_ms: process.env.TELEMETRY_INITIAL_OBSERVE_DELAY_MS || '0',
    telemetry_collector_mode: process.env.TELEMETRY_COLLECTOR_MODE || 'full',
    telemetry_birdeye_endpoints: process.env.TELEMETRY_BIRDEYE_ENDPOINTS || '',
    telemetry_birdeye_token_tx_fallback_enabled: process.env.TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED || 'true',
    telemetry_birdeye_daily_call_cap: process.env.TELEMETRY_BIRDEYE_DAILY_CALL_CAP || '0',
    telemetry_birdeye_budget_start_ms: process.env.TELEMETRY_BIRDEYE_BUDGET_START_MS || '0',
    telemetry_birdeye_budget_cooldown_ms: process.env.TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS || String(60 * 60_000),
    telemetry_min_watch_tier: process.env.TELEMETRY_MIN_WATCH_TIER || 'C',
    telemetry_min_observe_age_ms: process.env.TELEMETRY_MIN_OBSERVE_AGE_MS || '0',
  };
  const telemetryInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(telemetryDefaults)) telemetryInsert.run(key, value);

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_timeout_ms: process.env.LLM_TIMEOUT_MS || String(90 * 1000),
    llm_min_confidence: '75',
    llm_payload_budget_kb: '40',
    llm_max_conclusions_per_candidate: '8',
    llm_rpc_enrichment_enabled: 'true',
    llm_payload_debug_log: 'false',
    llm_intelligence_enabled: 'true',
    llm_cost_tracking_enabled: 'false',
    llm_input_cost_per_1m_tokens: '0',
    llm_output_cost_per_1m_tokens: '0',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
    dry_run_slippage_pct: '1.0',
    dry_run_fee_pct: '0.2',
    live_sell_dust_threshold_raw: '1000',
    max_hold_if_no_tp_ms: '0',
    early_token_age_ms: '0',
    early_token_sl_percent: '',
    breakeven_after_profit_percent: '0',
    breakeven_lock_percent: '0',
    insightx_enabled: 'false',
    insightx_plan: 'free',
    insightx_sample_rate: '0.005',
    insightx_rpm_cap: '5',
    insightx_monthly_cap: '500',
    insightx_request_timeout_ms: '5000',
    insightx_cache_ttl_ms: '600000',
    insightx_only_after_llm_pass: 'false',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 3600000,
    min_mcap_usd: 7000,
    max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 10,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    max_hold_if_no_tp_ms: 0,
    early_token_age_ms: 0,
    early_token_sl_percent: null,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
    use_llm: true,
    llm_min_confidence: 50,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    max_hold_if_no_tp_ms: 0,
    early_token_age_ms: 0,
    early_token_sl_percent: null,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
    use_llm: true,
    llm_min_confidence: 60,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 10000,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 1000,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 0,
    max_hold_if_no_tp_ms: 0,
    early_token_age_ms: 0,
    early_token_sl_percent: null,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.7,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 30,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    max_hold_if_no_tp_ms: 0,
    early_token_age_ms: 0,
    early_token_sl_percent: null,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
    use_llm: false,
    llm_min_confidence: 0,
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
