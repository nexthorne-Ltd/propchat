-- Add order_index to articles table for custom article sequencing in sections
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_articles_section_order ON public.articles(section_id, order_index);
