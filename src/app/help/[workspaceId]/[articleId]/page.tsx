import { getHelpArticle, getHelpSite, resolveHelpWorkspaceId } from '@/lib/help/data';
import { HelpArticle, type HelpArticleInitial } from '@/components/help/HelpArticle';

/**
 * One help article, read on the server and cached with its workspace, design
 * and collection (src/lib/help/data.ts). The site and the article are read in
 * parallel; on a warm cache neither touches the database. A failed read
 * throws to error.tsx, which offers a retry.
 */
async function load(workspaceKey: string, articleKey: string): Promise<HelpArticleInitial | null> {
  const id = await resolveHelpWorkspaceId(workspaceKey);
  if (!id) return null;
  const [site, page] = await Promise.all([getHelpSite(id), getHelpArticle(id, articleKey)]);
  return site ? { workspace: site.workspace, theme: site.theme, page } : null;
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ workspaceId: string; articleId: string }>;
}) {
  const { workspaceId, articleId } = await params;
  const initial = await load(workspaceId, articleId);
  return <HelpArticle initial={initial} workspaceKey={workspaceId} />;
}
