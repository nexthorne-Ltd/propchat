import fs from 'fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
const img = PNG.sync.read(buf);
const { width, height, data } = img;

console.log(`Image size: ${width}x${height}`);

// Sample background at (10, 10)
const p0 = (10 * width + 10) * 4;
console.log('Top-left color:', data[p0], data[p0+1], data[p0+2], data[p0+3]);

// Sample bottom-left at (10, 450)
const p1 = (450 * width + 10) * 4;
console.log('Bottom-left color:', data[p1], data[p1+1], data[p1+2], data[p1+3]);

// Sample bottom-center at (512, 450)
const p2 = (450 * width + 512) * 4;
console.log('Bottom-center color:', data[p2], data[p2+1], data[p2+2], data[p2+3]);

// Sample bottom-right at (900, 450)
const p3 = (450 * width + 900) * 4;
console.log('Bottom-right color:', data[p3], data[p3+1], data[p3+2], data[p3+3]);

// Find bounding box of non-white pixels in top half (y < 300)
// White background threshold: r > 245, g > 245, b > 245
let minX = width, maxX = 0, minY = height, maxY = 0;
// Also find mark vs text in top half
let markMinX = width, markMaxX = 0, markMinY = height, markMaxY = 0;
let textMinX = width, textMaxX = 0, textMinY = height, textMaxY = 0;

for (let y = 10; y < 300; y++) {
  for (let x = 10; x < width - 10; x++) {
    const idx = (y * width + x) * 4;
    const r = data[idx], g = data[idx+1], b = data[idx+2];
    const isWhite = r > 245 && g > 245 && b > 245;
    if (!isWhite) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Mark is roughly in the left portion (x < 380)
      if (x < 380) {
        if (x < markMinX) markMinX = x;
        if (x > markMaxX) markMaxX = x;
        if (y < markMinY) markMinY = y;
        if (y > markMaxY) markMaxY = y;
      } else {
        if (x < textMinX) textMinX = x;
        if (x > textMaxX) textMaxX = x;
        if (y < textMinY) textMinY = y;
        if (y > textMaxY) textMaxY = y;
      }
    }
  }
}

console.log('Top Full Lockup bounding box:', { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY });
console.log('Top Mark bounding box:', { markMinX, markMaxX, markMinY, markMaxY, width: markMaxX - markMinX, height: markMaxY - markMinY });
console.log('Top Text bounding box:', { textMinX, textMaxX, textMinY, textMaxY, width: textMaxX - textMinX, height: textMaxY - textMinY });
