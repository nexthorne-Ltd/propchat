-- Clean up legacy workspace-level AI API keys, provider credentials, and model configurations
-- Workspaces access AI exclusively via their platform plan quota and platform_ai_settings.

UPDATE public.workspaces
SET ai_settings = (
  ai_settings
  - 'api_key'
  - 'anthropic_api_key'
  - 'provider'
  - 'base_url'
  - 'model'
)
WHERE ai_settings IS NOT NULL
  AND (
    ai_settings ? 'api_key'
    OR ai_settings ? 'anthropic_api_key'
    OR ai_settings ? 'provider'
    OR ai_settings ? 'base_url'
    OR ai_settings ? 'model'
  );
