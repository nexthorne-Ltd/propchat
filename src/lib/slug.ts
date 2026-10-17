/**
 * Utility to generate clean, URL-safe article and section slugs.
 * Converts to lowercase, strips invalid characters, collapses hyphens,
 * and trims leading/trailing hyphens.
 */
export function generateSlug(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * System keywords that cannot be used as workspace help center subdomain slugs.
 */
export const RESERVED_WORKSPACE_SLUGS = new Set([
  'api',
  'admin',
  'help',
  'support',
  'app',
  'www',
  'auth',
  'login',
  'signup',
  'widget',
  'dashboard',
  'sitemap',
  'assets',
  'static',
  'mail',
  'email',
  'status',
  'kb',
  'docs',
  'billing',
  'settings',
  'zen-try',
  'zentry',
  'zentryhelp',
  'chatify',
  'chatifyhelp',
  'platform',
  'root',
  'test',
  'dev',
]);

/**
 * Normalizes a workspace name or proposed slug into a clean subdomain slug.
 * Lowercase, alphanumeric and single hyphens only, max 48 chars.
 */
export function formatWorkspaceSlug(input: string): string {
  if (!input) return '';
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Validates whether a proposed workspace slug is compliant and not reserved.
 */
export function validateWorkspaceSlug(rawSlug: string): {
  valid: boolean;
  error?: string;
  formattedSlug: string;
} {
  const trimmed = (rawSlug || '').trim().toLowerCase();

  if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
    return {
      valid: false,
      error: 'Slug cannot start or end with a hyphen.',
      formattedSlug: formatWorkspaceSlug(rawSlug),
    };
  }

  if (trimmed.includes('--')) {
    return {
      valid: false,
      error: 'Slug cannot contain consecutive hyphens.',
      formattedSlug: formatWorkspaceSlug(rawSlug),
    };
  }

  const formattedSlug = formatWorkspaceSlug(rawSlug);

  if (!formattedSlug || formattedSlug.length < 2) {
    return {
      valid: false,
      error: 'Slug must be at least 2 characters long.',
      formattedSlug,
    };
  }

  if (formattedSlug.length > 48) {
    return {
      valid: false,
      error: 'Slug cannot exceed 48 characters.',
      formattedSlug,
    };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formattedSlug)) {
    return {
      valid: false,
      error: 'Slug can only contain lowercase letters, numbers, and hyphens.',
      formattedSlug,
    };
  }

  if (RESERVED_WORKSPACE_SLUGS.has(formattedSlug)) {
    return {
      valid: false,
      error: `"${formattedSlug}" is a reserved system keyword. Please choose another slug.`,
      formattedSlug,
    };
  }

  return { valid: true, formattedSlug };
}

/**
 * Generates a clean, unique workspace slug from a workspace name.
 * Queries Supabase to guarantee uniqueness (e.g. acme, acme-2, acme-3).
 */
export async function generateUniqueWorkspaceSlug(
  supabase: any,
  name: string,
  excludeWorkspaceId?: string
): Promise<string> {
  let baseSlug = formatWorkspaceSlug(name);
  if (!baseSlug || RESERVED_WORKSPACE_SLUGS.has(baseSlug)) {
    baseSlug = baseSlug ? `${baseSlug}-kb` : 'workspace';
  }

  // Check if baseSlug exists
  // public_workspaces, not workspaces: row level security hides other tenants'
  // rows, and uniqueness has to be checked against all of them.
  let query = supabase
    .from('public_workspaces')
    .select('id, slug')
    .ilike('slug', `${baseSlug}%`);

  if (excludeWorkspaceId) {
    query = query.neq('id', excludeWorkspaceId);
  }

  const { data: existing } = await query;
  const takenSlugs = new Set(
    (existing || []).map((row: { slug?: string | null }) => (row.slug || '').toLowerCase())
  );

  if (!takenSlugs.has(baseSlug)) {
    return baseSlug;
  }

  let counter = 2;
  while (takenSlugs.has(`${baseSlug}-${counter}`)) {
    counter++;
  }

  return `${baseSlug}-${counter}`;
}
