import fs from 'fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
const master = PNG.sync.read(buf);

// Find elements in bottom-left: x: 0..400, y: 300..512
// Dark background is ~ rgb(13, 19, 44)
let darkMinX = master.width, darkMaxX = 0, darkMinY = master.height, darkMaxY = 0;
for (let y = 320; y < 490; y++) {
  for (let x = 30; x < 380; x++) {
    const p = (y * master.width + x) * 4;
    const r = master.data[p], g = master.data[p+1], b = master.data[p+2];
    // Check if pixel is significantly brighter than background (r > 50 or g > 50 or b > 90)
    if (r > 50 || g > 50 || b > 90) {
      if (x < darkMinX) darkMinX = x;
      if (x > darkMaxX) darkMaxX = x;
      if (y < darkMinY) darkMinY = y;
      if (y > darkMaxY) darkMaxY = y;
    }
  }
}

console.log('Dark mode lockup bounds:', { darkMinX, darkMaxX, darkMinY, darkMaxY, w: darkMaxX - darkMinX + 1, h: darkMaxY - darkMinY + 1 });
