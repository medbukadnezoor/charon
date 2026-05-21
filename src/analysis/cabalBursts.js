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
    max_burst_density_per_minute: null,
    distinct_sources_in_max_burst: null,
    cabal_burst_detected: null,
    single_source_spam: null,
    cabal_coverage_status: status,
  };
}

function normalizeArgs(mintOrOptions, maybeOptions) {
  if (typeof mintOrOptions === 'object' && mintOrOptions !== null) return { mint: mintOrOptions.mint, options: mintOrOptions };
  return { mint: mintOrOptions, options: maybeOptions || {} };
}

function coverageStatus(count) {
  if (count >= 10) return 'ok';
  if (count >= 3) return 'sparse';
  return 'unsupported';
}

export function computeCabalBursts(signalEvents, mintOrOptions = {}, maybeOptions = {}) {
  const { mint, options } = normalizeArgs(mintOrOptions, maybeOptions);
  const {
    asOfMs = null,
    windowMs = 60_000,
    burstThreshold = 5,
    distinctSourceThreshold = 3,
  } = options;
  const cutoff = finiteInteger(asOfMs);
  const events = (Array.isArray(signalEvents) ? signalEvents : [])
    .filter(row => !mint || row?.mint === mint)
    .map(row => ({ ...row, at_ms: finiteInteger(row?.at_ms), source: row?.source == null ? null : String(row.source) }))
    .filter(row => row.at_ms != null)
    .filter(row => cutoff == null || row.at_ms <= cutoff)
    .sort((a, b) => a.at_ms - b.at_ms);
  const status = coverageStatus(events.length);
  if (events.length < 3) return emptySignals(status);

  let bestCount = 0;
  let bestSourceCount = 0;
  for (let start = 0; start < events.length; start += 1) {
    const startMs = events[start].at_ms;
    const windowEvents = [];
    for (let end = start; end < events.length; end += 1) {
      if (events[end].at_ms - startMs > windowMs) break;
      windowEvents.push(events[end]);
    }
    const sourceCount = new Set(windowEvents.map(row => row.source).filter(Boolean)).size;
    if (windowEvents.length > bestCount || (windowEvents.length === bestCount && sourceCount > bestSourceCount)) {
      bestCount = windowEvents.length;
      bestSourceCount = sourceCount;
    }
  }

  return {
    max_burst_density_per_minute: bestCount,
    distinct_sources_in_max_burst: bestSourceCount,
    cabal_burst_detected: bestCount >= burstThreshold && bestSourceCount >= distinctSourceThreshold,
    single_source_spam: bestCount >= burstThreshold && bestSourceCount === 1,
    cabal_coverage_status: status,
  };
}

export const CABAL_BURST_DEFAULTS = emptySignals();
