import { receive, verify } from './handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ channel: string }> }) {
  const { channel } = await ctx.params;
  return verify(request, channel);
}

export async function POST(request: Request, ctx: { params: Promise<{ channel: string }> }) {
  const { channel } = await ctx.params;
  return receive(request, channel);
}
