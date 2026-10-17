import 'server-only';
import { Vercel } from '@vercel/sdk';
import { userError } from '@/lib/errors/user-error';

export interface VercelVerificationRecord {
  type: string;
  domain: string;
  value: string;
  reason: string;
}

export interface VercelDomainStatusResult {
  verified: boolean;
  verificationRecords: VercelVerificationRecord[];
}

function getVercelClient() {
  const token = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !token.trim()) {
    throw userError('VERCEL_TOKEN environment variable is missing.');
  }
  if (!projectId || !projectId.trim()) {
    throw userError('VERCEL_PROJECT_ID environment variable is missing.');
  }

  const vercel = new Vercel({ bearerToken: token });
  return { vercel, projectId, teamId: teamId || undefined };
}

/**
 * Formats Vercel API errors into plain, human-readable error messages.
 * Handles: domain already in use, rate limited, plan domain limit reached.
 */
export function formatVercelError(err: any): string {
  if (!err) return 'Unknown Vercel API error';
  const status = err.statusCode || err.status;
  const message = (err.message || err.body || String(err)).toLowerCase();
  const code = (err.code || err.errorCode || '').toLowerCase();

  if (
    code.includes('already_in_use') ||
    code.includes('already_exists') ||
    code.includes('domain_taken') ||
    message.includes('already in use') ||
    message.includes('already exists') ||
    message.includes('domain is taken')
  ) {
    return 'domain already in use';
  }

  if (
    status === 429 ||
    code.includes('rate_limited') ||
    code.includes('too_many_requests') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return 'rate limited';
  }

  if (
    code.includes('domain_limit') ||
    code.includes('plan_limit') ||
    message.includes('domain limit') ||
    message.includes('plan limit')
  ) {
    return 'plan domain limit reached';
  }

  if (status === 403 || message.includes('not authorized') || message.includes('invalidtoken')) {
    return 'Vercel API token is invalid or lacks permissions for this project.';
  }

  return err.message || 'Vercel API error';
}

/**
 * addDomain(domain):
 * Calls vercel.projects.addProjectDomain({ idOrName: VERCEL_PROJECT_ID, teamId, requestBody: { name: domain } })
 */
export async function addDomain(domain: string) {
  const { vercel, projectId, teamId } = getVercelClient();
  const clean = domain.trim().toLowerCase();

  try {
    const response = await vercel.projects.addProjectDomain({
      idOrName: projectId,
      teamId,
      requestBody: { name: clean },
    });

    const body = response as any;
    const verified = Boolean(body?.verified);
    const rawVerification = (body?.verification || []) as any[];

    const verificationRecords: VercelVerificationRecord[] = rawVerification.map((v) => ({
      type: v.type || 'TXT',
      domain: v.domain || '',
      value: v.value || '',
      reason: v.reason || 'Domain verification required by Vercel',
    }));

    return {
      success: true,
      verified,
      verificationRecords,
      data: body,
    };
  } catch (err: any) {
    const formattedMessage = formatVercelError(err);
    if (formattedMessage === 'domain already in use') {
      // "In use" is only fine when it is in use by THIS project. After the
      // project moved to another Vercel team/account, every domain still on
      // the old project answered "in use", was reported as attached, and sat
      // in "pending" forever without ever reaching the new project.
      const here = await getProjectDomainOrNull(clean);
      if (!here) throw userError(attachedElsewhereMessage(clean));
      const status = await getDomainStatus(clean);
      return {
        success: true,
        verified: status.verified,
        verificationRecords: status.verificationRecords,
        alreadyExists: true,
      };
    }
    throw userError(formattedMessage);
  }
}

export function attachedElsewhereMessage(domain: string): string {
  return `${domain} is attached to another Vercel project (often the old one after a move). Remove it there (Project → Settings → Domains), then add it again here.`;
}

/** The domain as this project has it, or null when it is not on this project. */
export async function getProjectDomainOrNull(domain: string): Promise<{ name: string; verified: boolean } | null> {
  const { vercel, projectId, teamId } = getVercelClient();
  try {
    const res = (await vercel.projects.getProjectDomain({ idOrName: projectId, domain: domain.trim().toLowerCase(), teamId })) as
      | { name?: string; verified?: boolean }
      | null;
    return res ? { name: String(res.name || domain), verified: Boolean(res.verified) } : null;
  } catch (err: unknown) {
    const e = err as { statusCode?: number; status?: number } | null;
    const status = e?.statusCode || e?.status;
    if (status === 404) return null;
    throw userError(formatVercelError(err));
  }
}

export interface VercelSetupStatus {
  /** Which settings are present (values are never returned). */
  env: { token: boolean; projectId: boolean; teamId: boolean };
  /** The project the app adds domains to, when the token can see it. */
  project: { id: string; name: string } | null;
  /** Domains on that project. */
  domains: { name: string; verified: boolean }[];
  /** Why the project could not be read, in plain words. */
  error: string | null;
}

