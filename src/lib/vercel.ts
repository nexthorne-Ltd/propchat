/**
 * Registers customer help-centre domains with the hosting project.
 *
 * Pointing DNS at us is only half of it: Vercel will not terminate TLS for a
 * hostname it has never heard of, so the browser is served the default
 * certificate and shows ERR_CERT_COMMON_NAME_INVALID. The domain has to be
 * attached to the project before a certificate can be issued.
 *
 * Intercom's customers only ever add a CNAME because Intercom's own edge does
 * this step invisibly. Calling the API here gives our customers the same
 * one-step experience.
 *
 * Configure with:
 *   VERCEL_API_TOKEN   – a token with access to the project
 *   VERCEL_PROJECT_ID  – the project the help centre is deployed to
 *   VERCEL_TEAM_ID     – only if the project belongs to a team
 *
 * With none of these set every call reports `configured: false`, and the UI
 * falls back to telling the owner to add the domain by hand.
 */

const API = 'https://api.vercel.com';

export interface VercelDomainResult {
  /** False when the platform has no Vercel credentials — not an error. */
  configured: boolean;
  ok: boolean;
  /** True when the domain was already attached; treated as success. */
  alreadyExists?: boolean;
  error?: string;
  code?: string;
  verified?: boolean;
  verification?: Array<{
    type: string;
    domain: string;
    value: string;
    reason: string;
  }>;
}

function credentials() {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  return { token, projectId, teamId, configured: !!(token && projectId) };
}

function withTeam(url: string, teamId?: string) {
  return teamId ? `${url}${url.includes('?') ? '&' : '?'}teamId=${teamId}` : url;
}

/** Attaches a hostname to the project so Vercel will issue a certificate for it. */
export async function addDomainToProject(
  domain: string
): Promise<VercelDomainResult> {
  const { token, projectId, teamId, configured } = credentials();
  if (!configured) return { configured: false, ok: false };

  try {
    const res = await fetch(
      withTeam(`${API}/v10/projects/${projectId}/domains`, teamId),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: domain }),
        signal: AbortSignal.timeout(10000),
      }
    );

    const body = await res.json().catch(() => ({}));

    if (res.ok) {
      return {
        configured: true,
        ok: true,
        verified: !!body?.verified,
        verification: body?.verification || [],
      };
    }

    const code = body?.error?.code;

    // Re-saving the same domain must not read as a failure.
    if (code === 'domain_already_in_use' || code === 'domain_already_exists') {
      const status = await getVercelDomainStatus(domain);
      return {
        configured: true,
        ok: true,
        alreadyExists: true,
        verified: status.verified,
        verification: status.verification || [],
      };
    }

    return {
      configured: true,
      ok: false,
      code,
      error: body?.error?.message || `Vercel returned HTTP ${res.status}`,
      verification: body?.error?.verification || [],
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      configured: true,
      ok: false,
      error: e?.name === 'TimeoutError' ? 'Vercel API timed out' : e?.message,
    };
  }
}

/** Detaches a hostname when the owner removes it, so it can be reused later. */
export async function removeDomainFromProject(
  domain: string
): Promise<VercelDomainResult> {
  const { token, projectId, teamId, configured } = credentials();
  if (!configured) return { configured: false, ok: false };

  try {
    const res = await fetch(
      withTeam(`${API}/v9/projects/${projectId}/domains/${domain}`, teamId),
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      }
    );
    // A domain that is already gone is the state we wanted.
    return { configured: true, ok: res.ok || res.status === 404 };
  } catch (err) {
    const e = err as { message?: string };
    return { configured: true, ok: false, error: e?.message };
  }
}

/** Check verification and status of a domain in Vercel project */
export async function getVercelDomainStatus(domain: string): Promise<{
  configured: boolean;
  verified: boolean;
  misconfigured?: boolean;
  verification?: Array<{
    type: string;
    domain: string;
    value: string;
    reason: string;
  }>;
}> {
  const { token, projectId, teamId, configured } = credentials();
  if (!configured) return { configured: false, verified: false };

  try {
    const res = await fetch(
      withTeam(`${API}/v9/projects/${projectId}/domains/${domain}`, teamId),
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return { configured: true, verified: false };
    const data = await res.json();
    return {
      configured: true,
      verified: !!data.verified,
      misconfigured: !!data.misconfigured,
      verification: data.verification || [],
    };
  } catch {
    return { configured: true, verified: false };
  }
}

/** Triggers Vercel verification check for a domain */
export async function verifyVercelDomain(domain: string): Promise<{
  configured: boolean;
  verified: boolean;
  error?: string;
}> {
  const { token, projectId, teamId, configured } = credentials();
  if (!configured) return { configured: false, verified: false };

  try {
    const res = await fetch(
      withTeam(`${API}/v9/projects/${projectId}/domains/${domain}/verify`, teamId),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    const data = await res.json();
    return {
      configured: true,
      verified: !data.error && !!data.verified,
      error: data.error?.message,
    };
  } catch (err: any) {
    return { configured: true, verified: false, error: err.message };
  }
}

