function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = finiteNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function emptySignals(status = 'unsupported') {
  return {
    gake_peak_holders: null,
    gake_current_holders: null,
    gake_exit_pct: null,
    gake_exit_50pct: null,
    strong_wallet_peak: null,
    strong_wallet_current: null,
    strong_wallet_exit_pct: null,
    strong_wallet_exit_50pct: null,
    kol_wallet_peak: null,
    kol_wallet_current: null,
    kol_wallet_exit_pct: null,
    kol_wallet_exit_50pct: null,
    gake_coverage_status: status,
  };
}

function rowsAtOrBefore(observations, asOfMs) {
  const cutoff = finiteInteger(asOfMs);
  return (Array.isArray(observations) ? observations : [])
    .filter(row => {
      if (cutoff == null) return true;
      const observedAt = finiteInteger(row?.observed_at_ms);
      return observedAt != null && observedAt <= cutoff;
    })
    .sort((a, b) => Number(a.observed_at_ms || 0) - Number(b.observed_at_ms || 0));
}

function series(rows, field) {
  return rows
    .map(row => finiteNumber(row?.[field]))
    .filter(value => value != null);
}

function exitStats(values) {
  if (!values.length) {
    return { peak: null, current: null, exitPct: null, exit50pct: null };
  }
  const peak = Math.max(...values);
  const current = values.at(-1);
  if (peak <= 0) {
    return { peak, current, exitPct: null, exit50pct: null };
  }
  const exitPct = ((peak - current) / peak) * 100;
  return {
    peak,
    current,
    exitPct,
    exit50pct: exitPct >= 50,
  };
}

function coverageStatus(count) {
  if (count >= 2) return 'ok';
  if (count === 1) return 'sparse';
  return 'unsupported';
}

export function computeGakeExitFlags(observations, { asOfMs = null } = {}) {
  const rows = rowsAtOrBefore(observations, asOfMs);
  const holderValues = series(rows, 'saved_wallet_holders');
  const status = coverageStatus(holderValues.length);
  if (!holderValues.length) return emptySignals(status);

  const gake = exitStats(holderValues);
  const strong = exitStats(series(rows, 'saved_wallet_strong_count'));
  const kol = exitStats(series(rows, 'saved_wallet_kol_count'));

  return {
    gake_peak_holders: gake.peak,
    gake_current_holders: gake.current,
    gake_exit_pct: gake.exitPct,
    gake_exit_50pct: gake.exit50pct,
    strong_wallet_peak: strong.peak,
    strong_wallet_current: strong.current,
    strong_wallet_exit_pct: strong.exitPct,
    strong_wallet_exit_50pct: strong.exit50pct,
    kol_wallet_peak: kol.peak,
    kol_wallet_current: kol.current,
    kol_wallet_exit_pct: kol.exitPct,
    kol_wallet_exit_50pct: kol.exit50pct,
    gake_coverage_status: status,
  };
}

export const GAKE_EXIT_DEFAULTS = emptySignals();
