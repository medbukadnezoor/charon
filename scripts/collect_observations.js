#!/usr/bin/env node
import { initDb, db } from '../src/db/connection.js';
import { runTelemetryCollector } from '../src/telemetry/collector.js';
import { sleep } from '../src/utils.js';

function parseArgs(argv) {
  const opts = { limit: 10, intervalMs: 60_000, once: false, requireEnabled: false };
  for (const arg of argv) {
    if (arg === '--once') opts.once = true;
    if (arg === '--require-enabled') opts.requireEnabled = true;
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const numeric = Number(match[2]);
      opts[key] = Number.isFinite(numeric) ? numeric : match[2];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  initDb();
  do {
    const counters = await runTelemetryCollector({
      limit: Number(opts.limit || 10),
      requireEnabled: Boolean(opts.requireEnabled),
    });
    console.log(`[telemetry] collector ${JSON.stringify(counters)}`);
    if (opts.once) break;
    await sleep(Number(opts.intervalMs || 60_000));
  } while (true);
}

main()
  .catch(err => {
    console.error(`[telemetry] collector fatal: ${err.message}`);
    process.exit(1);
  })
  .finally(() => {
    if (process.argv.includes('--once')) db.close();
  });
