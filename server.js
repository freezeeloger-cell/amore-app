const express = require("express");
const crypto = require("crypto");

// --- Подключение к базе бота (для догоняющих сообщений). Защищено: если pg не стоит — апка работает как обычно ---
let PgPool = null;
try { PgPool = require("pg").Pool; } catch (e) { console.log("пакет pg не установлен — догоняющие сообщения выключены"); }
const DATABASE_URL = process.env.DATABASE_URL;
const pgPool = (PgPool && DATABASE_URL)
  ? new PgPool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false } })
  : null;
if (pgPool) pgPool.on("error", (e) => console.log("pg pool error:", e.message));

const app = express();
app.use(express.json({ limit: '15mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const VACANCIES_CSV_URL = process.env.VACANCIES_CSV_URL;
const CONTACTS_API_URL = process.env.CONTACTS_API_URL;
const CONTACTS_TOKEN = process.env.CONTACTS_TOKEN;
const LESSONS_CSV_URL = process.env.LESSONS_CSV_URL;
const REVIEWS_CSV_URL = process.env.REVIEWS_CSV_URL;

// --- CORS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("AMORE backend живой ✅"));

// --- Проверка подписи initData ---
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (computedHash !== hash) return null;
  const userRaw = params.get("user");
  if (!userRaw) return null;
  return JSON.parse(userRaw);
}

// --- Проверка членства в группе ---
async function isUserMember(userId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${GROUP_ID}&user_id=${userId}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.ok) return false;
  const s = data.result.status;
  return ["creator", "administrator", "member", "restricted"].includes(s) && data.result.is_member !== false;
}

// возвращает и членство, и админство (создатель/админ группы)
async function getMembership(userId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${GROUP_ID}&user_id=${userId}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.ok) return { member: false, admin: false };
  const s = data.result.status;
  const member = ["creator", "administrator", "member", "restricted"].includes(s) && data.result.is_member !== false;
  const admin = ["creator", "administrator"].includes(s);
  return { member, admin };
}

// кэш членства на 60 сек (чтобы не дёргать Telegram на каждый запрос)
const memCache = {};
async function getMembershipCached(userId) {
  const c = memCache[userId];
  if (c && Date.now() - c.ts < 60000) return c.m;
  const m = await getMembership(userId);
  memCache[userId] = { m, ts: Date.now() };
  return m;
}

// кэш текста CSV на 60 сек (вакансии/уроки/отзывы)
const csvCache = {};
async function fetchCsvCached(url) {
  const c = csvCache[url];
  if (c && Date.now() - c.ts < 60000) return c.text;
  const r = await fetch(url);
  const text = await r.text();
  csvCache[url] = { text, ts: Date.now() };
  return text;
}

