// ---------------------------------------------------------------------------
// Wallet Harvester — GMGN Extractor Check (zero live calls)
//
// Usage:
//   npx tsx src/extractors/gmgnCheck.ts
//
// Validates that sparse GMGN holder payloads do not convert unavailable
// amount fields into real zero-dollar sightings.
// ---------------------------------------------------------------------------

import { gmgnHolderAmountUsd, nullableGmgnNumber } from "./gmgn.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function testNullableNumber(): void {
  assert(nullableGmgnNumber(undefined) === null, "undefined should stay null");
  assert(nullableGmgnNumber(null) === null, "null should stay null");
  assert(nullableGmgnNumber("") === null, "blank string should stay null");
  assert(nullableGmgnNumber("0") === 0, "explicit numeric zero should parse as zero");
  assert(nullableGmgnNumber("12.5") === 12.5, "numeric string should parse");
  assert(nullableGmgnNumber("not-a-number") === null, "invalid number should stay null");
}

function testHolderAmount(): void {
  assert(gmgnHolderAmountUsd({}) === null, "missing holder amount should be null");
  assert(gmgnHolderAmountUsd({ usd_value: "" }) === null, "blank holder amount should be null");
  assert(gmgnHolderAmountUsd({ usd_value: "0" }) === null, "zero holder amount should be treated as unavailable");
  assert(gmgnHolderAmountUsd({ usd_value: 0 }) === null, "numeric zero holder amount should be treated as unavailable");
  assert(gmgnHolderAmountUsd({ usd_value: "15.25" }) === 15.25, "positive holder amount should parse");
  assert(gmgnHolderAmountUsd({ amount_usd: "22" }) === 22, "fallback amount_usd should parse");
  assert(gmgnHolderAmountUsd({ value_usd: 31 }) === 31, "fallback value_usd should parse");
}

testNullableNumber();
testHolderAmount();

console.log("GMGN extractor checks passed");
