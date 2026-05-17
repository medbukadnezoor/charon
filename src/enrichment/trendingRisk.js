function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function numberOrNull(value) {
  const selected = firstDefined(value);
  if (selected === undefined) return null;
  const parsed = Number(selected);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  const selected = firstDefined(value);
  if (selected === undefined) return null;
  if (selected === true || selected === 1 || selected === '1' || selected === 'true') return true;
  if (selected === false || selected === 0 || selected === '0' || selected === 'false') return false;
  return null;
}

function fieldAvailability(value, field, unsupported) {
  if (value !== null) return 'present';
  return unsupported.includes(field) ? 'unsupported' : 'missing';
}

export function normalizeTrendingRiskFields(row = {}, {
  source = row?.source || 'unknown',
  rugRatio = firstDefined(row?.rug_ratio, row?.rugRatio, row?.rug_rate, row?.rugRate),
  bundlerRate = firstDefined(row?.bundler_rate, row?.bundlerRate, row?.bot_holders_rate, row?.botHoldersRate),
  isWashTrading = firstDefined(row?.is_wash_trading, row?.isWashTrading, row?.wash_trading, row?.washTrading),
  unsupported = [],
  providerSideFilters = [],
} = {}) {
  const unsupportedFields = unsupported.map(field => String(field));
  const normalized = {
    rug_ratio: numberOrNull(rugRatio),
    bundler_rate: numberOrNull(bundlerRate),
    is_wash_trading: booleanOrNull(isWashTrading),
  };
  return {
    ...normalized,
    risk_field_availability: {
      rug_ratio: fieldAvailability(normalized.rug_ratio, 'rug_ratio', unsupportedFields),
      bundler_rate: fieldAvailability(normalized.bundler_rate, 'bundler_rate', unsupportedFields),
      is_wash_trading: fieldAvailability(normalized.is_wash_trading, 'is_wash_trading', unsupportedFields),
      source,
      ...(providerSideFilters.length ? { provider_side_filters: providerSideFilters.map(String) } : {}),
    },
  };
}
