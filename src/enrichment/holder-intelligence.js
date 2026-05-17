import { publicRpcOutcome, requestSolanaRpc } from '../rpc/router.js';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCLUSIONS = 8;
const MAX_EVIDENCE = 5;
const SEVERITY_ORDER = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clamp(value, min, max) {
  const num = finiteNumber(value);
  if (num == null) return min;
  return Math.max(min, Math.min(max, num));
}

function roundMetric(value, decimals = 4) {
  const num = finiteNumber(value);
  if (num == null) return null;
  return Number(num.toFixed(decimals));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(tag => String(tag).trim()).filter(Boolean);
}

function hasTag(holder, tagName) {
  return normalizeTags(holder?.tags).some(tag => tag.toLowerCase() === tagName);
}

function conclusion(signal, severity, confidence, explanation, evidence = [], metrics = undefined) {
  const item = {
    signal,
    severity,
    confidence: Math.round(clamp(confidence, 0, 100)),
    explanation: String(explanation || '').slice(0, 150),
  };
  const evidenceList = Array.isArray(evidence)
    ? evidence.map(shortenAddress).filter(Boolean).slice(0, MAX_EVIDENCE)
    : [];
  if (evidenceList.length) item.evidence = evidenceList;
  if (metrics && typeof metrics === 'object') item.metrics = metrics;
  return item;
}

