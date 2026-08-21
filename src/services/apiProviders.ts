/**
 * Registry of supported AI providers for the Co-Pilot panel.
 *
 * Base URLs, key formats and free-tier notes are aligned with the OmniRoute
 * provider reference (github.com/diegosouzapw/OmniRoute →
 * docs/reference/PROVIDER_REFERENCE.md), last generated 2026-07-28.
 *
 * OmniRoute itself is a SELF-HOSTED local gateway: `npm install -g omniroute`,
 * run `omniroute`, then point the app at http://localhost:20128/v1. It is
 * zero-config — model `auto` works with NO API key. Providers configured in
 * OmniRoute's dashboard are reached with `provider/model` model ids (e.g.
 * `openai/gpt-5.4`, `glm/glm-5.2`).
 *
 * Each entry drives the Settings UI: the provider dropdown auto-fills the
 * base URL, the API-key field shows the expected key format, and the note
 * shows the provider's requirements. Key-format checks are soft warnings
 * only — the user can still save whatever they type.
 *
 * Entries are sorted alphabetically by display name. Key formats/base URLs
 * for the smaller gateways are best-effort; correct them here in one place
 * if a provider changes.
 */
export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** Accepted key prefixes; empty array = any prefix accepted. */
  keyPrefixes: string[];
  /** Optional stricter check (e.g. Mistral keys are UUIDs). */
  keyPattern?: RegExp;
  keyPlaceholder: string;
  /** False for providers that need no key (Ollama, OmniRoute, Pollinations). */
  needsKey: boolean;
  /** Example model id used as the placeholder / default when switching. */
  defaultModel: string;
  /** Short requirement / free-tier note shown under the provider dropdown. */
  note: string;
  /**
   * Extra inputs some providers need (e.g. Cloudflare's Account ID). Each
   * field is embedded into the base URL via a {token} placeholder; the
   * Settings UI renders a matching input that fills it in live.
   */
  extraFields?: ProviderExtraField[];
}

export interface ProviderExtraField {
  /** Placeholder token in baseUrl, e.g. "account_id" → "{account_id}". */
  token: string;
  label: string;
  placeholder?: string;
  hint?: string;
}

