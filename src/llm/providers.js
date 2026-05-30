import axios from 'axios';
import {
  CLIPROXY_LLM_API_KEY,
  CLIPROXY_LLM_BASE_URL,
  CLIPROXY_LLM_MODEL,
  DEFAULT_LLM_API_KEY,
  ENABLE_LLM,
  GEMINI_LLM_API_KEY,
  GEMINI_LLM_BASE_URL,
  GEMINI_LLM_MODEL,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
  LLM_PROVIDER_ORDER,
  GROQ_LLM_API_KEY,
  GROQ_LLM_BASE_URL,
  GROQ_LLM_MODEL,
  MISTRAL_LLM_API_KEY,
  MISTRAL_LLM_BASE_URL,
  MISTRAL_LLM_MODEL,
  MIMO_LLM_API_KEY,
  MIMO_LLM_BASE_URL,
  MIMO_LLM_MODEL,
} from '../config.js';

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parseOrder(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function hasUsableKey(provider) {
  return Boolean(provider.apiKey) || provider.auth === 'none';
}

function providerHost(provider) {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function modelLooksJsonModeSafe(model) {
  return /^mimo(?:-|$)/i.test(String(model || ''));
}

function endpointLooksJsonModeSafe(provider) {
  const host = providerHost(provider);
  return [
    /(^|\.)xiaomimimo\.com$/,
    /^api\.mistral\.ai$/,
    /^api\.groq\.com$/,
    /(^|\.)openrouter\.ai$/,
    /^api\.openai\.com$/,
  ].some(pattern => pattern.test(host));
}

function shouldApplyJsonResponseFormat(body, provider) {
  if (body.response_format) return false;
  const model = provider.model || body.model;
  return endpointLooksJsonModeSafe(provider) || modelLooksJsonModeSafe(model);
}

function configuredProviders() {
  return {
    mimo: {
      id: 'mimo',
      label: 'xiaomi-mimo',
      baseUrl: cleanBaseUrl(MIMO_LLM_BASE_URL),
      model: MIMO_LLM_MODEL,
      apiKey: MIMO_LLM_API_KEY,
      auth: 'api-key',
      supportsReasoningEffort: false,
    },
    groq: {
      id: 'groq',
      label: 'groq',
      baseUrl: cleanBaseUrl(GROQ_LLM_BASE_URL),
      model: GROQ_LLM_MODEL,
      apiKey: GROQ_LLM_API_KEY,
      auth: 'bearer',
      supportsReasoningEffort: false,
    },
    mistral: {
      id: 'mistral',
      label: 'mistral',
      baseUrl: cleanBaseUrl(MISTRAL_LLM_BASE_URL),
      model: MISTRAL_LLM_MODEL,
      apiKey: MISTRAL_LLM_API_KEY,
      auth: 'bearer',
      endpointFamily: 'openai_chat_completions',
      supportsReasoningEffort: false,
    },
    gemini: {
      id: 'gemini',
      label: 'gemini',
      baseUrl: cleanBaseUrl(GEMINI_LLM_BASE_URL),
      model: GEMINI_LLM_MODEL,
      apiKey: GEMINI_LLM_API_KEY,
      auth: 'x-goog-api-key',
      endpointFamily: 'gemini_generate_content',
      supportsReasoningEffort: false,
    },
    cliproxy: {
      id: 'cliproxy',
      label: 'cliproxy-api',
      baseUrl: cleanBaseUrl(CLIPROXY_LLM_BASE_URL),
      model: CLIPROXY_LLM_MODEL,
      apiKey: CLIPROXY_LLM_API_KEY,
      auth: 'bearer',
      endpointFamily: 'openai_chat_completions',
      supportsReasoningEffort: true,
    },
    legacy: {
      id: 'legacy',
      label: llmProviderNameFromBaseUrl(LLM_BASE_URL),
      baseUrl: cleanBaseUrl(LLM_BASE_URL),
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      auth: 'bearer',
      endpointFamily: 'openai_chat_completions',
      supportsReasoningEffort: true,
    },
  };
}

export function llmProviderNameFromBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'openai-compatible';
  }
}

export function resolveLlmProviders({
  order = LLM_PROVIDER_ORDER,
  includeUnavailable = false,
} = {}) {
  const providers = configuredProviders();
  const selected = parseOrder(order).length ? parseOrder(order) : ['mimo', 'cliproxy'];
  const unique = [...new Set(selected)];
  return unique
    .map(id => providers[id])
    .filter(Boolean)
    .filter(provider => includeUnavailable || hasUsableKey(provider));
}

export function primaryLlmProvider({ includeUnavailable = false } = {}) {
  return resolveLlmProviders({ includeUnavailable })[0] || null;
}

export function llmConfigured() {
  return Boolean(ENABLE_LLM && primaryLlmProvider());
}