function sortConclusions(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const severityDiff = (SEVERITY_ORDER[b.item.severity] || 0) - (SEVERITY_ORDER[a.item.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      const confidenceDiff = (Number(b.item.confidence) || 0) - (Number(a.item.confidence) || 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      return a.index - b.index;
    })
    .map(entry => entry.item);
}

function rowsByRankOrPercent(holderRows) {
  return [...holderRows].sort((a, b) => {
    const rankA = finiteNumber(a.rank);
    const rankB = finiteNumber(b.rank);
    if (rankA != null && rankB != null && rankA !== rankB) return rankA - rankB;
    if (rankA != null && rankB == null) return -1;
    if (rankA == null && rankB != null) return 1;
    return (finiteNumber(b.percent) ?? 0) - (finiteNumber(a.percent) ?? 0);
  });
}

function sumTopPercent(holderRows, count) {
  const rows = rowsByRankOrPercent(holderRows).slice(0, count);
  if (!rows.length) return null;
  const sum = rows.reduce((total, holder) => total + (finiteNumber(holder.percent) ?? 0), 0);
  return roundMetric(sum);
}

function safeHolderCount(input, rows) {
  const count = finiteNumber(input?.count);
  if (count != null) return count;
  return Array.isArray(rows) ? rows.length : 0;
}

export function shortenAddress(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
}

export function validateHolderRow(holder) {
  if (!holder || typeof holder !== 'object') {
    return { valid: false, reason: 'holder_not_object' };
  }
  if (typeof holder.address !== 'string' || !holder.address.trim()) {
    return { valid: false, reason: 'missing_address' };
  }
  const address = holder.address.trim();
  if (address.length < 32 || address.length > 64) {
    return { valid: false, reason: 'invalid_address' };
  }
  if (finiteNumber(holder.amount) == null) {
    return { valid: false, reason: 'invalid_amount' };
  }
  if (finiteNumber(holder.percent) == null) {
    return { valid: false, reason: 'invalid_percent' };
  }
  return { valid: true, reason: null };
}

export function validateInput(holders) {
  const holderRows = Array.isArray(holders)
    ? holders
    : Array.isArray(holders?.holders)
      ? holders.holders
      : null;

  if (!holderRows) {
    return { valid: false, holderRows: [], reason: 'missing_holder_rows' };
  }

  for (const row of holderRows) {
    const check = validateHolderRow(row);
    if (!check.valid) {
      return { valid: false, holderRows, reason: check.reason };
    }
  }

  return { valid: true, holderRows, reason: null };
}

export function concentrationRiskLevel(maxPct, top20Pct) {
  const maxHolder = finiteNumber(maxPct);
  const top20 = finiteNumber(top20Pct);
  if ((maxHolder != null && maxHolder > 25) || (top20 != null && top20 > 80)) return 'critical';
  if ((maxHolder != null && maxHolder > 15) || (top20 != null && top20 > 60)) return 'high';
  if ((maxHolder != null && maxHolder > 5) || (top20 != null && top20 > 40)) return 'medium';
  return 'low';
}

export function computePartialSummary(holders = {}) {
  const holderRows = Array.isArray(holders)
    ? holders
    : Array.isArray(holders?.holders)
      ? holders.holders
      : [];
  const usableRows = holderRows.filter(holder => holder && typeof holder === 'object');
  const numericPercents = usableRows
    .map(holder => finiteNumber(holder.percent))
    .filter(value => value != null);
  const top20FromInput = finiteNumber(holders?.top20Percent);
  const maxFromInput = finiteNumber(holders?.maxHolderPercent);
  const top20Percent = top20FromInput != null
    ? roundMetric(top20FromInput)
    : numericPercents.length
      ? sumTopPercent(usableRows.filter(holder => finiteNumber(holder.percent) != null), 20)
      : null;
  const maxHolderPercent = maxFromInput != null
    ? roundMetric(maxFromInput)
    : numericPercents.length
      ? roundMetric(Math.max(...numericPercents))
      : null;
  const top5Percent = numericPercents.length ? sumTopPercent(usableRows.filter(holder => finiteNumber(holder.percent) != null), 5) : null;
  const top10Percent = numericPercents.length ? sumTopPercent(usableRows.filter(holder => finiteNumber(holder.percent) != null), 10) : null;
  const largeHolderCount = numericPercents.length
    ? numericPercents.filter(value => value > 2).length
    : null;
  const concentrationRisk = top20Percent != null || maxHolderPercent != null
    ? concentrationRiskLevel(maxHolderPercent, top20Percent)
    : null;

  return {
    count: safeHolderCount(holders, holderRows),
    top5Percent,
    top10Percent,
    top20Percent,
    maxHolderPercent,
    largeHolderCount,
    concentrationRisk,
  };
}

export function computeConcentrationMetrics(holderRows = [], top20Pct = null, maxPct = null) {
  const validRows = Array.isArray(holderRows)
    ? holderRows.filter(holder => validateHolderRow(holder).valid)
    : [];
  const top5Percent = sumTopPercent(validRows, 5);
  const top10Percent = sumTopPercent(validRows, 10);
  const computedTop20 = sumTopPercent(validRows, 20);
  const top20Percent = roundMetric(top20Pct) ?? computedTop20;
  const computedMax = validRows.length
    ? Math.max(...validRows.map(holder => finiteNumber(holder.percent) ?? 0))
    : null;
  const maxHolderPercent = roundMetric(maxPct) ?? roundMetric(computedMax);
  const largeHolderCount = validRows.filter(holder => (finiteNumber(holder.percent) ?? 0) > 2).length;
  const concentrationRisk = concentrationRiskLevel(maxHolderPercent, top20Percent);
  const severity = concentrationRisk;
  const explanation = concentrationRisk === 'low'
    ? `Holder concentration low: top20 ${top20Percent ?? 'unknown'}%, max ${maxHolderPercent ?? 'unknown'}%`
    : `Holder concentration ${concentrationRisk}: top20 ${top20Percent ?? 'unknown'}%, max ${maxHolderPercent ?? 'unknown'}%`;
  const summary = {
    count: validRows.length,
    top5Percent,
    top10Percent,
    top20Percent,
    maxHolderPercent,
    largeHolderCount,
    concentrationRisk,
  };

  return {
    ...summary,
    conclusion: conclusion(
      'concentration_risk',
      severity,
      severity === 'critical' ? 90 : severity === 'high' ? 78 : severity === 'medium' ? 62 : 45,
      explanation,
      validRows.slice(0, 5).map(holder => holder.address),
      { top20Percent, maxHolderPercent, largeHolderCount }
    ),
  };
}

export function detectEqualAmountClusters(holderRows = []) {
  const rows = Array.isArray(holderRows)
    ? holderRows
        .filter(holder => validateHolderRow(holder).valid)
        .filter(holder => (finiteNumber(holder.amount) ?? 0) > 0)
        .map(holder => ({ ...holder, amount: finiteNumber(holder.amount) }))
        .sort((a, b) => a.amount - b.amount || String(a.address).localeCompare(String(b.address)))
    : [];
  const clusters = [];
  const used = new Set();

  const validCluster = group => {
    if (group.length < 3) return false;
    const mean = group.reduce((sum, holder) => sum + holder.amount, 0) / group.length;
    if (mean <= 0) return false;
    return group.every(holder => Math.abs(holder.amount - mean) / mean <= 0.001);
  };

  for (let start = 0; start < rows.length; start += 1) {
    if (used.has(rows[start].address)) continue;
    let best = [];
    for (let end = start + 2; end < rows.length; end += 1) {
      const group = rows.slice(start, end + 1).filter(row => !used.has(row.address));
      if (validCluster(group) && group.length > best.length) {
        best = group;
      }
    }
    if (best.length >= 3) {
      clusters.push(best);
      for (const holder of best) used.add(holder.address);
    }
  }

  return clusters.map(cluster => {
    const clusterSize = cluster.length;
    const severity = clusterSize >= 10 ? 'critical' : clusterSize >= 6 ? 'high' : 'medium';
    const meanAmount = cluster.reduce((sum, holder) => sum + holder.amount, 0) / clusterSize;
    return conclusion(
      'equal_amount_cluster',
      severity,
      Math.min(clusterSize * 10, 95),
      `${clusterSize} wallets hold near-identical amounts around ${roundMetric(meanAmount, 2)} tokens`,
      cluster.map(holder => holder.address),
      { clusterSize, meanAmount: roundMetric(meanAmount, 6) }
    );
  });
}

export function computeCreatorDominance(holderRows = []) {
  const validRows = Array.isArray(holderRows)
    ? holderRows.filter(holder => validateHolderRow(holder).valid)
    : [];
  const creator = validRows.find(holder => hasTag(holder, 'creator'));
  const nonCreators = validRows.filter(holder => !hasTag(holder, 'creator'));
  if (!creator || nonCreators.length < 2) return null;

  const creatorPercent = finiteNumber(creator.percent) ?? 0;
  const nextLargest = Math.max(...nonCreators.map(holder => finiteNumber(holder.percent) ?? 0));
  if (nextLargest <= 0) return null;

  const ratio = creatorPercent / nextLargest;
  const severity = ratio > 5 ? 'critical' : ratio > 2 ? 'high' : ratio > 1 ? 'medium' : 'low';
  return conclusion(
    'creator_dominance',
    severity,
    severity === 'critical' ? 88 : severity === 'high' ? 72 : severity === 'medium' ? 58 : 40,
    `Creator holds ${roundMetric(creatorPercent, 2)}%, ${roundMetric(ratio, 2)}x next non-creator holder`,
    [creator.address],
    {
      creatorPercent: roundMetric(creatorPercent),
      nextLargestNonCreatorPercent: roundMetric(nextLargest),
      ratio: roundMetric(ratio),
    }
  );
}

export function detectTagSignals(holderRows = []) {
  const validRows = Array.isArray(holderRows)
    ? holderRows.filter(holder => holder && typeof holder === 'object' && typeof holder.address === 'string')
    : [];
  const byTag = new Map();
  for (const holder of validRows) {
    for (const rawTag of normalizeTags(holder.tags)) {
      const tag = rawTag.toLowerCase();
      if (tag === 'creator') continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(holder);
    }
  }

  return [...byTag.entries()].map(([tag, rows]) => {
    const first = rows[0]?.address;
    return conclusion(
      tag,
      'low',
      50,
      `Jupiter tag ${tag} on ${shortenAddress(first) || 'holder'}${rows.length > 1 ? ` and ${rows.length - 1} more` : ''}`,
      rows.map(row => row.address),
      { tag, count: rows.length }
    );
  });
}

export async function rpcWithTimeout(fn, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAddressTransactions(address, limit, rpcCache = new Map()) {
  if (!address) return null;
  const key = `txs:${address}`;
  if (rpcCache?.has?.(key)) {
    return rpcCache.get(key)?.transactions ?? null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_RPC_TIMEOUT_MS);
  let transactions = null;
  let failureReason = null;
  try {
    const payload = {
      jsonrpc: '2.0',
      id: `holder-intelligence-${Date.now()}`,
      method: 'getTransactionsForAddress',
      params: [address, { limit }],
    };
    const outcome = await requestSolanaRpc('holder_history', payload, {
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      signal: controller.signal,
    });
    const data = outcome.result;
    transactions = Array.isArray(data?.result) ? data.result : null;
    if (transactions == null) {
      failureReason = outcome.ok
        ? (data?.error?.message || 'malformed_response')
        : JSON.stringify(publicRpcOutcome(outcome));
    }
  } catch (err) {
    failureReason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'unknown_error');
  } finally {
    clearTimeout(timer);
  }

  if (transactions == null) {
    console.log(`[llm] RPC getTransactionsForAddress failed for ${address}: ${failureReason || 'empty_result'}`);
  }
  if (rpcCache?.set) {
    rpcCache.set(key, { transactions, fetchedAt: Date.now() });
  }
  return transactions;
}

function inspectForHolderAddresses(value, holderSet, matches = new Set()) {
  if (matches.size >= MAX_EVIDENCE || value == null) return matches;
  if (typeof value === 'string') {
    for (const address of holderSet) {
      if (value.includes(address)) {
        matches.add(address);
        if (matches.size >= MAX_EVIDENCE) break;
      }
    }
    return matches;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      inspectForHolderAddresses(item, holderSet, matches);
      if (matches.size >= MAX_EVIDENCE) break;
    }
    return matches;
  }
  if (typeof value === 'object') {
    const preferredFields = [
      'accountKeys',
      'accounts',
      'addresses',
      'logs',
      'logMessages',
      'instructions',
      'innerInstructions',
      'events',
      'tokenTransfers',
      'nativeTransfers',
      'description',
      'memo',
    ];
    for (const field of preferredFields) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        inspectForHolderAddresses(value[field], holderSet, matches);
        if (matches.size >= MAX_EVIDENCE) return matches;
      }
    }
    for (const item of Object.values(value)) {
      inspectForHolderAddresses(item, holderSet, matches);
      if (matches.size >= MAX_EVIDENCE) break;
    }
  }
  return matches;
}

