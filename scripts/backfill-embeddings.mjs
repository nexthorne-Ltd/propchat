import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing supabase credentials in env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

function estimateTokenCount(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  return Math.max(1, Math.round(Math.max(words * 1.3, chars / 4)));
}

function splitMarkdownBlocks(markdown) {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let current = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      current.push(line);
      continue;
    }
    if (inCode) {
      current.push(line);
      continue;
    }
    if (/^#{1,6}\s+/.test(line.trim())) {
      if (current.length) {
        blocks.push(current.join('\n').trim());
        current = [];
      }
      current.push(line);
      continue;
    }
    if (line.trim() === '' && current.length) {
      blocks.push(current.join('\n').trim());
      current = [];
      continue;
    }
    if (line.trim() !== '') {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n').trim());
  return blocks.filter(Boolean);
}

function splitArticleIntoChunks(article) {
  const title = (article.title || '').trim();
  const sectionName = (article.sectionName || article.category || 'General').trim();
  const header = `Article: ${title}\nSection: ${sectionName}\n\n`;
  const headerTokens = estimateTokenCount(header);

  const TARGET_MAX_TOKENS = 650;
  const blocks = splitMarkdownBlocks(article.content);
  const rawChunks = [];
  let currentBodyBlocks = [];
  let currentTokens = headerTokens;

  for (const block of blocks) {
    const blockTokens = estimateTokenCount(block);

    if (blockTokens > TARGET_MAX_TOKENS) {
      if (currentBodyBlocks.length > 0) {
        rawChunks.push(header + currentBodyBlocks.join('\n\n'));
        currentBodyBlocks = [];
        currentTokens = headerTokens;
      }
      const sentences = block.split(/(?<=[.!?])\s+/);
      let subSentences = [];
      let subTokens = headerTokens;
      for (const sent of sentences) {
        const sTokens = estimateTokenCount(sent);
        if (subTokens + sTokens > TARGET_MAX_TOKENS && subSentences.length > 0) {
          rawChunks.push(header + subSentences.join(' '));
          subSentences = [];
          subTokens = headerTokens;
        }
        subSentences.push(sent);
        subTokens += sTokens;
      }
      if (subSentences.length > 0) {
        rawChunks.push(header + subSentences.join(' '));
      }
      continue;
    }

    if (currentTokens + blockTokens > TARGET_MAX_TOKENS && currentBodyBlocks.length > 0) {
      rawChunks.push(header + currentBodyBlocks.join('\n\n'));
      currentBodyBlocks = [];
      currentTokens = headerTokens;
    }

    currentBodyBlocks.push(block);
    currentTokens += blockTokens;
  }

  if (currentBodyBlocks.length > 0) {
    rawChunks.push(header + currentBodyBlocks.join('\n\n'));
  }

  if (rawChunks.length === 0) {
    rawChunks.push(`${header}${article.summary ? `${article.summary}\n\n` : ''}${title}`);
  }

  return rawChunks.map((content, idx) => ({
    workspace_id: article.workspace_id,
    article_id: article.id,
    article_title: title,
    section_name: sectionName,
    article_slug: article.slug || null,
    chunk_index: idx,
    content,
    token_count: estimateTokenCount(content),
  }));
}

async function getEmbeddings(texts, apiKey, baseUrl) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/embeddings';
  const isDeepInfra = (baseUrl || '').includes('deepinfra.com');
  const model = isDeepInfra ? 'google/embeddinggemma-300m' : 'text-embedding-3-small';
  const results = [];
  const BATCH_SIZE = 15;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const bodyPayload = { model, input: batch };
    if (model === 'text-embedding-3-small') bodyPayload.dimensions = 768;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedding call failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const sorted = (data.data || []).sort((a, b) => a.index - b.index);
    for (const item of sorted) results.push(item.embedding);
  }
  return results;
}

async function run() {
  console.log('Fetching platform AI settings...');
  const { data: aiSettings, error: aiErr } = await supabase
    .from('platform_ai_settings')
    .select('*')
    .eq('id', true)
    .single();

  if (aiErr || !aiSettings || !aiSettings.api_key) {
    console.error('Cannot load platform AI settings:', aiErr);
    process.exit(1);
  }

  console.log('Using provider:', aiSettings.provider, 'baseUrl:', aiSettings.base_url);

  const { data: workspaces } = await supabase.from('workspaces').select('id, name');
  console.log(`Found ${workspaces.length} workspaces.`);

  let totalArticles = 0;
  let totalChunks = 0;

  for (const ws of workspaces) {
    const { data: articles } = await supabase
      .from('articles')
      .select('*, section:help_sections(name)')
      .eq('workspace_id', ws.id)
      .eq('status', 'published');

    if (!articles || articles.length === 0) continue;

    console.log(`\nWorkspace "${ws.name}" (${ws.id}): ${articles.length} published articles.`);
    const chunks = [];
    for (const art of articles) {
      const secName = art.section?.name || art.category || 'General';
      const artChunks = splitArticleIntoChunks({ ...art, sectionName: secName });
      chunks.push(...artChunks);
    }

    console.log(`  Generated ${chunks.length} chunks. Generating embeddings...`);
    const texts = chunks.map((c) => c.content);
    const embeddings = await getEmbeddings(texts, aiSettings.api_key, aiSettings.base_url);

    console.log(`  Got ${embeddings.length} embeddings. Storing in database...`);
    await supabase.from('article_chunks').delete().eq('workspace_id', ws.id);

    const rows = chunks.map((c, idx) => ({
      ...c,
      embedding: embeddings[idx],
    }));

    const BATCH = 20;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error: insErr } = await supabase.from('article_chunks').insert(rows.slice(i, i + BATCH));
      if (insErr) {
        console.error(`  Error inserting chunks for ${ws.name}:`, insErr);
        break;
      }
    }
    console.log(`  Successfully indexed ${articles.length} articles, ${chunks.length} chunks for ${ws.name}.`);
    totalArticles += articles.length;
    totalChunks += chunks.length;
  }

  console.log(`\nBackfill complete! Total articles: ${totalArticles}, Total chunks: ${totalChunks}`);
}

run().catch(console.error);
