/**
 * Centralized Model Definitions
 * Single source of truth for all supported AI models
 */

/**
 * Claude (Anthropic) Models
 *
 * Note: Claude uses two different formats:
 * - SDK format ('sonnet', 'opus') - used by the UI and claude-sdk.js
 * - API format ('claude-sonnet-4.5') - used by slash commands for display
 */
export const CLAUDE_MODELS = {
  // Models in SDK format (what the actual SDK accepts)
  OPTIONS: [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
    { value: "opusplan", label: "Opus Plan" },
    { value: "sonnet[1m]", label: "Sonnet [1M]" },
  ],

  DEFAULT: "sonnet",
};

/**
 * Cursor Models
 */
export const CURSOR_MODELS = {
  OPTIONS: [
    { value: "opus-4.6-thinking", label: "Claude 4.6 Opus (Thinking)" },
    { value: "gpt-5.3-codex", label: "GPT-5.3" },
    { value: "gpt-5.2-high", label: "GPT-5.2 High" },
    { value: "gemini-3-pro", label: "Gemini 3 Pro" },
    { value: "opus-4.5-thinking", label: "Claude 4.5 Opus (Thinking)" },
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.1", label: "GPT-5.1" },
    { value: "gpt-5.1-high", label: "GPT-5.1 High" },
    { value: "composer-1", label: "Composer 1" },
    { value: "auto", label: "Auto" },
    { value: "sonnet-4.5", label: "Claude 4.5 Sonnet" },
    { value: "sonnet-4.5-thinking", label: "Claude 4.5 Sonnet (Thinking)" },
    { value: "opus-4.5", label: "Claude 4.5 Opus" },
    { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { value: "gpt-5.1-codex-high", label: "GPT-5.1 Codex High" },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { value: "gpt-5.1-codex-max-high", label: "GPT-5.1 Codex Max High" },
    { value: "opus-4.1", label: "Claude 4.1 Opus" },
    { value: "grok", label: "Grok" },
  ],

  DEFAULT: "gpt-5-3-codex",
};

/**
 * Codex (OpenAI) Models
 */
export const CODEX_MODELS = {
  OPTIONS: [
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { value: "o3", label: "O3" },
    { value: "o4-mini", label: "O4-mini" },
  ],

  DEFAULT: "gpt-5.4",
};

/**
 * Gemini Models
 */
export const GEMINI_MODELS = {
  OPTIONS: [
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { value: "gemini-2.0-pro-exp", label: "Gemini 2.0 Pro Experimental" },
    {
      value: "gemini-2.0-flash-thinking-exp",
      label: "Gemini 2.0 Flash Thinking",
    },
  ],

  DEFAULT: "gemini-2.5-flash",
};

/**
 * MangoCode Models (Rust CC reimplementation — multi-provider)
 *
 * Value format: "mangoProvider:publisherPrefix/modelId"
 *   e.g. "google-vertex:anthropic/claude-opus-4-6"
 * The part before the colon is the MangoCode --provider flag.
 * The part after the colon is the MangoCode --model flag.
 */
export const MANGOCODE_MODELS = {
  OPTIONS: [
    // Google Vertex AI
    { value: "google-vertex:google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "google-vertex" },
    { value: "google-vertex:google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google-vertex" },
    { value: "google-vertex:google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google-vertex" },
    // TODO: Enable when Vertex Anthropic Messages API is supported in MangoCode
    // { value: "google-vertex:anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Vertex)", provider: "google-vertex" },
    // { value: "google-vertex:anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (Vertex)", provider: "google-vertex" },
    // TODO: Enable when ANTHROPIC_API_KEY is configured
    // { value: "anthropic:claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
    // { value: "anthropic:claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic" },
    // TODO: Enable when OPENAI_API_KEY is configured
    // { value: "openai:gpt-4o", label: "GPT-4o", provider: "openai" },
    // { value: "openai:o3", label: "o3", provider: "openai" },
    // TODO: Enable when Ollama is running
    // { value: "ollama:llama3", label: "Llama 3 (Local)", provider: "ollama" },
  ],

  PROVIDERS: {
    "google-vertex": "Google Vertex AI",
    // "anthropic": "Anthropic (Direct)",
    // "openai": "OpenAI",
    // "ollama": "Ollama (Local)",
  },

  DEFAULT: "google-vertex:google/gemini-2.5-pro",
};

/**
 * Parse a MangoCode "provider:model" composite string.
 * Returns { provider, model } with backward-compat for legacy bare model strings.
 */
export function parseMangocodeModel(composite) {
  if (!composite) return { provider: 'google-vertex', model: 'google/gemini-2.5-pro' };
  const colonIdx = composite.indexOf(':');
  if (colonIdx === -1) {
    // Legacy format without colon — default to google-vertex
    return { provider: 'google-vertex', model: composite };
  }
  return {
    provider: composite.slice(0, colonIdx),
    model: composite.slice(colonIdx + 1),
  };
}
