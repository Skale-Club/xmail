-- 050: Campaign content language for language-aware personalization.
-- Internal template tokens stay in English while rendered values follow the
-- campaign's BCP-47 language (for example en, pt-BR, or es-US).

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS content_language text NOT NULL DEFAULT 'en';

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_content_language_valid;

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_content_language_valid
  CHECK (content_language ~ '^[a-z]{2}(-[A-Z]{2})?$');

COMMENT ON COLUMN public.campaigns.content_language IS
  'BCP-47 language used to resolve multilingual lead personalization values.';
