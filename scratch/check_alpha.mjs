import fs from 'fs';
import { PNG } from 'pngjs';

const buf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
const img = PNG.sync.read(buf);
const { width, height, data } = img;

// Sample along the top half
const samples = [
  [0, 0], [10, 10], [50, 50], [100, 100], [200, 100], [250, 150], [500, 50], [700, 50]
];

for (const [x, y] of samples) {
  const p = (y * width + x) * 4;
  console.log(`(${x}, ${y}): rgba(${data[p]}, ${data[p+1]}, ${data[p+2]}, ${data[p+3]})`);
}
