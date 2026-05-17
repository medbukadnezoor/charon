import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';

function textOrNull(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function messageFrom(updateLike) {
  return updateLike?.message || updateLike;
}

export function telegramChatId(updateLike) {
  const msg = messageFrom(updateLike);
  return textOrNull(msg?.chat?.id ?? updateLike?.chat?.id);
}

export function telegramThreadId(updateLike) {
  const msg = messageFrom(updateLike);
  return textOrNull(msg?.message_thread_id ?? updateLike?.message_thread_id);
}

export function isAuthorizedTelegramUpdate(updateLike, {
  allowedChatId = TELEGRAM_CHAT_ID,
  topicId = TELEGRAM_TOPIC_ID,
} = {}) {
  const allowed = textOrNull(allowedChatId);
  if (!allowed) return false;
  if (telegramChatId(updateLike) !== allowed) return false;
  const requiredTopic = textOrNull(topicId);
  if (requiredTopic && telegramThreadId(updateLike) !== requiredTopic) return false;
  return true;
}

export function isValidCallbackData(data) {
  const value = String(data || '');
  if (!value || value.length > 80) return false;
  return /^[a-z0-9_:-]+$/i.test(value);
}

export function isAuthorizedTelegramCallback(query, options = {}) {
  return isAuthorizedTelegramUpdate(query?.message || query, options) && isValidCallbackData(query?.data);
}
