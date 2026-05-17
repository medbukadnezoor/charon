import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.TELEGRAM_CHAT_ID = '12345';
process.env.TELEGRAM_TOPIC_ID = '777';
process.env.DB_PATH = ':memory:';

const { gmgnWalletLink } = await import('../src/format.js');
const {
  isAuthorizedTelegramCallback,
  isAuthorizedTelegramUpdate,
} = await import('../src/telegram/auth.js');
const {
  liveWalletButton,
  liveWalletKeyboardRow,
  liveWalletText,
} = await import('../src/telegram/menus.js');

test('gmgnWalletLink builds GMGN Solana address profile URL', () => {
  assert.equal(
    gmgnWalletLink('Wallet111111111111111111111111111111111111'),
    'https://gmgn.ai/sol/address/Wallet111111111111111111111111111111111111',
  );
});

test('live wallet text renders copyable escaped Telegram HTML code', () => {
  assert.equal(
    liveWalletText('Wallet<&>111111111111111111111111111111111'),
    'Live wallet: <code>Wallet&lt;&amp;&gt;111111111111111111111111111111111</code>',
  );
});

test('live wallet text has safe no-wallet state', () => {
  assert.equal(liveWalletText(null), 'Live wallet: not loaded');
  assert.equal(liveWalletButton(null), null);
  assert.equal(liveWalletKeyboardRow(null), null);
});

test('live wallet button opens GMGN wallet profile', () => {
  const address = 'Wallet111111111111111111111111111111111111';
  assert.deepEqual(liveWalletButton(address), {
    text: 'GMGN Wallet PnL',
    url: 'https://gmgn.ai/sol/address/Wallet111111111111111111111111111111111111',
  });
  assert.deepEqual(liveWalletKeyboardRow(address), [liveWalletButton(address)]);
});

test('telegram auth accepts configured chat and topic', () => {
  assert.equal(isAuthorizedTelegramUpdate({
    chat: { id: 12345 },
    message_thread_id: 777,
  }), true);
  assert.equal(isAuthorizedTelegramCallback({
    data: 'menu:agent',
    message: { chat: { id: 12345 }, message_thread_id: 777 },
  }), true);
});

test('telegram auth rejects unauthorized chat, wrong topic, and invalid callback data', () => {
  assert.equal(isAuthorizedTelegramUpdate({
    chat: { id: 999 },
    message_thread_id: 777,
  }), false);
  assert.equal(isAuthorizedTelegramUpdate({
    chat: { id: 12345 },
    message_thread_id: 888,
  }), false);
  assert.equal(isAuthorizedTelegramUpdate({
    chat: { id: 12345 },
  }), false);
  assert.equal(isAuthorizedTelegramCallback({
    data: 'menu:agent<script>',
    message: { chat: { id: 12345 }, message_thread_id: 777 },
  }), false);
  assert.equal(isAuthorizedTelegramCallback({
    data: 'menu:agent',
    message: { chat: { id: 12345 } },
  }), false);
});

test('rendered wallet output does not contain secret wording', () => {
  const rendered = `${liveWalletText('Wallet111111111111111111111111111111111111')} ${JSON.stringify(liveWalletButton('Wallet111111111111111111111111111111111111'))}`;
  assert.equal(/SOLANA_PRIVATE_KEY|PRIVATE_KEY|secret|token/i.test(rendered), false);
});
