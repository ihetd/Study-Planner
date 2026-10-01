// Cloudflare Worker: returns the PDF/document name behind a PUBLIC Telegram post link.
// Deploy: dash.cloudflare.com → Workers → Create → paste this → Deploy,
// then put the worker URL in PDF_WORKER_URL inside index.html.
// Private channels (t.me/c/...) cannot be read this way.
const ALLOWED_ORIGIN = '*'; // e.g. 'https://ihetd.github.io' to lock it down

export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

    const link = new URL(req.url).searchParams.get('url') || '';
    const m = link.match(/^https?:\/\/(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/(\d+)/);
    if (!m) return json({ error: 'Only public t.me/<channel>/<post> links are supported' }, 400);

    const res = await fetch(`https://t.me/${m[1]}/${m[2]}?embed=1&mode=tme`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!res.ok) return json({ error: 'Telegram returned ' + res.status }, 502);
    const html = await res.text();

    const pick = re => {
      const x = html.match(re);
      return x ? decode(x[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim() : '';
    };
    return json({
      title: pick(/tgme_widget_message_document_title[^>]*>([\s\S]*?)<\/div>/),
      text: pick(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/),
      channel: m[1],
      post: m[2]
    });
  }
};

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
