import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function readConfig(env) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    const cfg = await import('./src/config.js');
    console.log(JSON.stringify({
      baseUrl: cfg.LLM_BASE_URL,
      model: cfg.LLM_MODEL,
      apiKey: cfg.LLM_API_KEY,
      reasoningEffort: cfg.LLM_REASONING_EFFORT,
    }));
  `], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      CHARON_SKIP_DOTENV: 'true',
      ...env,
    },
  });
  return JSON.parse(stdout);
}

test('primary LLM config defaults to CLIProxyAPI gpt-5.5 low reasoning', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'false',
  });

  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(cfg.model, 'gpt-5.5');
  assert.equal(cfg.apiKey, 'NO_API_KEY');
  assert.equal(cfg.reasoningEffort, 'low');
});

test('primary LLM config keeps explicit global provider overrides', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'false',
    LLM_BASE_URL: 'https://example-llm.invalid/v1',
    LLM_MODEL: 'custom-model',
    LLM_API_KEY: 'primary-key',
    LLM_REASONING_EFFORT: 'medium',
    SHADOW_LLM_BASE_URL: 'https://shadow.invalid/v1',
    SHADOW_LLM_MODEL: 'shadow-model',
  });

  assert.equal(cfg.baseUrl, 'https://example-llm.invalid/v1');
  assert.equal(cfg.model, 'custom-model');
  assert.equal(cfg.apiKey, 'primary-key');
  assert.equal(cfg.reasoningEffort, 'medium');
});

test('shadow LLM config prefers CLIProxyAPI shadow overrides', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'true',
    LLM_BASE_URL: 'https://example-llm.invalid/v1',
    LLM_MODEL: 'custom-model',
    LLM_API_KEY: 'primary-key',
    LLM_REASONING_EFFORT: 'low',
    SHADOW_LLM_BASE_URL: 'http://127.0.0.1:8317/v1',
    SHADOW_LLM_API_KEY: 'NO_API_KEY',
    SHADOW_LLM_MODEL: 'gpt-5.4-mini',
  });

  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(cfg.model, 'gpt-5.4-mini');
  assert.equal(cfg.apiKey, 'NO_API_KEY');
  assert.equal(cfg.reasoningEffort, '');
});

test('shadow LLM config does not inherit global MiMo base URL by default', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'true',
    LLM_BASE_URL: 'https://token-plan-sgp.xiaomimimo.com/v1',
    LLM_MODEL: 'mimo-v2.5-pro',
    LLM_API_KEY: 'mimo-key',
    NVIDIA_API_KEY: 'nvidia-key',
  });

  assert.equal(cfg.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(cfg.model, 'meta/llama-4-maverick-17b-128e-instruct');
  assert.equal(cfg.apiKey, 'nvidia-key');
  assert.equal(cfg.reasoningEffort, '');
});

test('shadow-specific API key wins when present', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'true',
    LLM_API_KEY: 'primary-key',
    SHADOW_LLM_API_KEY: 'shadow-key',
  });

  assert.equal(cfg.apiKey, 'shadow-key');
});

test('shadow LLM config may use the global API key when no shadow key is set', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'true',
    LLM_API_KEY: 'primary-key',
    SHADOW_LLM_BASE_URL: 'http://127.0.0.1:8317/v1',
    SHADOW_LLM_MODEL: 'gpt-5.4-mini',
  });

  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(cfg.model, 'gpt-5.4-mini');
  assert.equal(cfg.apiKey, 'primary-key');
  assert.equal(cfg.reasoningEffort, '');
});

test('shadow LLM config may use NVIDIA key without persisting a shadow key', async () => {
  const cfg = await readConfig({
    SHADOW_MODE: 'true',
    NVIDIA_API_KEY: 'nvidia-key',
    SHADOW_LLM_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    SHADOW_LLM_MODEL: 'meta/llama-4-maverick-17b-128e-instruct',
  });

  assert.equal(cfg.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(cfg.model, 'meta/llama-4-maverick-17b-128e-instruct');
  assert.equal(cfg.apiKey, 'nvidia-key');
  assert.equal(cfg.reasoningEffort, '');
});
