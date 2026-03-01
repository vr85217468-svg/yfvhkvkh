// ══════════════════════════════════════════════════════════════
// Netlify Function — comments.js
// يجلب تعليقات البث المباشر من يوتيوب ويحفظها في Supabase
// ══════════════════════════════════════════════════════════════

const VIDEO_ID = "6_9ZiuONXt0";
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const DB_READY = !!(SUPA_URL && SUPA_KEY);

// ── مساعد: طلب مع timeout ──────────────────────────────────
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Supabase: إدراج مع تجاهل المكرر ──────────────────────
async function supaInsert(rows) {
  if (!rows.length) return { ok: true, status: 200, error: null };
  const res = await fetchWithTimeout(`${SUPA_URL}/rest/v1/comments`, {
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
  return { ok: res.ok || res.status === 409, status: res.status, error };
}

// ── Supabase: قراءة كل التعليقات ─────────────────────────
async function supaSelectAll() {
  const res = await fetchWithTimeout(
    `${SUPA_URL}/rest/v1/comments?select=id,author,message,created_at&order=created_at.asc&limit=50000`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) return { data: [], error: await res.text() };
  return { data: await res.json(), error: null };
}

// ── YouTube: جلب التعليقات الحية ──────────────────────────
async function fetchYouTubeChat() {
  // فتح صفحة يوتيوب كمتصفح
  const pageRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = await pageRes.text();

  // المفتاح الداخلي ليوتيوب (مضمّن في كل صفحة تلقائياً)
  const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const ytKey = keyMatch ? keyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  // استخراج ytInitialData
  const tag = "var ytInitialData = ";
  const si = html.indexOf(tag);
  if (si === -1) return { msgs: [], reason: "البث غير متاح أو غير نشط" };

  let depth = 0, i = si + tag.length, end = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
  }

  const ytData = JSON.parse(html.slice(si + tag.length, end));
  const renderer = ytData?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;

  if (!renderer) return { msgs: [], reason: "لا توجد دردشة مباشرة في هذا البث" };

  const cons = renderer.continuations || [];
  const cont =
    cons[0]?.reloadContinuationData?.continuation ||
    cons[0]?.invalidationContinuationData?.continuation ||
    cons[0]?.timedContinuationData?.continuation;

  if (!cont) return { msgs: [], reason: "البث غير نشط الآن" };

  // جلب التعليقات
  const chatRes = await fetchWithTimeout(
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

  // الوقت العراقي UTC+3
  const iraqNow = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  const msgs = [];
  for (const a of actions) {
    const r = a?.addChatItemAction?.item?.liveChatTextMessageRenderer;
    if (!r) continue;
    const text = (r.message?.runs || []).map(x => x.text || "").join("").trim();
    if (!text) continue;
    // إنشاء معرّف فريد: youtube_id أو نص مركّب
    const youtube_id = r.id || `${iraqNow}-${r.authorName?.simpleText}-${text}`.slice(0, 200);
    msgs.push({
      youtube_id,
      author: r.authorName?.simpleText?.trim() || "مجهول",
      message: text,
      created_at: iraqNow,
    });
  }

  return { msgs, reason: msgs.length === 0 ? "لا توجد تعليقات في هذه اللحظة" : null };
}

// ── الدالة الرئيسية ────────────────────────────────────────
exports.handler = async function () {
  const log = { db: DB_READY, yt: 0, saved: null, savedErr: null, readErr: null, reason: null };
  let ytMsgs = [];
  let allMsgs = [];

  // 1. جلب تعليقات يوتيوب
  try {
    const res = await fetchYouTubeChat();
    ytMsgs = res.msgs;
    log.yt = ytMsgs.length;
    log.reason = res.reason;
  } catch (e) {
    log.reason = "خطأ يوتيوب: " + e.message;
  }

  // 2. حفظ في Supabase
  if (DB_READY && ytMsgs.length > 0) {
    const ins = await supaInsert(ytMsgs);
    log.saved = ins.status;
    log.savedErr = ins.error;
  }

  // 3. قراءة كل التعليقات من Supabase
  if (DB_READY) {
    const sel = await supaSelectAll();
    allMsgs = sel.data;
    log.readErr = sel.error;
  }

  // 4. إذا Supabase لم يُرجع شيئاً، اعرض تعليقات يوتيوب مؤقتاً
  if (allMsgs.length === 0 && ytMsgs.length > 0) {
    allMsgs = ytMsgs.map((m, i) => ({ id: i + 1, ...m }));
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ messages: allMsgs, new_count: log.yt, total: allMsgs.length, log }),
  };
};
