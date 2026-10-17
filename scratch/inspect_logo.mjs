import fs from 'fs';
import { PNG } from 'pngjs';

function inspect() {
  const newImgBuf = fs.readFileSync('C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png');
  const newImg = PNG.sync.read(newImgBuf);
  console.log('New image dimensions:', newImg.width, 'x', newImg.height);

  const logoBuf = fs.readFileSync('public/logo.png');
  const logo = PNG.sync.read(logoBuf);
  console.log('Old public/logo.png dimensions:', logo.width, 'x', logo.height);

  const chatIconBuf = fs.readFileSync('public/chat-icon.png');
  const chatIcon = PNG.sync.read(chatIconBuf);
  console.log('Old public/chat-icon.png dimensions:', chatIcon.width, 'x', chatIcon.height);

  if (fs.existsSync('public/favicon.png')) {
    const favBuf = fs.readFileSync('public/favicon.png');
    const fav = PNG.sync.read(favBuf);
    console.log('Old public/favicon.png dimensions:', fav.width, 'x', fav.height);
  }
}

inspect();
