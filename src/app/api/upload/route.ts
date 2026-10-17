import { NextRequest, NextResponse } from 'next/server';
import { uploadToCloudinary, isCloudinaryConfigured } from '@/lib/cloudinary';
import { guardMember } from '@/lib/team/route-guard';
import { clientIpOf } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyVisitorToken } from '@/lib/widget/visitor-token';

// Allowed MIME types: images and standard documents
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/avif',
  'application/pdf',
  'text/plain',
]);

/** Some phones send a photo with no MIME type (often HEIC); go by the name. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain',
};

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-zentry-visitor, x-zentry-visitor-token',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
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

export async function POST(req: NextRequest) {
  try {
    const ip = clientIpOf(req.headers) || 'unknown';
    if (!(await checkRateLimit(`upload:${ip}`, 60, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS_HEADERS });
    }

    if (!(await isAuthorized(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file uploaded' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File size exceeds maximum 15MB limit' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
    const mimeType = file.type || TYPE_BY_EXTENSION[ext] || '';
    if (!ALLOWED_TYPES.has(mimeType)) {
      return NextResponse.json(
        { error: `File type ${mimeType || 'unknown'} not permitted. Supported: images, PDF, and TXT.` },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!isCloudinaryConfigured()) {
      return NextResponse.json(
        {
          error:
            'Cloudinary credentials are not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET (or CLOUDINARY_URL) in your .env.local file.',
        },
        { status: 503, headers: CORS_HEADERS }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const isImage = mimeType.startsWith('image/');
    const result = await uploadToCloudinary(buffer, {
      folder: 'chat_attachments',
      filename: file.name,
      resourceType: isImage ? 'image' : 'auto',
    });

    return NextResponse.json(
      {
        // HEIC is stored as-is; the .jpg URL makes Cloudinary deliver it as JPEG.
        url: isImage ? result.secure_url.replace(/\.(heic|heif|avif|bmp|tiff?)$/i, '.jpg') : result.secure_url,
        publicId: result.public_id,
        filename: file.name,
        size: result.bytes || file.size,
        mimeType,
        isImage,
        width: result.width,
        height: result.height,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    console.error('[Upload API Error]:', error);
    return NextResponse.json(
      { error: error.message || 'File upload failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
