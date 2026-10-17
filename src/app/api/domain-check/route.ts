import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/**
 * Answers "is this hostname actually reaching this app, and which workspace
 * does it resolve to?"
 *
 * Domain verification used to pass on DNS records alone. That is not enough on
 * a platform like Vercel: the domain must also be attached to the project, or
 * the edge returns its own 404 and our middleware never runs. DNS could look
 * perfect while the help centre was unreachable, and the UI would still say
 * "verified".
 *
 * Verification now calls this endpoint over the public internet on the
 * customer's own hostname. A correct answer here means the whole chain works —
 * DNS, TLS, the hosting project, and the middleware rewrite.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const host =
    request.headers.get('x-forwarded-host')?.toLowerCase().split(':')[0] ||
    request.headers.get('host')?.toLowerCase().split(':')[0] ||
    '';

  if (!host) {
    return NextResponse.json({ ok: false, reason: 'no_host' }, { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: ws } = await supabase
    .from('public_workspaces')
    .select('id, slug, custom_domain')
    .ilike('custom_domain', host)
    .maybeSingle();

  return NextResponse.json({
    ok: !!ws,
    app: 'zentry',
    host,
    workspaceId: ws?.id ?? null,
    slug: ws?.slug ?? null,
  });
}
