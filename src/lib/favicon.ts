'use client';

let originalTitle = '';
let baseIconImage: HTMLImageElement | null = null;

function getOriginalTitle(): string {
  if (typeof document === 'undefined') return '';
  if (!originalTitle) {
    originalTitle = document.title.replace(/^\(\d+\+?\)\s*/, '') || 'Zen-try';
  }
  return originalTitle;
}

function getFaviconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

/**
 * Updates the browser favicon with a dynamic badge count overlay
 * and sets the document title prefix e.g. "(3) Zen-try - Inbox".
 */
export function updateFaviconBadge(unreadCount: number) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const title = getOriginalTitle();
  const link = getFaviconLink();
  if (!link) return;

  // 1. Update document title
  if (unreadCount > 0) {
    const badgeText = unreadCount > 99 ? '99+' : `${unreadCount}`;
    document.title = `(${badgeText}) ${title}`;
  } else {
    document.title = title;
  }

  // 2. If no unread, restore standard icon
  if (unreadCount <= 0) {
    link.href = '/chat-icon.png';
    return;
  }

  // 3. Draw badge on 32x32 canvas
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const renderBadge = (img: HTMLImageElement) => {
    ctx.clearRect(0, 0, 32, 32);
    // Draw base icon
    ctx.drawImage(img, 0, 0, 32, 32);

    // Draw notification badge circle in top-right
    const badgeText = unreadCount > 9 ? '9+' : `${unreadCount}`;
    const radius = 9;
    const x = 23;
    const y = 9;

    // Outer white stroke
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Red notification circle
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = '#ef4444';
    ctx.fill();

    // Text count
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, x, y + 0.5);

    link.href = canvas.toDataURL('image/png');
  };

  if (baseIconImage && baseIconImage.complete) {
    renderBadge(baseIconImage);
  } else {
    const img = new Image();
    img.src = '/chat-icon.png';
    img.onload = () => {
      baseIconImage = img;
      renderBadge(img);
    };
    img.onerror = () => {
      // Fallback: draw purely circle if icon image fails to load
      ctx.clearRect(0, 0, 32, 32);
      ctx.beginPath();
      ctx.arc(16, 16, 14, 0, 2 * Math.PI);
      ctx.fillStyle = '#2563eb';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(24, 8, 8, 0, 2 * Math.PI);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(unreadCount > 9 ? '9+' : `${unreadCount}`, 24, 8);
      link.href = canvas.toDataURL('image/png');
    };
  }
}
