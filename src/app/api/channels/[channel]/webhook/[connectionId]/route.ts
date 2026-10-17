import { receive, verify } from '../handler';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ channel: string; connectionId: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { channel, connectionId } = await ctx.params;
  if (!UUID.test(connectionId)) return new Response('Unknown connection', { status: 404 });
  return verify(request, channel, connectionId);
}

export async function POST(request: Request, ctx: Ctx) {
  const { channel, connectionId } = await ctx.params;
  if (!UUID.test(connectionId)) return new Response('Unknown connection', { status: 404 });
  return receive(request, channel, connectionId);
}
