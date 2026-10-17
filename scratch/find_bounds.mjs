import fs from 'fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
const img = PNG.sync.read(buf);
const { width, height, data } = img;

// Find all elements with alpha > 10 for y < 300
let markMinX = width, markMaxX = 0, markMinY = height, markMaxY = 0;
let textMinX = width, textMaxX = 0, textMinY = height, textMaxY = 0;
let fullMinX = width, fullMaxX = 0, fullMinY = height, fullMaxY = 0;

for (let y = 0; y < 300; y++) {
  for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const a = data[p + 3];
    if (a > 10) {
      if (x < fullMinX) fullMinX = x;
      if (x > fullMaxX) fullMaxX = x;
      if (y < fullMinY) fullMinY = y;
      if (y > fullMaxY) fullMaxY = y;

      if (x < 380) { // Mark
        if (x < markMinX) markMinX = x;
        if (x > markMaxX) markMaxX = x;
        if (y < markMinY) markMinY = y;
        if (y > markMaxY) markMaxY = y;
      } else { // Text
        if (x < textMinX) textMinX = x;
        if (x > textMaxX) textMaxX = x;
        if (y < textMinY) textMinY = y;
        if (y > textMaxY) textMaxY = y;
      }
    }
  }
}

console.log('Mark bounds:', { markMinX, markMaxX, markMinY, markMaxY, w: markMaxX - markMinX + 1, h: markMaxY - markMinY + 1 });
console.log('Text bounds:', { textMinX, textMaxX, textMinY, textMaxY, w: textMaxX - textMinX + 1, h: textMaxY - textMinY + 1 });
console.log('Full Lockup bounds:', { fullMinX, fullMaxX, fullMinY, fullMaxY, w: fullMaxX - fullMinX + 1, h: fullMaxY - fullMinY + 1 });
