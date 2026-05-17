import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:9/unused-holder-intelligence-test';

const intelligence = await import('../src/enrichment/holder-intelligence.js');

const {
  analyzeHolders,
  computeConcentrationMetrics,
  computeCreatorDominance,
  detectBundlerClusters,
  detectDeployerLinked,
  detectEqualAmountClusters,
} = intelligence;

function address(label) {
  const safe = String(label).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  return `${safe}${'A'.repeat(44 - safe.length)}`;
}

function holder(label, percent, amount = 1_000, tags = [], rank = undefined) {
  return {
    address: address(label),
    percent,
    amount,
    tags,
    ...(rank == null ? {} : { rank }),
  };
}

test('computes concentration risk thresholds and summary metrics', () => {
  const rows = [
    holder('maxCritical', 26, 100, [], 1),
    ...Array.from({ length: 19 }, (_, index) => holder(`critical${index}`, 3, 90 - index, [], index + 2)),
  ];

  const critical = computeConcentrationMetrics(rows, 83, 26);
  assert.equal(critical.concentrationRisk, 'critical');
  assert.equal(critical.maxHolderPercent, 26);
  assert.equal(critical.top5Percent, 38);
  assert.equal(critical.top10Percent, 53);
  assert.equal(critical.top20Percent, 83);
  assert.equal(critical.largeHolderCount, 20);
  assert.equal(critical.conclusion.severity, 'critical');
  assert.deepEqual(critical.conclusion.metrics, {
    top20Percent: 83,
    maxHolderPercent: 26,
    largeHolderCount: 20,
  });

  assert.equal(computeConcentrationMetrics([holder('highMax', 16), holder('smallA', 1), holder('smallB', 1)], 18, 16).concentrationRisk, 'high');
  assert.equal(computeConcentrationMetrics([holder('mediumMax', 6), holder('smallC', 1), holder('smallD', 1)], 8, 6).concentrationRisk, 'medium');
  assert.equal(computeConcentrationMetrics([holder('lowMax', 5), holder('smallE', 1), holder('smallF', 1)], 7, 5).concentrationRisk, 'low');
});

test('detects equal-amount clusters independent of input order', () => {
  const clustered = [
    holder('clusterOne', 1, 50_000),
    holder('clusterTwo', 1, 50_001),
    holder('clusterThree', 1, 49_999),
    holder('clusterFour', 1, 50_000.5),
    holder('outside', 1, 10_000),
  ];
  const reordered = [clustered[4], clustered[2], clustered[0], clustered[3], clustered[1]];

  assert.deepEqual(detectEqualAmountClusters(clustered), detectEqualAmountClusters(reordered));
  const [cluster] = detectEqualAmountClusters(reordered);
  assert.equal(cluster.signal, 'equal_amount_cluster');
  assert.equal(cluster.severity, 'medium');
  assert.equal(cluster.metrics.clusterSize, 4);
});

test('maps creator dominance severity from creator-to-holder ratio', () => {
  const cases = [
    { creatorPercent: 31, nextPercent: 5, severity: 'critical' },
    { creatorPercent: 13, nextPercent: 5, severity: 'high' },
    { creatorPercent: 7, nextPercent: 5, severity: 'medium' },
    { creatorPercent: 4, nextPercent: 5, severity: 'low' },
  ];

  for (const item of cases) {
    const result = computeCreatorDominance([
      holder(`creator${item.severity}`, item.creatorPercent, 1_000, ['creator']),
      holder(`next${item.severity}`, item.nextPercent),
      holder(`other${item.severity}`, 1),
    ]);
    assert.equal(result.severity, item.severity);
    assert.equal(result.metrics.creatorPercent, item.creatorPercent);
    assert.equal(result.metrics.nextLargestNonCreatorPercent, item.nextPercent);
  }
});

test('malformed input returns dataIncomplete with empty conclusions', async () => {
  const result = await analyzeHolders({ holders: [{ address: '', amount: 'bad', percent: 10 }] });

  assert.equal(result.dataIncomplete, true);
  assert.equal(result.rpcEnrichmentUsed, false);
  assert.deepEqual(result.conclusions, []);
  assert.equal(result.reason, 'missing_address');
});

test('rpc disabled produces local conclusions only', async () => {
  const creator = holder('creatorLocal', 18, 1_000, ['creator']);
  const rows = [
    creator,
    holder('localOne', 5),
    holder('localTwo', 4),
    holder('localThree', 3),
  ];
  const rpcCache = new Map([
    [`txs:${creator.address}`, { transactions: [{ slot: 22, accountKeys: [rows[1].address, rows[2].address] }] }],
  ]);

  const result = await analyzeHolders({ holders: rows }, { rpcEnabled: false, rpcCache, mint: address('mintLocal') });

  assert.equal(result.rpcEnrichmentUsed, false);
  assert.equal(result.dataIncomplete, false);
  assert.ok(result.conclusions.some(item => item.signal === 'concentration_risk'));
  assert.ok(result.conclusions.some(item => item.signal === 'creator_dominance'));
  assert.ok(!result.conclusions.some(item => item.signal === 'bundler_cluster'));
  assert.ok(!result.conclusions.some(item => item.signal === 'deployer_linked'));
});

test('maxConclusions caps sorted conclusions', async () => {
  const rows = [
    holder('creatorCap', 30, 100_000, ['creator']),
    ...Array.from({ length: 6 }, (_, index) => holder(`capCluster${index}`, 2, 50_000 + index * 10, [`tag${index}`])),
    holder('capLarge', 10, 10_000, ['smart_money']),
  ];

  const result = await analyzeHolders(
    { holders: rows, top20Percent: 52, maxHolderPercent: 30 },
    { maxConclusions: 3, rpcEnabled: false }
  );

  assert.equal(result.conclusions.length, 3);
  assert.deepEqual(
    result.conclusions.map(item => item.signal),
    ['concentration_risk', 'creator_dominance', 'equal_amount_cluster']
  );
});

test('uses mocked full transaction cache for direct bundler and deployer exports', async () => {
  const mint = address('mintRpc');
  const creator = address('creatorRpc');
  const holders = [creator, address('rpcOne'), address('rpcTwo'), address('rpcThree'), address('rpcFour')];
  const rpcCache = new Map([
    [`txs:${mint}`, {
      transactions: [
        { slot: 101, accountKeys: [holders[1], holders[2]], memo: holders[3] },
        { slot: 101, logMessages: [`holder ${holders[4]}`] },
        { slot: 102, accountKeys: [holders[1]] },
      ],
    }],
    [`txs:${creator}`, {
      transactions: [
        { slot: 201, accountKeys: [holders[1]], description: `sent to ${holders[2]}` },
        { slot: 202, tokenTransfers: [{ toUserAccount: holders[3] }] },
      ],
    }],
  ]);

  const bundler = await detectBundlerClusters(mint, holders, rpcCache);
  assert.equal(bundler.signal, 'bundler_cluster');
  assert.equal(bundler.severity, 'critical');
  assert.equal(bundler.metrics.clusterSize, 4);
  assert.equal(bundler.metrics.slot, 101);

  const deployer = await detectDeployerLinked(creator, holders, rpcCache);
  assert.equal(deployer.signal, 'deployer_linked');
  assert.equal(deployer.severity, 'high');
  assert.equal(deployer.metrics.matchCount, 3);
});
