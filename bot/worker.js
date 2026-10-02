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
      const hook = await tg(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: secret, allowed_updates: ['channel_post', 'edited_channel_post', 'message', 'callback_query'] });
      const me = await tg(env, 'getMe', {});
      return json({ webhook: hook.ok ? 'connected' : hook, bot: me.result ? '@' + me.result.username : me });
    }
    if (url.pathname === '/status') {   // delivery health from Telegram (no secrets)
      const r = await tg(env, 'getWebhookInfo', {});
      const w = r.result || {};
      return json({ pending: w.pending_update_count, lastError: w.last_error_message || null, lastErrorAt: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null, allowed: w.allowed_updates });
    }
    if (url.pathname === '/inbox') {
      const names = {}, schedules = [];
      (await env.DB.prepare('SELECT key, name FROM names').all()).results.forEach(r => { names[r.key] = r.name; });
      (await env.DB.prepare('SELECT id, text, at FROM schedules ORDER BY at DESC LIMIT 10').all()).results.forEach(r => schedules.push(r));
      const exams = (await env.DB.prepare('SELECT id, text, at FROM exam_posts ORDER BY at DESC LIMIT 20').all()).results;
      return json({ names, schedules, exams });
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    return json({ ok: true, hint: 'Study Planner bot. Open /setup once after deploying.' });
  }
};

