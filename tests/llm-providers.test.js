import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function runProviderSnippet(env, snippet) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', snippet], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      CHARON_SKIP_DOTENV: 'true',
      ...env,
    },
  });
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('LLM providers prefer MiMo token plan when key is present and fall back to cliproxy', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    MIMO_API_KEY: 'mimo-key',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      auth: provider.auth,
    }))));
  `);

  assert.deepEqual(result, [
    {
      id: 'mimo',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      model: 'mimo-v2.5-pro',
      auth: 'api-key',
    },
    {
      id: 'cliproxy',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'gpt-5.5',
      auth: 'bearer',
    },
  ]);
});

test('LLM providers skip MiMo when no MiMo key is configured', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => provider.id)));
  `);

  assert.deepEqual(result, ['cliproxy']);
});

test('LLM providers resolve scout free-provider fallback order only when keys are present', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'mimo,groq,mistral,gemini,cliproxy',
    MIMO_API_KEY: 'mimo-key',
    GROQ_API_KEY: 'groq-key',
    MISTRAL_API_KEY: 'mistral-key',
    GEMINI_API_KEY: 'gemini-key',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      auth: provider.auth,
      endpointFamily: provider.endpointFamily,
      supportsReasoningEffort: provider.supportsReasoningEffort,
    }))));
  `);

  assert.deepEqual(result, [
    {
      id: 'mimo',
      label: 'xiaomi-mimo',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      model: 'mimo-v2.5-pro',
      auth: 'api-key',
      supportsReasoningEffort: false,
    },
    {
      id: 'groq',
      label: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant',
      auth: 'bearer',
      supportsReasoningEffort: false,
    },
    {
      id: 'mistral',
      label: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'open-mistral-nemo',
      auth: 'bearer',
      endpointFamily: 'openai_chat_completions',
      supportsReasoningEffort: false,
    },
    {
      id: 'gemini',
      label: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash-lite',
      auth: 'x-goog-api-key',
      endpointFamily: 'gemini_generate_content',
      supportsReasoningEffort: false,
    },
    {
      id: 'cliproxy',
      label: 'cliproxy-api',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'gpt-5.5',
      auth: 'bearer',
      endpointFamily: 'openai_chat_completions',
      supportsReasoningEffort: true,
    },
  ]);

  const missingKeys = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'mimo,groq,mistral',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => provider.id)));
  `);

  assert.deepEqual(missingKeys, []);
});

test('postChatCompletion calls Gemini generateContent and normalizes response', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'gemini',
    GEMINI_API_KEY: 'gemini-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        return {
          data: {
            candidates: [{
              content: { parts: [{ text: '{"verdict":"WATCH","confidence":72,"reason":"ok","risks":["risk"],"suggested_tp_percent":60,"suggested_sl_percent":-20}' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: {
              promptTokenCount: 1234,
              candidatesTokenCount: 56,
              totalTokenCount: 1290,
            },
          },
        };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    const result = await postChatCompletion({
      model: 'placeholder',
      temperature: 0,
      max_completion_tokens: 300,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'system rules' },
        { role: 'user', content: 'pick candidate' },
      ],
    }, {
      axiosClient,
      timeout: 1,
      validateResponse({ response }) {
        JSON.parse(response.data.choices[0].message.content);
      },
    });
    console.log(JSON.stringify({
      provider: result.provider.id,
      response: result.response.data,
      call: calls[0],
    }));
  `);

  assert.equal(result.provider, 'gemini');
  assert.equal(result.call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.equal(result.call.headers.authorization, undefined);
  assert.equal(result.call.headers['x-goog-api-key'], 'gemini-key');
  assert.deepEqual(result.call.body.systemInstruction, { parts: [{ text: 'system rules' }] });
  assert.deepEqual(result.call.body.contents, [{ role: 'user', parts: [{ text: 'pick candidate' }] }]);
  assert.equal(result.call.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(result.call.body.generationConfig.maxOutputTokens, 300);
  assert.equal(result.response.choices[0].message.content.includes('"verdict":"WATCH"'), true);
  assert.deepEqual(result.response.usage, {
    prompt_tokens: 1234,
    completion_tokens: 56,
    total_tokens: 1290,
  });
});

test('cliproxy provider uses dedicated cliproxy key when configured', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    CLIPROXY_LLM_API_KEY: 'proxy-key',
    LLM_PROVIDER_ORDER: 'cliproxy',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => ({
      id: provider.id,
      apiKey: provider.apiKey,
      auth: provider.auth,
    }))));
  `);

  assert.deepEqual(result, [
    {
      id: 'cliproxy',
      apiKey: 'proxy-key',
      auth: 'bearer',
    },
  ]);
});

