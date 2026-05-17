import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';

const { sampleMarketCap } = await import('../src/enrichment/mcapSampler.js');

test('mcap sampler chooses source priority before fallbacks', async () => {
  const logs = [];
  const sample = await sampleMarketCap({
    mint: 'McapPriority111111111111111111111111111111',
    context: 'test_priority',
    useCache: false,
    fetchGmgn: async () => ({ market_cap: 120_000, price: 0.0012 }),
    fetchAsset: async () => ({ mcap: 90_000, fdv: 150_000, usdPrice: 0.0009 }),
    trendingToken: { market_cap: 80_000, price: 0.0008 },
    fallbackMarketCapUsd: 70_000,
    fallbackPriceUsd: 0.0007,
    logger: message => logs.push(message),
  });

  assert.equal(sample.marketCapUsd, 120_000);
  assert.equal(sample.priceUsd, 0.0012);
  assert.equal(sample.source, 'gmgn_market_cap');
  assert.equal(sample.flags.fallbackUsed, false);
  assert.equal(sample.readings.find(reading => reading.source === 'jupiter_mcap').marketCapUsd, 90_000);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /disagreement=/);
});

test('mcap sampler falls back with stale flags when fresh providers are missing', async () => {
  const sample = await sampleMarketCap({
    mint: 'McapFallback111111111111111111111111111111',
    context: 'test_fallback',
    useCache: false,
    fetchGmgn: async () => null,
    fetchAsset: async () => null,
    fallbackReadings: [
      { source: 'existing_candidate_mcap', marketCapUsd: 42_000, priceUsd: 0.00042 },
    ],
    logger: null,
  });

  assert.equal(sample.marketCapUsd, 42_000);
  assert.equal(sample.priceUsd, 0.00042);
  assert.equal(sample.source, 'existing_candidate_mcap');
  assert.equal(sample.flags.fallbackUsed, true);
  assert.equal(sample.flags.staleFallbackUsed, true);
});

test('mcap sampler logs near-threshold samples', async () => {
  const logs = [];
  const sample = await sampleMarketCap({
    mint: 'McapNear1111111111111111111111111111111111',
    context: 'test_near_threshold',
    useCache: false,
    thresholds: {
      minMarketCapUsd: 100_000,
      maxMarketCapUsd: 200_000,
    },
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ mcap: 108_000, fdv: 108_000, usdPrice: 0.00108 }),
    logger: message => logs.push(message),
  });

  assert.equal(sample.source, 'jupiter_mcap');
  assert.equal(sample.flags.nearThreshold, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /source=jupiter_mcap/);
});
