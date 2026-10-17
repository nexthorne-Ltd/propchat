import { NextResponse, type NextRequest } from 'next/server';
import { acceptInvitationAction } from '@/app/actions/invite';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : undefined;

    if (!token) {
      return NextResponse.json({ success: false, error: 'Invitation token is missing.' }, { status: 400 });
    }

    const result = await acceptInvitationAction({ token, name, password });
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error('[API /api/invite/accept] Unexpected error:', err);
    const message = err instanceof Error ? err.message : 'Could not accept invitation. Please try again.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