export const API_PROVIDERS: ApiProvider[] = [
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    baseUrl: 'https://api.agentrouter.ai/v1',
    keyPrefixes: ['sk-ar-', 'sk-'],
    keyPlaceholder: 'sk-ar-...',
    needsKey: true,
    defaultModel: 'gpt-4o',
    note: 'Multi-model routing gateway — $200 free credits on signup. Best for testing, not production.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyPrefixes: ['sk-ant-'],
    keyPlaceholder: 'sk-ant-...',
    needsKey: true,
    defaultModel: 'claude-3-5-sonnet-20241022',
    note: 'Paid API. Keys from console.anthropic.com.',
  },
  {
    id: 'bazaarlink',
    name: 'BazaarLink',
    baseUrl: 'https://bazaarlink.ai/api/v1',
    keyPrefixes: ['sk-bl-'],
    keyPlaceholder: 'sk-bl-...',
    needsKey: true,
    defaultModel: 'openai/gpt-4o',
    note: 'OpenAI SDK compatible. Keys start with sk-bl-; models use provider/model-name format.',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyPrefixes: ['csk-'],
    keyPlaceholder: 'csk-...',
    needsKey: true,
    defaultModel: 'llama-3.3-70b',
    note: 'Free trial: 1M tokens/day, 30K TPM, 5 RPM, no credit card. Keys from cloud.cerebras.ai.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    keyPrefixes: [],
    keyPlaceholder: 'paste Cloudflare API token',
    needsKey: true,
    defaultModel: '@cf/meta/llama-3.3-70b-instruct',
    note: 'Requires an API token AND your Account ID (dash.cloudflare.com). Enter the Account ID below and the base URL fills itself in.',
    extraFields: [
      {
        token: 'account_id',
        label: 'Account ID',
        placeholder: 'e.g. 9a1b2c3d4e5f...',
        hint: 'Found at dash.cloudflare.com → right sidebar. Fills the {account_id} slot in the base URL.',
      },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.com/v2',
    keyPrefixes: [],
    keyPlaceholder: 'paste Cohere API key',
    needsKey: true,
    defaultModel: 'command-r-plus',
    note: 'Free trial: 1,000 API calls/month, no credit card. Keys from dashboard.cohere.com.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyPrefixes: ['sk-'],
    keyPlaceholder: 'sk-...',
    needsKey: true,
    defaultModel: 'deepseek-chat',
    note: '5M free tokens on signup, no credit card. Keys from platform.deepseek.com.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyPrefixes: ['FW'],
    keyPlaceholder: 'FW...',
    needsKey: true,
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    note: '$1 free starter credits on signup. Keys from app.fireworks.ai.',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyPrefixes: ['AIza'],
    keyPlaceholder: 'AIza...',
    needsKey: true,
    defaultModel: 'gemini-2.0-flash',
    note: 'Free forever: ~1,500 req/day for Gemini 2.5 Flash. Keys from aistudio.google.com.',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPrefixes: ['gsk_'],
    keyPlaceholder: 'gsk_...',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    note: 'Free tier: 30 RPM / 14.4K RPD, no credit card. Keys from console.groq.com.',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    keyPrefixes: ['hf_'],
    keyPlaceholder: 'hf_...',
    needsKey: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    note: 'Free Inference API for thousands of models. Keys from huggingface.co/settings/tokens.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    keyPrefixes: [],
    keyPlaceholder: 'optional',
    needsKey: false,
    defaultModel: 'local-model',
    note: 'Local models served from LM Studio — API key optional. Start the local server first.',
  },
  {
    id: 'meta',
    name: 'Meta Llama',
    baseUrl: 'https://api.llama-api.com/v1',
    keyPrefixes: ['sk-'],
    keyPlaceholder: 'sk-...',
    needsKey: true,
    defaultModel: 'meta-llama-3.3-70b-instruct',
    note: 'Meta Llama API. Keys from llama.com.',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    keyPrefixes: [],
    keyPlaceholder: 'paste MiniMax API key',
    needsKey: true,
    defaultModel: 'MiniMax-M2.5',
    note: 'MiniMax Coding / M2.5. Keys from platform.minimax.io.',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyPrefixes: [],
    keyPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    needsKey: true,
    defaultModel: 'mistral-large-latest',
    note: 'Free Experiment tier: rate-limited access to all models. Keys are UUIDs from console.mistral.ai.',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyPrefixes: ['nvapi-'],
    keyPlaceholder: 'nvapi-...',
    needsKey: true,
    defaultModel: 'meta/llama-3.3-70b-instruct',
    note: 'Free dev access: ~40 RPM, 70+ models (Kimi K2.5, GLM 4.7, DeepSeek V3.2...). Keys from build.nvidia.com.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyPrefixes: [],
    keyPlaceholder: 'no API key needed',
    needsKey: false,
    defaultModel: 'llama3.2',
    note: 'Local models — no API key required. Make sure Ollama is running before connecting.',
  },
  {
    id: 'omniroute',
    name: 'OmniRoute (local gateway)',
    baseUrl: 'http://localhost:20128/v1',
    keyPrefixes: [],
    keyPlaceholder: 'no API key needed',
    needsKey: false,
    defaultModel: 'auto',
    note: 'Self-hosted gateway: npm install -g omniroute, run `omniroute`, zero-config. Model `auto` routes automatically; provider/model ids like openai/gpt-5.4 or glm/glm-5.2 also work.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyPrefixes: ['sk-'],
    keyPlaceholder: 'sk-...',
    needsKey: true,
    defaultModel: 'gpt-4o',
    note: 'Paid API. Keys from platform.openai.com/api-keys.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefixes: ['sk-or-', 'sk-'],
    keyPlaceholder: 'sk-or-...',
    needsKey: true,
    defaultModel: 'openai/gpt-4o',
    note: 'Multi-model aggregator. Free models at $0/token with the :free suffix (20 RPM / 200 RPD). Keys from openrouter.ai/keys.',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    keyPrefixes: ['pplx-'],
    keyPlaceholder: 'pplx-...',
    needsKey: true,
    defaultModel: 'sonar-pro',
    note: 'Search-grounded chat models. Keys from perplexity.ai/settings/api.',
  },
  {
    id: 'pollinations',
    name: 'Pollinations (free, keyless)',
    baseUrl: 'https://text.pollinations.ai/openai',
    keyPrefixes: [],
    keyPlaceholder: 'no API key needed',
    needsKey: false,
    defaultModel: 'openai',
    note: 'Free keyless tier — openai, qwen-coder, mistral, deepseek, grok and more. No signup required.',
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyPrefixes: ['sk-'],
    keyPlaceholder: 'sk-...',
    needsKey: true,
    defaultModel: 'qwen-max',
    note: 'Alibaba Cloud Model Studio / Qwen Cloud. Keys from bailian.console.alibabacloud.com.',
  },
  {
    id: 'scaleway',
    name: 'Scaleway AI',
    baseUrl: 'https://api.scaleway.ai/v1',
    keyPrefixes: ['SCW'],
    keyPlaceholder: 'SCW...',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-instruct',
    note: '1M free tokens for new accounts — EU/GDPR compliant (Paris). Keys from console.scaleway.com.',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyPrefixes: ['sk-'],
    keyPlaceholder: 'sk-...',
    needsKey: true,
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    note: '$1 free credits plus permanently free models after identity verification.',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyPrefixes: ['tgp_'],
    keyPlaceholder: 'tgp_v1_...',
    needsKey: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    note: 'Open-model inference. Keys from api.together.ai.',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    keyPrefixes: ['xai-'],
    keyPlaceholder: 'xai-...',
    needsKey: true,
    defaultModel: 'grok-2-latest',
    note: 'Paid API. Keys from console.x.ai.',
  },
];

