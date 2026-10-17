import { NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';
import { guardMember } from '@/lib/team/route-guard';
import { clientIpOf } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyVisitorToken } from '@/lib/widget/visitor-token';

// Called by the embeddable widget from the customer's own site.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-zentry-visitor, x-zentry-visitor-token',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function isAuthorized(req: Request): Promise<boolean> {
  const visitorId = req.headers.get('x-zentry-visitor');
  const visitorToken = req.headers.get('x-zentry-visitor-token');

  if (visitorId || visitorToken) {
    if (visitorId && visitorToken) {
      const session = await verifyVisitorToken(visitorId, visitorToken);
      if (session) return true;
    }
    return false;
  }

  const member = await guardMember('view');
  return member.ok;
}

const FOLDER = 'chat_attachments';
// Pictures only; the signature fixes this list, so the browser cannot widen it.
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,gif,bmp,heic,heif,avif';

function credentials(): { cloudName: string; apiKey: string; apiSecret: string } | null {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_URL } = process.env;
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    return { cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET };
  }
  // cloudinary://<key>:<secret>@<cloud>
  const m = CLOUDINARY_URL?.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  return m ? { apiKey: m[1], apiSecret: m[2], cloudName: m[3] } : null;
}

/**
 * A short-lived signature that lets a browser upload one picture straight to
 * Cloudinary. The file never passes through this server, so the 4.5 MB
 * request limit of a Vercel function no longer applies to camera photos.
 * The secret never leaves the server; the signature pins the folder and the
 * allowed formats, and Cloudinary rejects it after an hour.
 */
export async function POST(req: Request) {
  const ip = clientIpOf(req.headers) || 'unknown';
  if (!(await checkRateLimit(`upload_sign:${ip}`, 60, 60))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS_HEADERS });
  }

  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
  }

  const creds = credentials();
  if (!creds) {
    return NextResponse.json({ error: 'Uploads are not configured' }, { status: 503, headers: CORS_HEADERS });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder: FOLDER, allowed_formats: ALLOWED_FORMATS },
    creds.apiSecret
  );

  return NextResponse.json(
    {
      cloudName: creds.cloudName,
      apiKey: creds.apiKey,
      timestamp,
      signature,
      folder: FOLDER,
      allowedFormats: ALLOWED_FORMATS,
    },
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } }
  );
}
