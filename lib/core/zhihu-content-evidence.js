// Stable reading evidence: compare authored content, not rotating CDN routing
// or presentational HTML. This module only parses strings; it never fetches URLs.
export function decodeEntities(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? all;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
export function htmlText(html) {
  const text = String(html || '').replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:[^<>"']|"[^"]*"|'[^']*')*>/g, tag => {
      if (/^<img\b/i.test(tag)) return '[图片]';
      if (/^<br\b|^<\/(?:p|div|h[1-6]|li|blockquote|pre|tr)\s*>/i.test(tag)) return '\n';
      return '';
    });
  return decodeEntities(text).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stableUrl(value) {
  const raw = decodeEntities(value).trim();
  try {
    const u = new URL(raw, 'https://www.zhihu.com/');
    // Zhihu routes the SAME hashed picture through pic1/pica/picx, etc.
    // Only hashed image paths on these known CDN aliases share an identity.
    const picture = u.protocol === 'https:' && !u.port && !u.username && !u.password && /^pic[a-z0-9-]*\.zhimg\.com$/.test(u.hostname)
      && /\/(?:v2-)[a-f0-9]{32}[^/]*\.(?:jpe?g|png|webp|gif|avif)$/i.test(u.pathname);
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || picture && key === 'source') u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return picture ? 'zhimg-picture:' + u.pathname + u.search + u.hash : u.href;
  } catch { return raw; }
}
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4]);
  }
  return out;
}
export function answerEvidence(body) {
  const html = String(body.content || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const media = [], links = [], seenMedia = new Set(), seenLinks = new Set();
  // Quoted attributes can contain literal > (including SVG data placeholders).
  for (const match of html.matchAll(/<(?:[^<>"']|"[^"]*"|'[^']*')*>/g)) {
    const name = match[0].match(/^<([\w:-]+)\b/)?.[1]?.toLowerCase();
    if (!name) continue;
    const attrs = attributes(match[0]);
    if (name === 'a' && attrs.href) {
      const link = stableUrl(attrs.href);
      if (!seenLinks.has(link)) { seenLinks.add(link); links.push(link); }
    }
    if (!['img', 'video', 'audio', 'source', 'iframe', 'embed', 'object'].includes(name)) continue;
    let urls = ['src', 'data-src', 'data-original', 'data-actualsrc', 'poster', 'data'].map(k => attrs[k]).filter(Boolean).map(stableUrl);
    if (attrs.srcset) urls.push(...attrs.srcset.split(/,\s*(?=(?:https?:|\/))/).map(x => { const [url, ...descriptor] = x.trim().split(/\s+/); return stableUrl(url) + ' ' + descriptor.join(' '); }));
    // A lazy-load SVG is presentation when the actual source is also present.
    if (urls.some(url => !url.startsWith('data:'))) urls = urls.filter(url => !url.startsWith('data:'));
    const item = { tag: name, urls: [...new Set(urls)].sort(), alt: attrs.alt || '', title: attrs.title || '',
      token: attrs['data-original-token'] || '', videoId: attrs['data-video-id'] || attrs['data-lens-id'] || '' };
    const key = JSON.stringify(item);
    if (!seenMedia.has(key)) { seenMedia.add(key); media.push(item); }
  }
  const updated = Number(body.updated_time);
  return JSON.stringify({ version: 1, text: htmlText(body.content), title: htmlText(body.question?.title),
    updatedTime: Number.isSafeInteger(updated) && updated > 0 ? updated : null, media, links });
}
