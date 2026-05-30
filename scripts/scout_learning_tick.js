#!/usr/bin/env node
import { initDb, db } from '../src/db/connection.js';
import {
  activeScoutPolicyVersion,
  recordScoutRewardForPosition,
  updateScoutWeightsFromRewards,
} from '../src/db/scoutPolicy.js';

function parseArgs(argv) {
  const opts = { limit: 200 };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'limit') opts.limit = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function closedScoutPositions(limit) {
  return db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status = 'closed'
      AND strategy_id = 'scout'
      AND scout_policy_version_id IS NOT NULL
      AND scout_reward_status = 'pending'
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(limit);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  initDb();
  activeScoutPolicyVersion();
  const positions = closedScoutPositions(opts.limit);
  let recorded = 0;
  for (const position of positions) {
    const reward = recordScoutRewardForPosition(position);
    if (reward.eligible) {
      db.prepare("UPDATE dry_run_positions SET scout_reward_status = 'recorded' WHERE id = ?").run(position.id);
      recorded += 1;
    }
  }
  const update = updateScoutWeightsFromRewards({ limit: opts.limit });
  console.log(JSON.stringify({
    ok: true,
    closed_positions_scanned: positions.length,
    rewards_recorded: recorded,
    ...update,
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