app.post("/check", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);
    res.json({ ok: true, member: m.member, admin: m.admin, name: user.first_name || "" });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Парсер CSV ---
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// --- Вакансии ---
function parseVacancies(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const f = (kw) => h.findIndex((x) => x.includes(kw));
  const iRole = f("должност"), iCo = f("компани"), iPay = f("зарплат"),
    iDir = f("направлен"), iWhen = f("когда"), iUrg = f("срочн"), iAct = f("активн"),
    iPhone = f("телефон"), iEmail = f("email"), iDate = f("дата");
  const cell = (r2, i) => (i >= 0 && r2[i] != null ? String(r2[i]).trim() : "");
  const T = (v) => v.toUpperCase() === "TRUE";
  const fixPhone = (p) => { p = String(p || "").replace(/^[='\s]+/, "").trim(); if (p && /^\d/.test(p) && p.replace(/\D/g, "").length >= 8) p = "+" + p; return p; };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r2 = rows[i];
    if (!r2 || !T(cell(r2, iAct))) continue;
    const role = cell(r2, iRole);
    if (!role) continue;
    out.push({ role, company: cell(r2, iCo), pay: cell(r2, iPay), direction: cell(r2, iDir), when: cell(r2, iWhen), urgent: T(cell(r2, iUrg)), phone: fixPhone(cell(r2, iPhone)), email: cell(r2, iEmail), date: cell(r2, iDate) });
  }
  return out;
}
async function fetchVacancies() {
  return parseVacancies(await fetchCsvCached(VACANCIES_CSV_URL));
}
// Единый порядок вакансий (новые сверху). Одинаков и для /vacancies, и для /sendApplication,
// чтобы id, который видит фронт, совпадал с почтой, которую подставляет сервер.
async function fetchVacanciesOrdered() {
  const out = await fetchVacancies();
  out.reverse();
  return out;
}

// Вакансии: список всем, но телефон/почту — только участнику. Гостю отдаём id,
// чтобы он мог откликнуться бесплатно, а почту подставит сервер (клиент её не видит).
app.post("/vacancies", async (req, res) => {
  try {
    if (!VACANCIES_CSV_URL) return res.json({ ok: false, error: "no csv url" });
    let isMember = false;
    const user = verifyInitData(req.body.initData);
    if (user) isMember = (await getMembershipCached(user.id)).member;

    const ordered = await fetchVacanciesOrdered();
    const safe = ordered.map((v, idx) => {
      const hasPhone = !!(v.phone && String(v.phone).trim());
      const hasEmail = !!(v.email && String(v.email).trim());
      const base = {
        id: idx, role: v.role, company: v.company, pay: v.pay,
        direction: v.direction, when: v.when, urgent: v.urgent, date: v.date,
        hasPhone, hasEmail,
      };
      if (isMember) { base.phone = v.phone; base.email = v.email; } // контакты — только участнику
      return base;
    });
    res.json({ ok: true, member: isMember, vacancies: safe });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Страна по коду телефона ---
function countryFromPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("47")) return "Норвегия";
  if (d.startsWith("45")) return "Дания";
  if (d.startsWith("44")) return "Британия";
  return "";
}

// --- Кэш контактов (60 сек), чтобы не дёргать скрипт на каждый запрос ---
let cache = { data: null, ts: 0 };
async function getRawContacts() {
  if (cache.data && Date.now() - cache.ts < 60000) return cache.data;
  const url = CONTACTS_API_URL + "?token=" + encodeURIComponent(CONTACTS_TOKEN);
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) throw new Error("sheet error");
  cache = { data: j.contacts, ts: Date.now() };
  return j.contacts;
}

// --- База контактов: участнику полностью, гостю с замазкой ---
app.post("/contacts", async (req, res) => {
  try {
    let isMember = false;
    const user = verifyInitData(req.body.initData);
    if (user) isMember = (await getMembershipCached(user.id)).member;

    const raw = await getRawContacts();
    const list = raw.map((c, idx) => {
      const country = countryFromPhone(c.phone);
      const hasPhone = !!(c.phone && String(c.phone).trim());
      const hasEmail = !!(c.email && String(c.email).trim());
      if (isMember || idx < 5) {
        return {
          company: c.company, vessel: c.vessel, direction: c.direction, type: c.type,
          country, hiring: c.hiring, phone: c.phone, email: c.email, hasPhone, hasEmail, locked: false,
        };
      }
      // ГОСТЬ (6-й и далее): без названия/контактов
      return { direction: c.direction, type: c.type, country, hiring: c.hiring, hasPhone, hasEmail, locked: true };
    });

    res.json({ ok: true, member: isMember, count: list.length, contacts: list });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});


// --- Достаём ID видео из ссылки YouTube ---
function youtubeId(url) {
  const m = String(url || "").match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

// --- Уроки: список отдаём всем (как приманку), но ID видео — только участнику ---
app.post("/lessons", async (req, res) => {
  try {
    if (!LESSONS_CSV_URL) return res.json({ ok: false, error: "no csv url" });
    let isMember = false;
    const user = verifyInitData(req.body.initData);
    if (user) isMember = (await getMembershipCached(user.id)).member;

    const rows = parseCSV(await fetchCsvCached(LESSONS_CSV_URL));
    if (rows.length < 2) return res.json({ ok: true, member: isMember, lessons: [] });

    const h = rows[0].map((x) => x.trim().toLowerCase());
    const f = (kw) => h.findIndex((x) => x.includes(kw));
    const iDir = f("направлен"), iOrd = f("порядок"), iTitle = f("назван"),
      iUrl = f("ссылк"), iDur = f("длительн"), iAct = f("актив");
    const cell = (r2, i) => (i >= 0 && r2[i] != null ? String(r2[i]).trim() : "");
    const T = (v) => v.toUpperCase() === "TRUE";

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r2 = rows[i];
      if (!r2 || !T(cell(r2, iAct))) continue;
      const title = cell(r2, iTitle);
      if (!title) continue;
      const id = youtubeId(cell(r2, iUrl));
      out.push({
        direction: cell(r2, iDir),
        order: parseInt(cell(r2, iOrd)) || 0,
        title: title,
        duration: cell(r2, iDur),
        videoId: isMember ? id : null,   // гостю видео не отдаём
      });
    }
    out.sort((a, b) => a.order - b.order);
    res.json({ ok: true, member: isMember, lessons: out });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});


// --- Отзывы (публичные, для всех): текст / аудио / видео ---
app.get("/reviews", async (req, res) => {
  try {
    if (!REVIEWS_CSV_URL) return res.json({ ok: false, error: "no csv url" });
    const rows = parseCSV(await fetchCsvCached(REVIEWS_CSV_URL));
    if (rows.length < 2) return res.json({ ok: true, reviews: [] });
    const h = rows[0].map((x) => x.trim().toLowerCase());
    const f = (kw) => h.findIndex((x) => x.includes(kw));
    const iType = f("тип"), iName = f("имя"), iDir = f("направлен"),
      iText = f("текст"), iLink = f("ссылк"), iPhoto = f("фото"), iAct = f("актив");
    const cell = (r2, i) => (i >= 0 && r2[i] != null ? String(r2[i]).trim() : "");
    const T = (v) => v.toUpperCase() === "TRUE";
    const normType = (v) => {
      v = v.toLowerCase();
      if (v.indexOf("видео") >= 0 || v.indexOf("video") >= 0 || v.indexOf("эфир") >= 0) return "video";
      if (v.indexOf("ауди") >= 0 || v.indexOf("audio") >= 0) return "audio";
      if (v.indexOf("скрин") >= 0 || v.indexOf("screen") >= 0 || v.indexOf("перепис") >= 0 || v.indexOf("картин") >= 0) return "screenshot";
      return "text";
    };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r2 = rows[i];
      if (!r2 || !T(cell(r2, iAct))) continue;
      const name = cell(r2, iName);
      if (!name) continue;
      const type = normType(cell(r2, iType));
      const link = cell(r2, iLink);
      out.push({
        type: type, name: name, dir: cell(r2, iDir), text: cell(r2, iText),
        photo: cell(r2, iPhoto), link: link, videoId: type === "video" ? youtubeId(link) : "",
      });
    }
    res.json({ ok: true, reviews: out });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Объявление вакансии в группу (только админ группы) ---
const APP_LINK = process.env.APP_LINK || "https://t.me/Crabnorwaybot";
function htmlEsc(s) { return String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

app.post("/announce", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);
    if (!m.admin) return res.json({ ok: false, error: "not admin" });

    const v = req.body.vacancy || {};
    if (!v.role) return res.json({ ok: false, error: "no vacancy" });

    let text = "🚢 <b>Новая вакансия</b>\n\n";
    text += "<b>" + htmlEsc(v.role) + "</b>\n";
    const line2 = [v.company, v.direction].filter(Boolean).map(htmlEsc).join(" · ");
    if (line2) text += "📍 " + line2 + "\n";
    if (v.pay) text += "💰 " + htmlEsc(v.pay) + "\n";
    if (v.when) text += "🕒 " + htmlEsc(v.when) + "\n";
    if (v.urgent) text += "🔴 Срочно\n";
    text += "\n📲 Контакты и подробности — в приложении AMORE";

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        text: text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "📲 Открыть AMORE", url: APP_LINK }]] },
      }),
    });
    const data = await tgRes.json();
    if (!data.ok) return res.json({ ok: false, error: data.description || "send failed" });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Старт бесплатного доступа -> записываем в базу бота (бот через 3 дня напомнит) ---
