-- Migration: article_slug_redirects_and_uniqueness
-- 1. Fix corrupted/duplicated slugs in existing data
UPDATE articles 
SET slug = '1-step-standard' 
WHERE slug = '1-step-standard1-step-standard' 
  AND id = '82a90fa6-09ec-4265-bad4-ce418e8b4035';

UPDATE articles 
SET slug = 'is-there-an-inactivity-rule' 
WHERE slug = '-is-there-an-inactivity-rule' 
  AND id = 'cb5a9368-a8a7-4e15-8302-cde1ed34cb1a';

UPDATE articles 
SET slug = 'comparison-summary-table' 
WHERE slug = '-comparison-summary-table' 
  AND id = 'aaa22d0f-3f1c-4cf2-8a40-9be78b14e812';

-- 2. Create article_slug_redirects table
CREATE TABLE IF NOT EXISTS article_slug_redirects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    old_slug TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_workspace_old_slug UNIQUE(workspace_id, old_slug)
);

CREATE INDEX IF NOT EXISTS idx_article_slug_redirects_lookup 
ON article_slug_redirects(workspace_id, old_slug);

-- 3. Seed redirects for the fixed slugs so existing URLs redirect seamlessly
INSERT INTO article_slug_redirects (workspace_id, article_id, old_slug)
VALUES 
  ('47345f70-4895-4ff6-bcf8-153034225cae', '82a90fa6-09ec-4265-bad4-ce418e8b4035', '1-step-standard1-step-standard'),
  ('47345f70-4895-4ff6-bcf8-153034225cae', 'cb5a9368-a8a7-4e15-8302-cde1ed34cb1a', '-is-there-an-inactivity-rule'),
  ('47345f70-4895-4ff6-bcf8-153034225cae', 'aaa22d0f-3f1c-4cf2-8a40-9be78b14e812', '-comparison-summary-table')
ON CONFLICT (workspace_id, old_slug) DO NOTHING;

-- 4. Enable RLS on article_slug_redirects
ALTER TABLE article_slug_redirects ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'article_slug_redirects' 
    AND policyname = 'Allow public read of article slug redirects'
  ) THEN
    CREATE POLICY "Allow public read of article slug redirects"
    ON article_slug_redirects FOR SELECT
    TO anon, authenticated
    USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'article_slug_redirects' 
    AND policyname = 'Allow workspace agents to manage article slug redirects'
  ) THEN
    CREATE POLICY "Allow workspace agents to manage article slug redirects"
    ON article_slug_redirects FOR ALL
    TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM agents
        WHERE agents.id = auth.uid()
        AND agents.workspace_id = article_slug_redirects.workspace_id
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM agents
        WHERE agents.id = auth.uid()
        AND agents.workspace_id = article_slug_redirects.workspace_id
      )
    );
  END IF;
END $$;

-- 5. Unique constraint on articles(workspace_id, slug) to guarantee uniqueness per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_workspace_slug 
ON articles(workspace_id, slug);
