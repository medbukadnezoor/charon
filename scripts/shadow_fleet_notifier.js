#!/usr/bin/env node
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

if (process.env.CHARON_SKIP_DOTENV !== 'true') {
  dotenv.config();
}

process.env.CHARON_SKIP_DOTENV = 'true';

function parseArgs(argv) {
  const opts = {
    dbPath: process.env.SHADOW_DB_PATH || process.env.DB_PATH || '/opt/trading-data/charon-shadow.sqlite',
    windowMs: Number(process.env.SHADOW_NOTIFIER_WINDOW_MS || 30 * 60_000),
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const numeric = Number(match[2]);
    opts[key] = Number.isFinite(numeric) ? numeric : match[2];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.SHADOW_MODE !== 'true') throw new Error('shadow_fleet_notifier requires SHADOW_MODE=true');
  const { buildShadowFleetNotification } = await import('../src/telegram/shadowFleetNotifier.js');

  const notification = await buildShadowFleetNotification({
    dbPath: opts.dbPath,
    windowMs: Number(opts.windowMs || 30 * 60_000),
  });

  if (opts.dryRun) {
    console.log(notification.message);
    return;
  }

  const token = process.env.SHADOW_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('SHADOW_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN is required');
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required');
  const bot = new TelegramBot(token, { polling: false });
  const message = notification.message.startsWith('[SHADOW]')
    ? notification.message
    : `[SHADOW]\n${notification.message}`;
  await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(process.env.TELEGRAM_TOPIC_ID ? { message_thread_id: Number(process.env.TELEGRAM_TOPIC_ID) } : {}),
  });
  console.log(`[shadow-notifier] sent ${notification.message.length} chars`);
}

main().catch(err => {
  console.error(`[shadow-notifier] ${err.message}`);
  process.exit(1);
});
