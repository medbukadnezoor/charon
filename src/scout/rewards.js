function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function calculateScoutReward(position = {}, {
  source = position.execution_mode === 'live' ? 'live' : 'shadow',
  opportunityOnly = false,
} = {}) {
  if (!position || position.status !== 'closed') {
    return { eligible: false, reason: 'unresolved_position' };
  }

  const pnlSol = finiteNumber(position.pnl_sol);
  const pnlPercent = finiteNumber(position.pnl_percent);
  const entryMcap = finiteNumber(position.entry_mcap);
  const highWaterMcap = finiteNumber(position.high_water_mcap);
  const highWaterMultiple = entryMcap && highWaterMcap ? highWaterMcap / entryMcap : null;
  const exitReason = String(position.exit_reason || '').toLowerCase();
  const drawdownPercent = highWaterMultiple && pnlPercent !== null
    ? Math.max(0, (highWaterMultiple - 1) * 100 - pnlPercent)
    : null;

  let reward = 0;
  if (source === 'live' && pnlSol !== null) {
    reward += pnlSol * 50;
  }
  if (pnlPercent !== null) {
    reward += pnlPercent / 100;
  }
  if (highWaterMultiple !== null && source !== 'live') {
    reward += Math.log(Math.max(1, highWaterMultiple)) * 0.25;
  }
  if (/sl|stop|cutoff|failed|error/.test(exitReason)) reward -= 0.5;
  if (/failed|error/.test(exitReason)) reward -= 0.5;
  if (drawdownPercent !== null && drawdownPercent > 40) reward -= Math.min(1, drawdownPercent / 100);
  if (opportunityOnly) reward *= 0.35;

  return {
    eligible: true,
    source,
    realized_pnl_sol: pnlSol,
    realized_pnl_percent: pnlPercent,
    high_water_multiple: highWaterMultiple,
    drawdown_percent: drawdownPercent,
    reward: clamp(reward, -3, 3),
    reward_weight: source === 'live' ? 1 : 0.25,
    reason: exitReason || 'closed',
  };
}
