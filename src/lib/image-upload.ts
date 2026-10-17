/**
 * Getting a picture from a customer's (or agent's) device into the chat.
 *
 * Shared by the embeddable widget, the hosted widget page and the dashboard.
 * No framework or package imports: the embeddable widget bundles this file.
 *
 * Why it exists: phone photos are 3-12 MB, and a request through a Vercel
 * function is capped at 4.5 MB, so camera pictures failed before reaching the
 * upload code. Pictures are now shrunk on the device first and sent straight
 * to Cloudinary with a server-signed request, so their size never passes
 * through our server at all.
 */

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;

/** Some Android galleries and Windows give HEIC files an empty MIME type. */
export function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name || ''));
}

const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.82;

async function decode(file: Blob): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void } | null> {
  // createImageBitmap honours EXIF orientation, so a portrait photo stays upright.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h) };
    } catch {
      // Fall through to <img>, which Safari can use for HEIC.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
    };
  } catch {
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * A smaller JPEG of the picture, or the original when shrinking is not
 * possible or not worth it. GIFs are left alone so they keep animating;
 * small PNGs too, so screenshots and logos keep their transparency.
 */
export async function shrinkImage(file: File): Promise<File> {
  // Decoding or encoding can stall (a backgrounded tab, a huge photo on an old
  // phone). Sending the original late beats never sending anything.
  return Promise.race([
    shrinkImageNow(file),
    new Promise<File>((resolve) => setTimeout(() => resolve(file), 10_000)),
  ]);
}

async function shrinkImageNow(file: File): Promise<File> {
  try {
    const type = (file.type || '').toLowerCase();
    if (type === 'image/gif' || type === 'image/svg+xml') return file;
    if (type === 'image/png' && file.size < 1.5 * 1024 * 1024) return file;
    if (file.size < 400 * 1024 && /jpe?g|webp/.test(type)) return file;

    const decoded = await decode(file);
    if (!decoded || !decoded.width || !decoded.height) return file;

    const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const w = Math.max(1, Math.round(decoded.width * scale));
    const h = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no transparency: paint white first so transparent areas do not turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    decoded.draw(ctx, w, h);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;

    const base = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

interface SignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: string;
}

export interface UploadAuth {
  visitorId?: string | null;
  visitorToken?: string | null;
}

/** Straight to Cloudinary with a signature from our server. */
async function uploadDirect(apiBase: string, file: File, auth?: UploadAuth): Promise<string> {
  const headers: Record<string, string> = {};
  if (auth?.visitorId) headers['x-zentry-visitor'] = auth.visitorId;
  if (auth?.visitorToken) headers['x-zentry-visitor-token'] = auth.visitorToken;

  const signRes = await fetch(`${apiBase}/api/upload/sign`, {
    method: 'POST',
    headers,
  });
  if (!signRes.ok) throw new Error(`sign ${signRes.status}`);
  const s = (await signRes.json()) as SignedUpload;

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', s.apiKey);
  form.append('timestamp', String(s.timestamp));
  form.append('signature', s.signature);
  form.append('folder', s.folder);
  form.append('allowed_formats', s.allowedFormats);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(s.cloudName)}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || `Cloudinary ${res.status}`);
  }
  // A HEIC/HEIF the device could not convert is stored as-is; asking
  // Cloudinary for the .jpg of it makes every browser able to show it.
  return (data.secure_url as string).replace(/\.(heic|heif|avif|bmp|tiff?)$/i, '.jpg');
}

/** Through our own /api/upload: the original route, used as a fallback. */
async function uploadViaServer(apiBase: string, file: File, auth?: UploadAuth): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {};
  if (auth?.visitorId) headers['x-zentry-visitor'] = auth.visitorId;
  if (auth?.visitorToken) headers['x-zentry-visitor-token'] = auth.visitorToken;

  const res = await fetch(`${apiBase}/api/upload`, {
    method: 'POST',
    headers,
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) {
    if (res.status === 413) throw new Error('This picture is too large. Please choose a smaller one.');
    throw new Error(data?.error || `Upload failed (${res.status})`);
  }
  return data.url as string;
}

/**
 * Uploads a picture and returns its public URL. Throws an Error whose message
 * is fit to show the person who picked the file.
 */
export async function uploadChatImage(
  file: File,
  apiBaseOrAuth?: string | UploadAuth,
  maybeAuth?: UploadAuth
): Promise<string> {
  const apiBase = typeof apiBaseOrAuth === 'string' ? apiBaseOrAuth : '';
  const auth = typeof apiBaseOrAuth === 'object' && apiBaseOrAuth !== null ? apiBaseOrAuth : maybeAuth;

  const isImage = looksLikeImage(file);
  const ready = isImage ? await shrinkImage(file) : file;
  // Direct upload is for pictures; documents (agents' PDFs) take the server route.
  if (isImage) {
    try {
      return await uploadDirect(apiBase, ready, auth);
    } catch (directErr) {
      console.warn('[upload] direct upload failed, trying the server route:', directErr);
    }
  }
  try {
    return await uploadViaServer(apiBase, ready, auth);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    throw new Error(
      msg && !/^Upload failed|^sign|^Cloudinary/.test(msg)
        ? msg
        : "Couldn't send the picture. Please check your connection and try again."
    );
  }
}
