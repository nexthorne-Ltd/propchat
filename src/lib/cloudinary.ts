import { v2 as cloudinary } from 'cloudinary';
import { userError } from '@/lib/errors/user-error';

/**
 * Checks whether Cloudinary credentials have been provided either via
 * separate environment variables or through the single CLOUDINARY_URL string.
 */
export function isCloudinaryConfigured(): boolean {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const cloudinaryUrl = process.env.CLOUDINARY_URL;

  return Boolean(
    (cloudName && apiKey && apiSecret) ||
    (cloudinaryUrl && cloudinaryUrl.startsWith('cloudinary://'))
  );
}

// Configure Cloudinary SDK instance
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else if (process.env.CLOUDINARY_URL) {
  cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL,
    secure: true,
  });
}

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  format: string;
  bytes: number;
  resource_type: string;
  width?: number;
  height?: number;
}

/**
 * Uploads a raw buffer directly to Cloudinary using a stream.
 * Bypasses local disk storage and Supabase storage completely.
 */
export async function uploadToCloudinary(
  buffer: Buffer,
  options: {
    folder?: string;
    filename?: string;
    resourceType?: 'image' | 'raw' | 'auto';
  } = {}
): Promise<CloudinaryUploadResult> {
  if (!isCloudinaryConfigured()) {
    throw userError(
      'Cloudinary credentials are not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET (or CLOUDINARY_URL) in your .env.local file.'
    );
  }

  // Ensure config is fresh in case env vars were loaded dynamically
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else if (process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloudinary_url: process.env.CLOUDINARY_URL,
      secure: true,
    });
  }

  const { folder = 'chat_uploads', filename, resourceType = 'auto' } = options;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: Boolean(filename),
        unique_filename: true,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Failed to upload image to Cloudinary'));
        } else {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
            format: result.format,
            bytes: result.bytes,
            resource_type: result.resource_type,
            width: result.width,
            height: result.height,
          });
        }
      }
    );

    uploadStream.end(buffer);
  });
}

export { cloudinary };