export async function detectBundlerClusters(mint, holderAddresses = [], rpcCache = new Map()) {
  if (!mint || !holderAddresses.length) return null;
  const holderSet = new Set(holderAddresses.filter(Boolean));
  const transactions = await fetchAddressTransactions(mint, 50, rpcCache);
  if (transactions == null) {
    console.log(`[llm] RPC bundler enrichment returned no transactions for ${mint}`);
    return null;
  }
  if (!Array.isArray(transactions) || !transactions.length) return null;

  const bySlot = new Map();
  for (const transaction of transactions) {
    const slot = finiteNumber(transaction?.slot);
    if (slot == null) continue;
    const matches = inspectForHolderAddresses(transaction, holderSet);
    if (!matches.size) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, new Set());
    const slotMatches = bySlot.get(slot);
    for (const address of matches) slotMatches.add(address);
  }

  let best = null;
  for (const [slot, addresses] of bySlot.entries()) {
    if (addresses.size < 3) continue;
    if (!best || addresses.size > best.addresses.size) best = { slot, addresses };
  }
  if (!best) return null;

  const clusterSize = best.addresses.size;
  const confidence = clusterSize >= 5 ? 85 : clusterSize === 4 ? 72 : 60;
  return conclusion(
    'bundler_cluster',
    'critical',
    confidence,
    `${clusterSize} holder wallets appear in same slot ${best.slot}`,
    [...best.addresses],
    { clusterSize, slot: best.slot }
  );
}

