/**
 * Default model per provider, used when the workspace has not named a model.
 * Kept free of SDK imports so client components (Settings) can show the exact
 * value the server will fall back to.
 */
export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
  google: 'gemini-3.8-flash',
  // deepseek-chat is the general model; deepseek-reasoner is the thinking one.
  deepseek: 'deepseek-chat',
  compatible: '',
} as const;