async function handle(u, env) {
  if (u.callback_query) return onButton(u.callback_query, env);
  const m = u.channel_post || u.edited_channel_post || u.message;
  // short delivery log (last 30), to see what Telegram actually sends
  await env.DB.prepare('INSERT INTO updlog (at, kind, chat, sample) VALUES (?, ?, ?, ?)').bind(Date.now(), Object.keys(u).filter(k => k !== 'update_id').join(','), m && m.chat ? m.chat.type : '', m ? String(m.text || m.caption || (m.document ? 'doc:' + m.document.file_name : '')).slice(0, 300) : '').run();
  await env.DB.prepare('DELETE FROM updlog WHERE at < (SELECT min(at) FROM (SELECT at FROM updlog ORDER BY at DESC LIMIT 30))').run();
  if (!m || !m.chat) return;
  const now = Date.now(), db = env.DB;
  const text = m.text || m.caption || '';
  const isSchedule = /Group\s*A\s*[12]/i.test(text) && /المحاضرة/.test(text);
  // an exam announcement: exam words plus a day (18/10, "sunday", "الاحد", "tomorrow"), and not a schedule
  const examDay = isSchedule ? '' : examDate(text, now);
  const isExam = !!examDay && /امتحان|اختبار|امتحانات|كويز|كوز|\bexam|\bquiz|\btest\b|midterm|final|practical|عملي/i.test(text);
  const name = (m.document && cleanName(m.document.file_name)) || '';
  let keys = [];
  if (m.chat.type === 'channel') {
    // remember the channel, so forwards from it can be trusted later
    for (const c of chatKeys(m.chat)) await db.prepare('INSERT OR IGNORE INTO chats (key) VALUES (?)').bind(c).run();
    keys = chatKeys(m.chat).map(c => `${c}/${m.message_id}`);
  } else if (m.chat.type === 'private') {
    // Private chat: only Hussein and زهرة. The first two people to message the bot become its owners.
    if (!await isOwner(env, m.from && m.from.id)) return reply(env, m, 'This bot is private.');
    if (isSchedule || isExam) keys = [`dm/${m.chat.id}/${m.message_id}`];
    else if (m.forward_origin && m.forward_origin.type === 'channel' && name) keys = chatKeys(m.forward_origin.chat).map(c => `${c}/${m.forward_origin.message_id}`);
    else return reply(env, m, 'Forward the daily schedule here and the lectures go straight to the app. Exam messages ("I have an Ophtho exam on Sunday") become exams in your app. You can also forward a lecture PDF to save its name.');
  } else return;

  if (name) for (const k of keys) await db.prepare('INSERT OR REPLACE INTO names (key, name, at) VALUES (?, ?, ?)').bind(k, name, now).run();
  if (isSchedule) {
    const withLinks = inlineLinks(text, m.entities || m.caption_entities || []);
    await db.prepare('INSERT OR REPLACE INTO schedules (id, text, at) VALUES (?, ?, ?)').bind(keys[0], withLinks, now).run();
    await db.prepare('DELETE FROM schedules WHERE at < ?').bind(now - 30 * 864e5).run();
  }
  let askWho = false, group = groupsIn(text);
  if (isExam) {
    // No group written: in a private chat the exam belongs to whoever sent it.
    let stored = text;
    if (!group && m.chat.type === 'private') {
      const who = await db.prepare('SELECT v FROM settings WHERE k = ?').bind('who:' + m.from.id).first();
      if (who) { group = GROUPS[who.v]; stored += `\n[group:${group}]`; }
      else { askWho = true; stored += `\n[from:${m.from.id}]`; }
    }
    await db.prepare('INSERT OR REPLACE INTO exam_posts (id, text, at) VALUES (?, ?, ?)').bind(keys[0], stored, now).run();
    await db.prepare('DELETE FROM exam_posts WHERE at < ?').bind(now - 60 * 864e5).run();
  }
  if (m.chat.type !== 'private') return;
  if (askWho) return tg(env, 'sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id,
    text: `Exam noted for ${prettyDay(examDay)}. Who are you? I'll remember it, so your exams go to your app.`,
    reply_markup: { inline_keyboard: [[{ text: 'Hussein (A2)', callback_data: 'who:hussein' }, { text: 'زهرة (A1)', callback_data: 'who:zhra' }]] } });
  if (isExam) {
    const listed = text.split('\n').slice(1).filter(x => x.trim() && !/^\s*(ortho|ophth?o?|optho|ent|wh)\s*$/i.test(x)).length;
    return reply(env, m, `Exam saved for ${prettyDay(examDay)}, ${group ? 'group ' + group : 'both groups'}${listed ? `, with ${listed} lecture${listed === 1 ? '' : 's'}` : ''}. It will show in the app.`);
  }
  if (isSchedule) {
    const n = (text.match(/المحاضرة\s+\S+\s*:/g) || []).length, day = (text.match(/المصادف\s*([\d٠-٩]{1,2}\s*\/\s*[\d٠-٩]{1,2})/) || [])[1];
    const links = (withLinksCount(text, m.entities || m.caption_entities || []));
    return reply(env, m, `Got it: ${n} lecture${n === 1 ? '' : 's'}${day ? ' for ' + day.replace(/\s/g, '') : ''}. They will show up in the app${links ? '' : ' (no lecture links were attached, so names stay empty; forward the message instead of copying it)'}.`);
  }
  return reply(env, m, `Saved: ${name}`);
}
const GROUPS = { hussein: 'A2', zhra: 'A1' };
const groupsIn = text => { const t = String(text); const a1 = /\bA\s*1\b/i.test(t), a2 = /\bA\s*2\b/i.test(t); return a1 && !a2 ? 'A1' : a2 && !a1 ? 'A2' : ''; };
// "Who are you?" buttons: link this Telegram account to Hussein or زهرة, then file any waiting exams.
async function onButton(q, env) {
  const user = (String(q.data || '').match(/^who:(hussein|zhra)$/) || [])[1];
  if (!user || !await isOwner(env, q.from.id)) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  await env.DB.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('who:' + q.from.id, user).run();
  await env.DB.prepare('UPDATE exam_posts SET text = replace(text, ?, ?)').bind(`[from:${q.from.id}]`, `[group:${GROUPS[user]}]`).run();
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Saved' });
  if (q.message) await tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `Got it, you're ${user === 'zhra' ? 'زهرة (A1)' : 'Hussein (A2)'}. Your exams go to your app from now on.` });
}
// The exam's day: a written date (18/10), today/tomorrow, or the next weekday named. Iraq time.
const WEEKDAYS = [['sunday', 'الاحد', 'الأحد'], ['monday', 'الاثنين', 'الإثنين'], ['tuesday', 'الثلاثاء'], ['wednesday', 'الاربعاء', 'الأربعاء'], ['thursday', 'الخميس'], ['friday', 'الجمعة', 'الجمعه'], ['saturday', 'السبت']];
function examDate(text, at) {
  const t = String(text).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)), now = new Date(at + 3 * 36e5);   // UTC+3
  const ymd = d => d.toISOString().slice(0, 10);
  for (const [, d, m, y] of t.matchAll(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?/g)) {
    if (+m < 1 || +m > 12 || +d < 1 || +d > 31) continue;
    let yr = y ? (+y < 100 ? 2000 + +y : +y) : now.getUTCFullYear(), dt = new Date(Date.UTC(yr, m - 1, d));
    if (!y && dt < now - 60 * 864e5) dt = new Date(Date.UTC(yr + 1, m - 1, d));
    return ymd(dt);
  }
  const plus = n => ymd(new Date(now.getTime() + n * 864e5));
  if (/tomorrow|باجر|بكرة|بكره|غدا|غداً/i.test(t)) return plus(1);
  if (/\btoday\b|اليوم/i.test(t)) return plus(0);
  const lower = t.toLowerCase();
  for (let i = 0; i < 7; i++) if (WEEKDAYS[i].some(w => /^[a-z]/.test(w) ? new RegExp('\\b' + w + '\\b').test(lower) : t.includes(w))) return plus((i - now.getUTCDay() + 7) % 7);
  return '';
}
const prettyDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const withLinksCount = (text, entities) => entities.filter(e => e.type === 'text_link' || e.type === 'url').length;
async function isOwner(env, id) {
  if (!id) return false;
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'owners'").first();
  const owners = row ? JSON.parse(row.v) : [];
  if (owners.includes(id)) return true;
  if (owners.length >= 2) return false;
  owners.push(id);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('owners', ?)").bind(JSON.stringify(owners)).run();
  return true;
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS chats (key TEXT PRIMARY KEY)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS exam_posts (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS updlog (at INTEGER, kind TEXT, chat TEXT, sample TEXT)')
  ]);
  ready = true;
}