export async function detectDeployerLinked(creatorAddress, holderAddresses = [], rpcCache = new Map()) {
  if (!creatorAddress || !holderAddresses.length) return null;
  const holderSet = new Set(holderAddresses.filter(address => address && address !== creatorAddress));
  if (!holderSet.size) return null;
  const transactions = await fetchAddressTransactions(creatorAddress, 20, rpcCache);
  if (transactions == null) {
    console.log(`[llm] RPC deployer enrichment returned no transactions for ${creatorAddress}`);
    return null;
  }
  if (!Array.isArray(transactions) || !transactions.length) return null;

  const matches = new Set();
  for (const transaction of transactions) {
    const transactionMatches = inspectForHolderAddresses(transaction, holderSet);
    for (const address of transactionMatches) matches.add(address);
    if (matches.size >= MAX_EVIDENCE) break;
  }
  if (!matches.size) return null;

  const matchCount = matches.size;
  const confidence = matchCount >= 3 ? 85 : matchCount === 2 ? 70 : 55;
  return conclusion(
    'deployer_linked',
    'high',
    confidence,
    `${matchCount} holder wallet${matchCount === 1 ? '' : 's'} appear in recent creator transactions`,
    [...matches],
    { matchCount }
  );
}

export async function analyzeHolders(holders, options = {}) {
  try {
    const configuredMaxConclusions = finiteNumber(options.maxConclusions);
    const maxConclusions = Math.max(1, Math.min(50, configuredMaxConclusions ?? DEFAULT_MAX_CONCLUSIONS));
    const validation = validateInput(holders);
    const partialSummary = computePartialSummary(holders);

    if (!validation.valid) {
      return {
        summary: partialSummary,
        conclusions: [],
        dataIncomplete: true,
        rpcEnrichmentUsed: false,
        reason: validation.reason,
      };
    }

    const holderRows = validation.holderRows;
    if (!holderRows.length) {
      return {
        summary: partialSummary,
        conclusions: [],
        dataIncomplete: false,
        rpcEnrichmentUsed: false,
      };
    }

    const concentration = computeConcentrationMetrics(holderRows, holders?.top20Percent, holders?.maxHolderPercent);
    const summary = {
      ...partialSummary,
      count: safeHolderCount(holders, holderRows),
      top5Percent: concentration.top5Percent,
      top10Percent: concentration.top10Percent,
      top20Percent: concentration.top20Percent,
      maxHolderPercent: concentration.maxHolderPercent,
      largeHolderCount: concentration.largeHolderCount,
      concentrationRisk: concentration.concentrationRisk,
    };
    const creator = holderRows.find(holder => hasTag(holder, 'creator'));
    const nonCreators = holderRows.filter(holder => !hasTag(holder, 'creator'));
    const conclusions = [concentration.conclusion];

    if (nonCreators.length >= 2) {
      conclusions.push(...detectEqualAmountClusters(nonCreators));
      const creatorDominance = computeCreatorDominance(holderRows);
      if (creatorDominance) conclusions.push(creatorDominance);
      conclusions.push(...detectTagSignals(holderRows));
    }

    let rpcEnrichmentUsed = false;
    if (creator?.address && options.rpcEnabled === true) {
      rpcEnrichmentUsed = true;
      const holderAddresses = holderRows.map(holder => holder.address).filter(Boolean);
      const cache = options.rpcCache instanceof Map ? options.rpcCache : new Map();
      const [bundlerCluster, deployerLinked] = await Promise.all([
        detectBundlerClusters(options.mint, holderAddresses, cache).catch(err => {
          console.log(`[llm] RPC bundler enrichment failed for ${options.mint || 'unknown'}: ${err.message}`);
          return null;
        }),
        detectDeployerLinked(creator.address, holderAddresses, cache).catch(err => {
          console.log(`[llm] RPC deployer enrichment failed for ${options.mint || 'unknown'}: ${err.message}`);
          return null;
        }),
      ]);
      if (bundlerCluster) conclusions.push(bundlerCluster);
      if (deployerLinked) conclusions.push(deployerLinked);
    }

    const cappedConclusions = sortConclusions(conclusions).slice(0, maxConclusions);
    if (holderRows.length > 20 && cappedConclusions.length === 0) {
      console.log(`[llm] zero conclusions for ${options.mint || 'unknown'} holders=${holderRows.length}`);
    }

    return {
      summary,
      conclusions: cappedConclusions,
      dataIncomplete: false,
      rpcEnrichmentUsed,
    };
  } catch (err) {
    console.log(`[llm] holder intelligence failed for ${options?.mint || 'unknown'}: ${err.message}`);
    return {
      summary: computePartialSummary(holders),
      conclusions: [],
      dataIncomplete: true,
      rpcEnrichmentUsed: false,
      reason: 'analysis_error',
    };
  }
}
