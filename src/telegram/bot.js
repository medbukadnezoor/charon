import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_POLLING_ENABLED } from '../config.js';

let bot = null;

function pollingEnabled() {
  if (process.env.TELEGRAM_POLLING_ENABLED === 'false') return false;
  if (process.env.INSTANCE_ID === 'scout') return false;
  if (process.env.SHADOW_MODE === 'true') return false;
  return TELEGRAM_POLLING_ENABLED;
}

export function getBot() {
  if (!bot) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: pollingEnabled() });
  }
  return bot;
}

export function isBotInitialized() {
  return bot !== null;
}
