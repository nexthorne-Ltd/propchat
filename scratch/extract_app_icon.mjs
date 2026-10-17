import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const MASTER_PATH = 'C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png';
const PUBLIC_DIR = path.resolve('public');

const masterBuf = fs.readFileSync(MASTER_PATH);
const master = PNG.sync.read(masterBuf);

// Crop squircle app icon
// x: 462, y: 336, w: 128, h: 135
const appCrop = new PNG({ width: 128, height: 135 });
for (let y = 0; y < 135; y++) {
  for (let x = 0; x < 128; x++) {
    const srcIdx = ((336 + y) * master.width + (462 + x)) * 4;
    const dstIdx = (y * 128 + x) * 4;
    appCrop.data[dstIdx] = master.data[srcIdx];
    appCrop.data[dstIdx + 1] = master.data[srcIdx + 1];
    appCrop.data[dstIdx + 2] = master.data[srcIdx + 2];
    appCrop.data[dstIdx + 3] = master.data[srcIdx + 3];
  }
}

fs.writeFileSync(path.join(PUBLIC_DIR, 'logo-app.png'), PNG.sync.write(appCrop));
console.log('✓ Wrote public/logo-app.png (128x135)');
