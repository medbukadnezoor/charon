import { getBot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, parseNumericInput } from '../utils.js';
import { activeStrategy, setSetting, updateStrategyConfig } from '../db/settings.js';
import {
  filtersText,
  filtersKeyboard,
  numericFilterLabels,
  navKeyboard,
  strategyKeyboard,
  strategyMenuText,
  strategyNumericLabels,
} from './menus.js';

export const pendingNumericInputs = new Map();

export async function requestNumericFilterInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!numericFilterLabels[key]) return getBot().sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), {
    type: 'setting',
    key,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:filters' }]]),
  );
}

export async function requestStrategyNumericInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!strategyNumericLabels[key]) return getBot().sendMessage(chatId, 'Unknown strategy setting.');
  const strat = activeStrategy();
  pendingNumericInputs.set(String(chatId), {
    type: 'strategy',
    key,
    strategyId: strat.id,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${strat.name} ${strategyNumericLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, -40, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:strategy' }]]),
  );
}

export async function consumeNumericFilterInput(chatId, text, userMessageId = null) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await getBot().sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = parseNumericInput(text);
  if (value == null) {
    await getBot().sendMessage(chatId, 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.');
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  if (userMessageId) getBot().deleteMessage(chatId, userMessageId).catch(() => {});
  if (pending.type === 'strategy') {
    const strat = activeStrategy();
    if (strat.id !== pending.strategyId) {
      await getBot().sendMessage(chatId, 'Strategy changed while input was pending. Open Strategy menu and try again.');
      return true;
    }
    const newConfig = { ...strat, [pending.key]: value };
    delete newConfig.id;
    delete newConfig.name;
    updateStrategyConfig(strat.id, newConfig);
    if (pending.messageId) {
      await getBot().editMessageText(strategyMenuText(), {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...strategyKeyboard(),
      }).catch(() => getBot().sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() }));
    } else {
      await getBot().sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
  } else {
    setSetting(pending.key, String(value));
    if (pending.messageId) {
      await getBot().editMessageText(filtersText(), {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...filtersKeyboard(),
      }).catch(() => getBot().sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() }));
    } else {
      await getBot().sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
    }
  }
  return true;
}

async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return getBot().sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await getBot().editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return getBot().sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