test('cliproxy provider reuses local shadow proxy overrides when they point to cli-proxy', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'cliproxy',
    SHADOW_LLM_BASE_URL: 'http://127.0.0.1:8317/v1',
    SHADOW_LLM_MODEL: 'gpt-5.4-mini',
    SHADOW_LLM_API_KEY: 'shadow-proxy-key',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey,
    }))));
  `);

  assert.deepEqual(result, [
    {
      id: 'cliproxy',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'gpt-5.4-mini',
      apiKey: 'NO_API_KEY',
    },
  ]);
});

test('shadow LLM providers use the shadow endpoint and do not include MiMo by default', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'true',
    SHADOW_LLM_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    SHADOW_LLM_MODEL: 'meta/llama-4-maverick-17b-128e-instruct',
    NVIDIA_API_KEY: 'shadow-free-key',
    MIMO_API_KEY: 'mimo-key',
  }, `
    const { resolveLlmProviders } = await import('./src/llm/providers.js');
    console.log(JSON.stringify(resolveLlmProviders().map(provider => ({
      id: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      auth: provider.auth,
    }))));
  `);

  assert.deepEqual(result, [
    {
      id: 'legacy',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'meta/llama-4-maverick-17b-128e-instruct',
      auth: 'bearer',
    },
    {
      id: 'cliproxy',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'gpt-5.5',
      auth: 'bearer',
    },
  ]);
});

test('postChatCompletion uses MiMo api-key auth and falls back to cliproxy bearer auth', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    MIMO_API_KEY: 'mimo-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        if (calls.length === 1) {
          const err = new Error('mimo unavailable');
          err.response = { status: 503 };
          throw err;
        }
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    const result = await postChatCompletion({
      model: 'placeholder',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    }, { axiosClient, timeout: 1 });
    console.log(JSON.stringify({
      provider: result.provider.id,
      attempts: result.attempts.map(item => item.provider + ':' + item.status),
      first: calls[0],
      second: calls[1],
    }));
  `);

  assert.equal(result.provider, 'cliproxy');
  assert.deepEqual(result.attempts, ['mimo:error', 'cliproxy:success']);
  assert.equal(result.first.url, 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
  assert.equal(result.first.headers['api-key'], 'mimo-key');
  assert.equal(result.first.headers.authorization, undefined);
  assert.equal(result.first.body.model, 'mimo-v2.5-pro');
  assert.equal(result.first.body.reasoning_effort, undefined);
  assert.deepEqual(result.first.body.response_format, { type: 'json_object' });
  assert.equal(result.second.url, 'http://127.0.0.1:8317/v1/chat/completions');
  assert.equal(result.second.headers.authorization, 'Bearer NO_API_KEY');
  assert.equal(result.second.body.reasoning_effort, 'low');
  assert.equal(result.second.body.response_format, undefined);
});