function authHeaders(provider) {
  if (provider.auth === 'api-key') return { 'api-key': provider.apiKey };
  if (provider.auth === 'bearer') return { authorization: `Bearer ${provider.apiKey || DEFAULT_LLM_API_KEY}` };
  if (provider.auth === 'x-goog-api-key') return { 'x-goog-api-key': provider.apiKey };
  return {};
}

function geminiContentsFromMessages(messages) {
  return (messages || [])
    .filter(message => message?.role !== 'system')
    .map(message => ({
      role: message?.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message?.content || '') }],
    }))
    .filter(content => content.parts[0].text);
}

function geminiSystemInstruction(messages) {
  const text = (messages || [])
    .filter(message => message?.role === 'system')
    .map(message => String(message?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return text ? { parts: [{ text }] } : undefined;
}

function bodyForProvider(body, provider) {
  if (provider.endpointFamily === 'gemini_generate_content') {
    const maxOutputTokens = Number(body.max_tokens || body.max_completion_tokens || 1024);
    const next = {
      generationConfig: {
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2,
        maxOutputTokens: maxOutputTokens > 0 ? maxOutputTokens : 1024,
        responseMimeType: 'application/json',
      },
      contents: geminiContentsFromMessages(body.messages),
    };
    const systemInstruction = geminiSystemInstruction(body.messages);
    if (systemInstruction) next.systemInstruction = systemInstruction;
    return next;
  }
  const next = {
    ...body,
    model: provider.model || body.model,
  };
  if (!provider.supportsReasoningEffort) {
    delete next.reasoning_effort;
  }
  if (shouldApplyJsonResponseFormat(next, provider)) {
    next.response_format = { type: 'json_object' };
  }
  return next;
}

function urlForProvider(provider) {
  if (provider.endpointFamily === 'gemini_generate_content') {
    return `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent`;
  }
  return `${provider.baseUrl}/chat/completions`;
}

function normalizeGeminiResponse(response, provider) {
  if (provider.endpointFamily !== 'gemini_generate_content') return response;
  const content = (response?.data?.candidates || [])
    .flatMap(candidate => candidate?.content?.parts || [])
    .map(part => part?.text)
    .filter(Boolean)
    .join('\n');
  const usage = response?.data?.usageMetadata || {};
  return {
    ...response,
    data: {
      ...response.data,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: response?.data?.candidates?.[0]?.finishReason || null,
      }],
      usage: {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0,
      },
      gemini_usage: usage,
    },
  };
}

function providerErrorClass(err) {
  if (err?.errorClass) return err.errorClass;
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))) return 'timeout';
  if (err?.response?.status) return `http_${err.response.status}`;
  return err?.name || 'error';
}

function responseContentBytes(response) {
  const content = response?.data?.choices?.[0]?.message?.content;
  return Buffer.byteLength(String(content || ''), 'utf8');
}

export async function postChatCompletion(body, {
  timeout = 90_000,
  signal = null,
  order = LLM_PROVIDER_ORDER,
  axiosClient = axios,
  validateResponse = null,
} = {}) {
  const providers = resolveLlmProviders({ order });
  if (!ENABLE_LLM || !providers.length) {
    throw new Error('LLM disabled or no configured LLM provider has a usable key.');
  }

  const attempts = [];
  let lastError = null;
  for (const provider of providers) {
    const requestBody = bodyForProvider(body, provider);
    const attemptStartedAt = Date.now();
    try {
      const rawResponse = await axiosClient.post(urlForProvider(provider), requestBody, {
        timeout,
        signal,
        headers: {
          ...authHeaders(provider),
          'content-type': 'application/json',
        },
      });
      const response = normalizeGeminiResponse(rawResponse, provider);
      if (validateResponse) {
        await validateResponse({ response, provider, requestBody });
      }
      return {
        response,
        provider,
        requestBody,
        attempts: [...attempts, {
          provider: provider.id,
          providerLabel: provider.label,
          model: provider.model,
          status: 'success',
          responseBytes: responseContentBytes(response),
          latencyMs: Date.now() - attemptStartedAt,
        }],
      };
    } catch (err) {
      lastError = err;
      const errorClass = providerErrorClass(err);
      attempts.push({
        provider: provider.id,
        providerLabel: provider.label,
        model: provider.model,
        status: 'error',
        errorClass,
        responseBytes: err?.responseBytes ?? responseContentBytes(err?.response),
        latencyMs: Date.now() - attemptStartedAt,
        message: err?.message || String(err),
      });
      console.log(`[llm] provider ${provider.id} failed: ${err?.message || err}; trying fallback if available`);
    }
  }

  const err = new Error(`All LLM providers failed: ${attempts.map(item => `${item.provider}:${item.errorClass || item.status}`).join(', ')}`);
  err.cause = lastError;
  err.attempts = attempts;
  err.errorClass = attempts.at(-1)?.errorClass || 'all_providers_failed';
  err.responseBytes = attempts.at(-1)?.responseBytes || 0;
  throw err;
}