app.post("/trialStart", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    await pgPool.query(
      "INSERT INTO trial_users (user_id, started_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO NOTHING",
      [user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Заявка на изготовление документов -> в личку владельцу ---
const OWNER_ID = process.env.OWNER_ID;

// --- Лид из воронки-опросника -> в личку владельцу ---
app.post("/lead", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!OWNER_ID) return res.json({ ok: false, error: "OWNER_ID not set" });

    const b = req.body || {};
    const CIT = { eu: "🇪🇺 ЕС", ua: "🇺🇦 Украина", md: "🌍 Молдова/Грузия/др.", other: "🛂 Россия/Беларусь" };
    const DOC = { yes: "✅ BST + медкомиссия есть", one: "📄 Только один документ", no: "❌ Пока нет", dk: "🤷 Не знает, что нужно" };
    const DIR = { crab: "🦀 Краболов/рыбак", wash: "🧽 Замывка трюмов", yacht: "⛵ Яхтинг", merch: "🚢 Торговый флот", any: "🤔 Ещё не решил" };
    const cit = CIT[b.citizenship] || "—";
    const doc = DOC[b.documents] || "—";
    const dir = DIR[b.direction] || "—";

    const uname = user.username ? "@" + user.username : "(без username)";
    let text = "🧭 <b>Новый лид из воронки</b>\n\n";
    text += "👤 " + htmlEsc(user.first_name || "") + " " + htmlEsc(uname) + " (id " + user.id + ")\n\n";
    text += "🌍 <b>Гражданство:</b> " + htmlEsc(cit) + "\n";
    text += "📋 <b>Документы:</b> " + htmlEsc(doc) + "\n";
    text += "⚓️ <b>Направление:</b> " + htmlEsc(dir);

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OWNER_ID, text: text, parse_mode: "HTML" }),
    });
    const data = await tgRes.json();
    if (!data.ok) return res.json({ ok: false, error: data.description || "send failed" });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.post("/apply", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!OWNER_ID) return res.json({ ok: false, error: "OWNER_ID not set" });

    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 120);
    const phone = String(b.phone || "").trim().slice(0, 60);
    const citizenship = String(b.citizenship || "").trim().slice(0, 80);
    const certs = Array.isArray(b.certs) ? b.certs.map((c) => String(c).slice(0, 80)) : [];
    if (!name || !phone) return res.json({ ok: false, error: "no name/phone" });

    const uname = user.username ? "@" + user.username : "(без username)";
    let text = "📄 <b>Новая заявка на документы</b>\n\n";
    text += "👤 <b>Имя:</b> " + htmlEsc(name) + "\n";
    text += "📞 <b>Телефон:</b> " + htmlEsc(phone) + "\n";
    if (citizenship) text += "🌍 <b>Гражданство:</b> " + htmlEsc(citizenship) + "\n";
    text += "📋 <b>Сертификаты:</b>\n";
    text += certs.length ? certs.map((c) => "• " + htmlEsc(c)).join("\n") : "—";
    text += "\n\n💬 <b>Telegram:</b> " + htmlEsc(uname) + " (id " + user.id + ")";

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OWNER_ID, text: text, parse_mode: "HTML" }),
    });
    const data = await tgRes.json();
    if (!data.ok) return res.json({ ok: false, error: data.description || "send failed" });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// --- Рассылка резюме через Brevo ---
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "contact@crabnorway.com";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "AMORE";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "15", 10);
const guestSends = {}; // uid -> кол-во отправок гостя (в памяти, мгновенно; сбрасывается при редеплое)

