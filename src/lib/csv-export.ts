import { CompanyMetricItem } from '@/app/actions/platform';

/**
 * Escapes a cell value according to RFC-4180
 */
function escapeCsvCell(cell: any): string {
  if (cell === null || cell === undefined) return '""';
  const str = String(cell);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Generates an RFC-4180 compliant CSV string from companies data and triggers browser download
 */
export function exportCompaniesToCsv(companies: CompanyMetricItem[]): void {
  const headers = [
    'ID',
    'Company Name',
    'Website / Domain',
    'Plan',
    'Status',
    'Owner Email',
    'Created At',
    'Last Activity At',
    'Health Flags',
    'Conversations Count',
    'Open Conversations',
    'Closed Conversations',
    'Messages Count',
    'Visitors Count',
    'Active Visitors (Browsing Now)',
    'Support Agents (Seats)',
    'Published Articles',
    'Total Articles',
    'Article Views',
    'CSAT Score (1-5)',
    'CSAT Ratings Count',
    'Unanswered >24h Count',
    'Knowledge Gaps Count',
    'Widget Installed',
    'AI Enabled',
  ];

  const rows = companies.map((c) => {
    let status = 'Active';
    if (c.deleted_at) status = 'Deleted (Trash)';
    else if (c.is_suspended) status = 'Suspended';

    return [
      escapeCsvCell(c.id),
      escapeCsvCell(c.name),
      escapeCsvCell(c.website_url || ''),
      escapeCsvCell(c.plan || 'free'),
      escapeCsvCell(status),
      escapeCsvCell(c.owner_email || ''),
      escapeCsvCell(c.created_at ? new Date(c.created_at).toISOString() : ''),
      escapeCsvCell(c.last_activity_at ? new Date(c.last_activity_at).toISOString() : ''),
      escapeCsvCell((c.health_flags || []).join('; ')),
      escapeCsvCell(c.conversations_count ?? 0),
      escapeCsvCell(c.open_conversations_count ?? 0),
      escapeCsvCell(c.closed_conversations_count ?? 0),
      escapeCsvCell(c.messages_count ?? 0),
      escapeCsvCell(c.visitors_count ?? 0),
      escapeCsvCell(c.active_visitors_count ?? 0),
      escapeCsvCell(c.agents_count ?? 0),
      escapeCsvCell(c.published_articles_count ?? 0),
      escapeCsvCell(c.articles_count ?? 0),
      escapeCsvCell(c.total_article_views ?? 0),
      escapeCsvCell(
        c.csat_score !== null && c.csat_score !== undefined
          ? Number(c.csat_score).toFixed(1)
          : ''
      ),
      escapeCsvCell(c.csat_count ?? 0),
      escapeCsvCell(c.unanswered_older_24h_count ?? 0),
      escapeCsvCell(c.knowledge_gaps_count ?? 0),
      escapeCsvCell(c.widget_installed ? 'Yes' : 'No'),
      escapeCsvCell(c.ai_enabled ? 'Yes' : 'No'),
    ].join(',');
  });

  // Prepend UTF-8 BOM so Excel and spreadsheet apps preserve special characters properly
  const csvContent = '\uFEFF' + [headers.map(escapeCsvCell).join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  link.download = `platform_companies_export_${dateStr}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
