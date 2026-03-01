// ══════════════════════════════════════════════════════════════
// Netlify Function — comments.js
// يجلب تعليقات البث المباشر من يوتيوب ويحفظها في Supabase
// ══════════════════════════════════════════════════════════════

const VIDEO_ID = "6_9ZiuONXt0";
const SUPA_URL = process.env.SUPABASE_URL || "https://amuopyagznrsyojqxaqp.supabase.co";
const SUPA_KEY = process.env.SUPABASE_KEY || "sb_publishable_VEEiRh3zLWxhzIwgJBcvLw_f0hABb0u";
const DB_READY = !!(SUPA_URL && SUPA_KEY);

// ── fetch مع timeout ──────────────────────────────────────────
async function fetchT(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── Supabase: حفظ ────────────────────────────────────────────
async function supaInsert(rows) {
  if (!rows.length) return { status: 200, error: null };
  const res = await fetchT(`${SUPA_URL}/rest/v1/comments`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  const error = (!res.ok && res.status !== 409) ? await res.text() : null;
  return { status: res.status, error };
}

// ── Supabase: قراءة ──────────────────────────────────────────
async function supaSelect() {
  const res = await fetchT(
    `${SUPA_URL}/rest/v1/comments?select=id,author,message,created_at&order=created_at.asc&limit=50000`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) return { data: [], error: await res.text() };
  return { data: await res.json(), error: null };
}

// ── YouTube: جلب التعليقات ───────────────────────────────────
async function fetchYouTubeChat() {
  const pageRes = await fetchT(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const html = await pageRes.text();

  // المفتاح الداخلي ليوتيوب
  const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const ytKey = keyMatch ? keyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  // البحث عن continuation token بطرق متعددة (أكثر موثوقية)
  const patterns = [
    /"reloadContinuationData"\s*:\s*\{[^}]*"continuation"\s*:\s*"([^"]+)"/,
    /"invalidationContinuationData"\s*:\s*\{[^}]*"continuation"\s*:\s*"([^"]+)"/,
    /"timedContinuationData"\s*:\s*\{[^}]*"continuation"\s*:\s*"([^"]+)"/,
    /liveChatRenderer[\s\S]{0,800}?"continuation"\s*:\s*"([^"]+)"/,
  ];

  let cont = null;
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) { cont = m[1]; break; }
  }

  if (!cont) return { msgs: [], reason: "البث غير نشط أو لا توجد دردشة مباشرة" };

  // جلب التعليقات من يوتيوب
  const chatRes = await fetchT(
    `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${ytKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240201.00.00" } },
        continuation: cont,
      }),
    }
  );

  const chatData = await chatRes.json();
  const actions = chatData?.continuationContents?.liveChatContinuation?.actions || [];
  const iraqNow = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  const msgs = [];
  for (const a of actions) {
    const r = a?.addChatItemAction?.item?.liveChatTextMessageRenderer;
    if (!r) continue;
    const text = (r.message?.runs || []).map(x => x.text || "").join("").trim();
    if (!text) continue;
    msgs.push({
      youtube_id: r.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      author: r.authorName?.simpleText?.trim() || "مجهول",
      message: text,
      created_at: iraqNow,
    });
  }

  return { msgs, reason: msgs.length === 0 ? "لا توجد تعليقات في هذه اللحظة" : null };
}

// ── Handler الرئيسي ──────────────────────────────────────────
exports.handler = async function () {
  const log = { db: DB_READY, yt: 0, reason: null, saved: null, savedErr: null, readErr: null };
  let ytMsgs = [];
  let allMsgs = [];

  // 1. جلب من يوتيوب
  try {
    const r = await fetchYouTubeChat();
    ytMsgs = r.msgs;
    log.yt = ytMsgs.length;
    log.reason = r.reason;
  } catch (e) {
    log.reason = "YouTube error: " + e.message;
  }

  // 2. حفظ في Supabase
  if (DB_READY && ytMsgs.length > 0) {
    const ins = await supaInsert(ytMsgs);
    log.saved = ins.status;
    log.savedErr = ins.error;
  }

  // 3. قراءة كل التعليقات من Supabase
  if (DB_READY) {
    const sel = await supaSelect();
    allMsgs = sel.data;
    log.readErr = sel.error;
  }

  // 4. fallback: عرض تعليقات يوتيوب مباشرة إذا Supabase فشلت
  if (allMsgs.length === 0 && ytMsgs.length > 0) {
    allMsgs = ytMsgs.map((m, i) => ({ id: i + 1, ...m }));
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ messages: allMsgs, new_count: log.yt, total: allMsgs.length, log }),
  };
};