test('postChatCompletion auto-adds JSON response format for known JSON-mode endpoints', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'legacy',
    LLM_BASE_URL: 'https://api.mistral.ai/v1',
    LLM_MODEL: 'mistral-tiny-latest',
    LLM_API_KEY: 'mistral-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    await postChatCompletion({
      model: 'placeholder',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    }, { axiosClient, timeout: 1 });
    console.log(JSON.stringify(calls[0]));
  `);

  assert.equal(result.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(result.body.model, 'mistral-tiny-latest');
  assert.equal(result.body.reasoning_effort, 'low');
  assert.deepEqual(result.body.response_format, { type: 'json_object' });
});

test('postChatCompletion falls back through Groq and Mistral with JSON mode and no reasoning effort', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'mimo,groq,mistral',
    MIMO_API_KEY: 'mimo-key',
    GROQ_API_KEY: 'groq-key',
    MISTRAL_API_KEY: 'mistral-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        if (calls.length < 3) {
          const err = new Error('provider unavailable');
          err.response = { status: 503 };
          throw err;
        }
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    const result = await postChatCompletion({
      model: 'placeholder',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    }, { axiosClient, timeout: 1 });
    console.log(JSON.stringify({
      provider: result.provider.id,
      attempts: result.attempts.map(item => item.provider + ':' + item.status),
      calls,
    }));
  `);

  assert.equal(result.provider, 'mistral');
  assert.deepEqual(result.attempts, ['mimo:error', 'groq:error', 'mistral:success']);
  assert.equal(result.calls[0].url, 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
  assert.equal(result.calls[1].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(result.calls[2].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(result.calls[1].headers.authorization, 'Bearer groq-key');
  assert.equal(result.calls[2].headers.authorization, 'Bearer mistral-key');
  assert.deepEqual(result.calls[1].body.response_format, { type: 'json_object' });
  assert.deepEqual(result.calls[2].body.response_format, { type: 'json_object' });
  assert.equal(result.calls[1].body.reasoning_effort, undefined);
  assert.equal(result.calls[2].body.reasoning_effort, undefined);
});

test('postChatCompletion preserves caller response format and does not add JSON mode to cli-proxy', async () => {
  const cliproxy = await runProviderSnippet({
    SHADOW_MODE: 'false',
    LLM_PROVIDER_ORDER: 'cliproxy',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    await postChatCompletion({
      model: 'placeholder',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    }, { axiosClient, timeout: 1 });
    console.log(JSON.stringify(calls[0].body));
  `);

  assert.equal(cliproxy.model, 'gpt-5.5');
  assert.equal(cliproxy.reasoning_effort, 'low');
  assert.equal(cliproxy.response_format, undefined);

  const preserved = await runProviderSnippet({
    SHADOW_MODE: 'false',
    MIMO_API_KEY: 'mimo-key',
    LLM_PROVIDER_ORDER: 'mimo',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    await postChatCompletion({
      model: 'placeholder',
      response_format: { type: 'text' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { axiosClient, timeout: 1 });
    console.log(JSON.stringify(calls[0].body));
  `);

  assert.deepEqual(preserved.response_format, { type: 'text' });
});

test('postChatCompletion treats empty semantic content as retryable provider failure', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    MIMO_API_KEY: 'mimo-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        if (calls.length === 1) {
          return { data: { choices: [{ message: { content: '' } }] } };
        }
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    const result = await postChatCompletion({
      model: 'placeholder',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      axiosClient,
      timeout: 1,
      validateResponse({ response }) {
        const content = response.data?.choices?.[0]?.message?.content || '';
        if (!content) {
          const err = new Error('empty semantic response');
          err.errorClass = 'empty_content';
          err.responseBytes = 0;
          throw err;
        }
        JSON.parse(content);
      },
    });
    console.log(JSON.stringify({
      provider: result.provider.id,
      attempts: result.attempts.map(item => ({
        provider: item.provider,
        status: item.status,
        errorClass: item.errorClass,
        responseBytes: item.responseBytes,
      })),
    }));
  `);

  assert.equal(result.provider, 'cliproxy');
  assert.deepEqual(result.attempts, [
    { provider: 'mimo', status: 'error', errorClass: 'empty_content', responseBytes: 0 },
    { provider: 'cliproxy', status: 'success', responseBytes: 33 },
  ]);
});

test('postChatCompletion treats malformed semantic content as retryable provider failure', async () => {
  const result = await runProviderSnippet({
    SHADOW_MODE: 'false',
    MIMO_API_KEY: 'mimo-key',
  }, `
    const calls = [];
    const axiosClient = {
      async post(url, body, options) {
        calls.push({ url, body, headers: options.headers });
        if (calls.length === 1) {
          return { data: { choices: [{ message: { content: '{bad json' } }] } };
        }
        return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":1}' } }] } };
      },
    };
    const { postChatCompletion } = await import('./src/llm/providers.js');
    const result = await postChatCompletion({
      model: 'placeholder',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      axiosClient,
      timeout: 1,
      validateResponse({ response }) {
        const content = response.data?.choices?.[0]?.message?.content || '';
        try {
          JSON.parse(content);
        } catch (cause) {
          const err = new Error('malformed semantic response');
          err.errorClass = 'parse_error';
          err.responseBytes = Buffer.byteLength(content, 'utf8');
          throw err;
        }
      },
    });
    console.log(JSON.stringify({
      provider: result.provider.id,
      attempts: result.attempts.map(item => ({
        provider: item.provider,
        status: item.status,
        errorClass: item.errorClass,
        responseBytes: item.responseBytes,
      })),
    }));
  `);

  assert.equal(result.provider, 'cliproxy');
  assert.deepEqual(result.attempts, [
    { provider: 'mimo', status: 'error', errorClass: 'parse_error', responseBytes: 9 },
    { provider: 'cliproxy', status: 'success', responseBytes: 33 },
  ]);
});
