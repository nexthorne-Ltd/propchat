import fs from 'fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
const img = PNG.sync.read(buf);
const { width, height, data } = img;

// Let's sample colors in bottom right (x > 640, y > 300)
// Background around x=900, y=320
const pBg = (320 * width + 900) * 4;
console.log('Bottom right bg:', data[pBg], data[pBg+1], data[pBg+2], data[pBg+3]);

// Let's check the favicon icon in bottom right (under label "Favicon")
// Search for mark in x: 880..980, y: 330..450
let favMinX = width, favMaxX = 0, favMinY = height, favMaxY = 0;
for (let y = 330; y < 450; y++) {
  for (let x = 880; x < 980; x++) {
    const p = (y * width + x) * 4;
    // Check if not white/light-gray
    const r = data[p], g = data[p+1], b = data[p+2];
    if (r < 220 || g < 220 || b < 220) {
      if (x < favMinX) favMinX = x;
      if (x > favMaxX) favMaxX = x;
      if (y < favMinY) favMinY = y;
      if (y > favMaxY) favMaxY = y;
    }
  }
}
console.log('Bottom-right favicon mark bounds:', { favMinX, favMaxX, favMinY, favMaxY, w: favMaxX - favMinX + 1, h: favMaxY - favMinY + 1 });

// Also check the squircle app icon in bottom center (x: 420..600, y: 320..480)
let appMinX = width, appMaxX = 0, appMinY = height, appMaxY = 0;
for (let y = 320; y < 480; y++) {
  for (let x = 430; x < 590; x++) {
    const p = (y * width + x) * 4;
    const r = data[p], g = data[p+1], b = data[p+2];
    if (r < 230 || g < 230 || b < 230) {
      if (x < appMinX) appMinX = x;
      if (x > appMaxX) appMaxX = x;
      if (y < appMinY) appMinY = y;
      if (y > appMaxY) appMaxY = y;
    }
  }
}
console.log('App squircle icon bounds:', { appMinX, appMaxX, appMinY, appMaxY, w: appMaxX - appMinX + 1, h: appMaxY - appMinY + 1 });
