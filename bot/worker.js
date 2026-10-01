// Study Planner Telegram bot (Cloudflare Worker + D1).
//
// The bot is an admin of the batch channel, so Telegram sends it every post:
//   • a lecture PDF  → its file name is saved under the post's link (t.me/<channel>/<id> or t.me/c/<id>/<id>)
//   • the daily schedule ("Group A1 / Group A2 …") → saved with its hidden lecture links as [[url]] markers
// The app reads GET /inbox, imports new schedules and fills each lecture's name from its link.
//
// Endpoints:  POST /telegram  (Telegram webhook, checked with a secret header)
//             GET  /setup     (registers the webhook; safe to open again)
//             GET  /inbox     (names + recent schedules for the app)
// Secrets:    BOT_TOKEN (from @BotFather), set with `npx wrangler secret put BOT_TOKEN`.

const ALLOWED_ORIGIN = 'https://ihetd.github.io';   // where the app lives (ALLOWED_ORIGIN var overrides it for local testing)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || ALLOWED_ORIGIN, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });
    if (!env.BOT_TOKEN) return json({ error: 'BOT_TOKEN secret is not set yet' }, 500);
    await schema(env);
    const secret = await hookSecret(env.BOT_TOKEN);

    if (url.pathname === '/telegram' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return new Response('forbidden', { status: 403 });
      try { await handle(await req.json(), env); } catch (e) { console.log('update failed', e && e.message); }
      return new Response('ok');   // always 200, or Telegram keeps retrying the same update
    }
    if (url.pathname === '/setup') {
      const hook = await tg(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: secret, allowed_updates: ['channel_post', 'edited_channel_post', 'message'] });
      const me = await tg(env, 'getMe', {});
      return json({ webhook: hook.ok ? 'connected' : hook, bot: me.result ? '@' + me.result.username : me });
    }
    if (url.pathname === '/inbox') {
      const names = {}, schedules = [];
      (await env.DB.prepare('SELECT key, name FROM names').all()).results.forEach(r => { names[r.key] = r.name; });
      (await env.DB.prepare('SELECT id, text, at FROM schedules ORDER BY at DESC LIMIT 10').all()).results.forEach(r => schedules.push(r));
      return json({ names, schedules });
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    return json({ ok: true, hint: 'Study Planner bot. Open /setup once after deploying.' });
  }
};

async function handle(u, env) {
  const m = u.channel_post || u.edited_channel_post || u.message;
  if (!m || !m.chat) return;
  const now = Date.now(), db = env.DB;
  let keys = [];
  if (m.chat.type === 'channel') {
    // remember the channel, so forwards from it can be trusted later
    for (const c of chatKeys(m.chat)) await db.prepare('INSERT OR IGNORE INTO chats (key) VALUES (?)').bind(c).run();
    keys = chatKeys(m.chat).map(c => `${c}/${m.message_id}`);
  } else if (m.chat.type === 'private' && m.forward_origin && m.forward_origin.type === 'channel') {
    // an older post forwarded to the bot by hand: only from a channel the bot is admin of
    const origin = chatKeys(m.forward_origin.chat);
    // trusted: a channel the bot is admin of, or a public channel the schedule's lecture links point to
    const known = await db.prepare(`SELECT 1 FROM chats WHERE key IN (${origin.map(() => '?').join(',')})`).bind(...origin).first()
      || (m.forward_origin.chat.username && await db.prepare('SELECT 1 FROM schedules WHERE lower(text) LIKE ?').bind(`%t.me/${m.forward_origin.chat.username.toLowerCase()}/%`).first());
    if (!known) return reply(env, m, 'I only read lecture posts from the batch channels.');
    keys = origin.map(c => `${c}/${m.forward_origin.message_id}`);
  } else return;

  const text = m.text || m.caption || '';
  const name = (m.document && cleanName(m.document.file_name)) || '';
  if (name) for (const k of keys) await db.prepare('INSERT OR REPLACE INTO names (key, name, at) VALUES (?, ?, ?)').bind(k, name, now).run();
  if (/Group\s*A\s*[12]/i.test(text)) {
    const withLinks = inlineLinks(text, m.entities || m.caption_entities || []);
    await db.prepare('INSERT OR REPLACE INTO schedules (id, text, at) VALUES (?, ?, ?)').bind(keys[0], withLinks, now).run();
    await db.prepare('DELETE FROM schedules WHERE at < ?').bind(now - 30 * 864e5).run();
  }
  if (m.chat.type === 'private') await reply(env, m, name ? `Saved: ${name} ✔` : 'Nothing to save in that post.');
}

// t.me link forms for a chat: public username and the private "c/<id>" form.
function chatKeys(chat) {
  const out = [];
  if (chat.username) out.push(chat.username.toLowerCase());
  const id = String(chat.id);
  if (id.startsWith('-100')) out.push('c/' + id.slice(4));
  return out;
}
const cleanName = f => String(f || '').replace(/\.(pdf|pptx?|docx?)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
// Hidden links ("🔗 رابط المحاضرة") become visible [[url]] markers, which the app's parser reads.
function inlineLinks(text, entities) {
  let out = text;
  entities.filter(e => e.type === 'text_link' && /^https?:/i.test(e.url)).sort((a, b) => b.offset - a.offset)
    .forEach(e => { const end = e.offset + e.length; out = out.slice(0, end) + ` [[${e.url}]]` + out.slice(end); });
  return out;
}
async function hookSecret(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sp-hook:' + token));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const reply = (env, m, text) => tg(env, 'sendMessage', { chat_id: m.chat.id, text, reply_to_message_id: m.message_id });
let ready = false;
async function schema(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS names (key TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS chats (key TEXT PRIMARY KEY)')
  ]);
  ready = true;
}