/**
 * Looks up a provider by id. Returns null when the id is empty (the settings
 * default "None") or unknown, so the UI can keep the fields disabled until
 * a provider is actually chosen.
 */
export function getApiProvider(id?: string): ApiProvider | null {
  if (!id) return null;
  return API_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Soft key-format check. Empty keys pass (nothing entered yet); otherwise the
 * key must match the provider's prefix(es) or, when defined, its pattern.
 */
export function isValidKeyForProvider(provider: ApiProvider, apiKey: string): boolean {
  if (!provider.needsKey) return true;
  const key = apiKey.trim();
  if (!key) return true;
  if (provider.keyPattern) return provider.keyPattern.test(key);
  if (provider.keyPrefixes.length === 0) return true;
  return provider.keyPrefixes.some((prefix) => key.startsWith(prefix));
}

/** Human-readable description of what a valid key looks like. */
export function describeKeyFormat(provider: ApiProvider): string {
  if (provider.keyPattern) return 'a UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)';
  if (provider.keyPrefixes.length === 0) return 'any format';
  return `starts with ${provider.keyPrefixes.map((p) => `'${p}'`).join(' or ')}`;
}

/**
 * Extracts the value currently occupying a {token} slot in a base URL, or ''
 * when the token isn't present (field already filled, or URL edited by hand).
 */
export function extractTokenValue(baseUrl: string, token: string): string {
  const tokenStr = `{${token}}`;
  const idx = baseUrl.indexOf(tokenStr);
  if (idx === -1) return '';
  let end = idx + tokenStr.length;
  while (end < baseUrl.length && baseUrl[end] !== '/') end++;
  return baseUrl.slice(idx + tokenStr.length, end);
}

/**
 * Fills (or clears) a {token} slot in a base URL. Empty values leave the
 * template placeholder in place so the user can see what's still missing.
 */
export function injectTokenValue(baseUrl: string, token: string, value: string): string {
  const tokenStr = `{${token}}`;
  if (!baseUrl.includes(tokenStr)) return baseUrl;
  const clean = value.trim();
  if (!clean) return baseUrl;
  return baseUrl.replace(tokenStr, clean);
}