function brevoHeaders() {
  return { "api-key": BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" };
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysAgoStr(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// сколько писем юзер отправил сегодня (по тегу), считаем из событий Brevo
async function countTodaySends(tag) {
  try {
    const d = todayStr();
    const url = `https://api.brevo.com/v3/smtp/statistics/events?event=requests&tags=${encodeURIComponent(tag)}&startDate=${d}&endDate=${d}&limit=2500`;
    const r = await fetch(url, { headers: brevoHeaders() });
    if (!r.ok) return 0;
    const data = await r.json();
    return Array.isArray(data.events) ? data.events.length : 0;
  } catch (e) { return 0; }
}

// сколько писем юзер отправил за N дней (для гостевого лимита)
async function countSendsSince(tag, days) {
  try {
    const url = `https://api.brevo.com/v3/smtp/statistics/events?event=requests&tags=${encodeURIComponent(tag)}&startDate=${daysAgoStr(days)}&endDate=${todayStr()}&limit=2500`;
    const r = await fetch(url, { headers: brevoHeaders() });
    if (!r.ok) return 0;
    const data = await r.json();
    return Array.isArray(data.events) ? data.events.length : 0;
  } catch (e) { return 0; }
}

app.post("/sendApplication", async (req, res) => {
  try {
    if (!BREVO_API_KEY) return res.json({ ok: false, error: "BREVO_API_KEY not set" });
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);

    const b = req.body || {};
    let to = String(b.to || "").trim();

    // Отклик по id вакансии: почту берём на СЕРВЕРЕ (гость её не получает в /vacancies).
    // Это же защищает от использования твоего домена для спама на произвольные адреса.
    if (b.vacId !== undefined && b.vacId !== null && b.vacId !== "") {
      const ordered = await fetchVacanciesOrdered();
      const vv = ordered[Number(b.vacId)];
      if (!vv || !vv.email) return res.json({ ok: false, error: "vacancy has no email" });
      to = String(vv.email).trim();
    } else if (!m.member) {
      // Гость может слать ТОЛЬКО по vacId (на реальную вакансию), а не на любой адрес.
      return res.json({ ok: false, error: "guests must apply via vacancy" });
    }

    const replyTo = String(b.replyTo || "").trim();
    const subject = String(b.subject || "").trim();
    const text = String(b.text || "").trim();
    if (!to || !subject || !text) return res.json({ ok: false, error: "missing fields" });
    if (!replyTo) return res.json({ ok: false, error: "no replyTo" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.json({ ok: false, error: "bad email" });

    const tag = "uid_" + user.id;
    const GUEST_LIMIT = 3;
    var usedCount = 0, capLimit = DAILY_LIMIT;
    if (m.member) {
      usedCount = await countTodaySends(tag);
      capLimit = DAILY_LIMIT;
      if (usedCount >= DAILY_LIMIT) return res.json({ ok: false, limit: true, used: usedCount, max: DAILY_LIMIT });
    } else {
      // гость: 3 отклика всего. Brevo считает с задержкой, поэтому держим мгновенный счётчик в памяти и берём максимум.
      const brevoCount = await countSendsSince(tag, 90);
      usedCount = Math.max(brevoCount, guestSends[user.id] || 0);
      capLimit = GUEST_LIMIT;
      if (usedCount >= GUEST_LIMIT) return res.json({ ok: false, guestLimit: true, used: usedCount, max: GUEST_LIMIT });
    }

    const payload = {
      sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
      to: [{ email: to }],
      replyTo: (b.replyName ? { email: replyTo, name: String(b.replyName).slice(0, 80) } : { email: replyTo }),
      subject: subject.slice(0, 200),
      textContent: text,
      tags: [tag],
    };
    if (b.cvBase64 && b.cvName) {
      payload.attachment = [{ content: String(b.cvBase64), name: String(b.cvName).slice(0, 80) }];
    }
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: brevoHeaders(), body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data.messageId) return res.json({ ok: false, error: (data && (data.message || data.code)) || "send failed" });
    if (!m.member) guestSends[user.id] = usedCount + 1;
    res.json({ ok: true, messageId: data.messageId, remaining: Math.max(0, capLimit - (usedCount + 1)), guest: !m.member });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// статус откликов пользователя (доставлено/открыто) из событий Brevo
app.post("/myApplications", async (req, res) => {
  try {
    if (!BREVO_API_KEY) return res.json({ ok: true, applications: [] });
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const tag = "uid_" + user.id;
    const url = `https://api.brevo.com/v3/smtp/statistics/events?tags=${encodeURIComponent(tag)}&startDate=${daysAgoStr(30)}&endDate=${todayStr()}&limit=2500`;
    const r = await fetch(url, { headers: brevoHeaders() });
    if (!r.ok) return res.json({ ok: true, applications: [] });
    const data = await r.json();
    const ev = Array.isArray(data.events) ? data.events : [];
    const rank = (e) => {
      e = (e || "").toLowerCase();
      if (e.indexOf("open") >= 0) return 3;
      if (e === "delivered") return 2;
      if (e === "requests") return 1;
      return 0;
    };
    const byMsg = {};
    ev.forEach(function (e) {
      const id = e.messageId || (e.email + "|" + e.date);
      if (!byMsg[id]) byMsg[id] = { to: e.email, date: e.date, r: 0, bounced: false };
      const rr = rank(e.event);
      if (rr > byMsg[id].r) byMsg[id].r = rr;
      if (/bounce|blocked|invalid|spam/i.test(e.event || "")) byMsg[id].bounced = true;
      if (!byMsg[id].date || (e.date && e.date > byMsg[id].date)) { /* keep latest date for display */ }
    });
    const apps = Object.keys(byMsg).map(function (k) {
      const a = byMsg[k];
      let st = "Отправлено";
      if (a.bounced) st = "Не доставлено";
      else if (a.r >= 3) st = "Открыто";
      else if (a.r >= 2) st = "Доставлено";
      return { to: a.to, date: a.date, status: st };
    }).sort(function (x, y) { return String(y.date || "").localeCompare(String(x.date || "")); });
    res.json({ ok: true, applications: apps, limit: DAILY_LIMIT });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AMORE backend on port " + PORT));
