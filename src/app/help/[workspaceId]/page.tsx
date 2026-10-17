import { loadHelpSite } from '@/lib/help/data';
import { HelpHome } from '@/components/help/HelpHome';

/**
 * Help center home. Data is read here, on the server and cached
 * (src/lib/help/data.ts), and handed to the interactive page, so the first
 * response already has the collections and articles in it. A failed read
 * throws to error.tsx, which offers a retry.
 */
export default async function HelpCenterPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const site = await loadHelpSite(workspaceId);
  return <HelpHome initial={site} workspaceKey={workspaceId} />;
}