/**
 * What the app is connected to on Vercel. After moving the project to
 * another team or account, VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID
 * often still point at the old one; this makes that visible. Plain REST so
 * the answer does not depend on SDK method names.
 */
export async function checkVercelSetup(): Promise<VercelSetupStatus> {
  const token = (process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || '').trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || '').trim();
  const teamId = (process.env.VERCEL_TEAM_ID || '').trim();
  const status: VercelSetupStatus = {
    env: { token: Boolean(token), projectId: Boolean(projectId), teamId: Boolean(teamId) },
    project: null,
    domains: [],
    error: null,
  };
  if (!token || !projectId) {
    status.error = !token ? 'VERCEL_TOKEN is not set on this deployment.' : 'VERCEL_PROJECT_ID is not set on this deployment.';
    return status;
  }
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const get = (path: string) =>
    fetch(`https://api.vercel.com${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  try {
    const p = await get(`/v9/projects/${encodeURIComponent(projectId)}${qs}`);
    if (p.status === 401 || p.status === 403) {
      status.error = 'The Vercel token was refused, or it cannot see this project. Create a token in the account/team that now owns the project.';
      return status;
    }
    if (p.status === 404) {
      status.error = teamId
        ? 'No project with VERCEL_PROJECT_ID in the team VERCEL_TEAM_ID. After moving the project, update both to the new project and team.'
        : 'No project with VERCEL_PROJECT_ID for this token. If the project now belongs to a team, set VERCEL_TEAM_ID to that team.';
      return status;
    }
    if (!p.ok) {
      status.error = `Vercel answered ${p.status} when reading the project.`;
      return status;
    }
    const project = (await p.json()) as { id?: string; name?: string };
    status.project = { id: String(project.id || projectId), name: String(project.name || '') };

    const sep = qs ? '&' : '?';
    const d = await get(`/v9/projects/${encodeURIComponent(projectId)}/domains${qs}${sep}limit=100`);
    if (d.ok) {
      const body = (await d.json()) as { domains?: { name: string; verified?: boolean }[] };
      status.domains = (body.domains || []).map((x) => ({ name: x.name, verified: Boolean(x.verified) }));
    } else {
      status.error = `Could not list the project's domains (Vercel answered ${d.status}).`;
    }
  } catch (err: unknown) {
    status.error = `Could not reach Vercel: ${(err as Error)?.message || String(err)}`;
  }
  return status;
}

/**
 * getDomainStatus(domain):
 * Calls projectsGetProjectDomain + projectsVerifyProjectDomain; returns { verified, verificationRecords }
 */
export async function getDomainStatus(domain: string): Promise<VercelDomainStatusResult> {
  const { vercel, projectId, teamId } = getVercelClient();
  const clean = domain.trim().toLowerCase();

  let verified = false;
  let verificationRecords: VercelVerificationRecord[] = [];

  // 1. Get current project domain info via projectsGetProjectDomain
  try {
    const getRes = (await vercel.projects.getProjectDomain({
      idOrName: projectId,
      domain: clean,
      teamId,
    })) as any;

    if (getRes) {
      verified = Boolean(getRes.verified);
      const rawVerification = (getRes.verification || []) as any[];
      verificationRecords = rawVerification.map((v) => ({
        type: v.type || 'TXT',
        domain: v.domain || '',
        value: v.value || '',
        reason: v.reason || 'Domain verification required by Vercel',
      }));
    }
  } catch (err: any) {
    // Domain may not be retrieved yet or requires verification call
  }

  // 2. Call projectsVerifyProjectDomain to verify domain on Vercel
  if (!verified) {
    try {
      const verifyRes = (await vercel.projects.verifyProjectDomain({
        idOrName: projectId,
        domain: clean,
        teamId,
      })) as any;

      if (verifyRes && verifyRes.verified) {
        verified = true;
      }
    } catch {
      // If verify call errors, verified remains false
    }
  }

  return {
    verified,
    verificationRecords,
  };
}

/**
 * removeDomain(domain):
 * Calls vercel.projects.removeProjectDomain({ idOrName: VERCEL_PROJECT_ID, domain, teamId })
 */
export async function removeDomain(domain: string) {
  const { vercel, projectId, teamId } = getVercelClient();
  const clean = domain.trim().toLowerCase();

  try {
    await vercel.projects.removeProjectDomain({
      idOrName: projectId,
      domain: clean,
      teamId,
    });
    return { success: true };
  } catch (err: any) {
    const status = err?.statusCode || err?.status;
    if (status === 404) {
      return { success: true };
    }
    const formattedMessage = formatVercelError(err);
    throw userError(formattedMessage);
  }
}
