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
app.use(express.json({ limit: '15mb', verify: (req, res, buf) => { req.rawBody = buf; } })); // rawBody нужен для проверки подписи Tribute

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
// Отдельная группа/канал подписки «AMORE Рассылка» (Tribute добавляет туда купивших авторассылку).
const MASS_GROUP_ID = process.env.MASS_GROUP_ID;
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
// EXTRA_BOT_TOKENS — токены ботов менторов через запятую (переменная Railway)
const INITDATA_TOKENS = [BOT_TOKEN].concat(String(process.env.EXTRA_BOT_TOKENS || "").split(",").map(function (t) { return t.trim(); })).filter(Boolean);
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
  // приложение открывают из нескольких ботов (основной + боты менторов) — подпись у каждого своя
  const okSig = INITDATA_TOKENS.some(function (tok) {
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(tok).digest();
    return crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex") === hash;
  });
  if (!okSig) return null;
  const userRaw = params.get("user");
  if (!userRaw) return null;
  return JSON.parse(userRaw);
}

// --- Безопасный запрос к Telegram: повтор при сбое, HTML вместо JSON не роняет сервер. null = не удалось проверить ---
async function tgChatMember(chatId, userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatId}&user_id=${userId}`);
      const txt = await r.text();
      let d; try { d = JSON.parse(txt); } catch (e) { throw new Error("telegram non-JSON HTTP " + r.status); }
      if (d.ok) return d.result;
      // Telegram ответил осмысленно "не ok" (например, user not found) — это НЕ сбой, это "не участник"
      if (d.error_code && d.error_code !== 429 && d.error_code < 500) return { status: "left", is_member: false };
      throw new Error("telegram " + (d.description || d.error_code));
    } catch (e) {
      if (attempt === 2) { console.log("[telegram] getChatMember не удался:", e.message); return null; }
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
  }
  return null;
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
// Оплаченная подписка по данным Tribute (таблица subs) — второй источник правды, не зависит от Telegram
async function hasActiveSub(userId) {
  if (!pgPool) return false;
  try {
    const r = await pgPool.query(
      "SELECT 1 FROM subs WHERE user_id=$1 AND group_kind='main' AND active=TRUE AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '1 day') LIMIT 1",
      [String(userId)]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}
// есть ли у человека оплаченная подписка, кроме пробной (например, купил 3 месяца)
async function hasOtherSub(userId) {
  if (!pgPool) return false;
  try {
    const r = await pgPool.query("SELECT 1 FROM subs s WHERE s.user_id=$1 AND s.group_kind='main' AND s.active=TRUE " +
      "AND s.tribute_sub_id IS DISTINCT FROM (SELECT sub_id FROM trials t WHERE t.user_id=$1::bigint) LIMIT 1", [String(userId)]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}
async function getMembership(userId) {
  const res = await tgChatMember(GROUP_ID, userId);
  if (!res) {
    // сбой Telegram: если по Tribute подписка активна — участник, иначе статус неизвестен (не "гость")
    if (await hasActiveSub(userId)) { const t = await getTrialState(userId); if (!(t.expired && !(await hasOtherSub(userId)))) return { member: true, admin: false, viaSub: true }; }
    return { member: false, admin: false, unknown: true };
  }
  const s = res.status;
  let member = ["creator", "administrator", "member", "restricted"].includes(s) && res.is_member !== false;
  const admin = ["creator", "administrator"].includes(s);
  // не в группе (ещё не вступил / вышел случайно), но подписка оплачена — пускаем по подписке
  if (!member && await hasActiveSub(userId)) member = true;
  // пробный период кончился, списания ещё нет (Tribute держит в группе до 7 дней) — апка закрыта, пока не спишется
  if (member && !admin) { const t = await getTrialState(userId); if (t.expired && !(await hasOtherSub(userId))) member = false; }
  return { member, admin };
}

// кэш членства на 60 сек (чтобы не дёргать Telegram на каждый запрос)
const memCache = {};
async function getMembershipCached(userId) {
  const c = memCache[userId];
  if (c && Date.now() - c.ts < 60000) return c.m;
  const m = await getMembership(userId);
  if (m.unknown) { if (c) return c.m; return m; } // сбой: отдаём последний известный статус, не кэшируем сбой
  memCache[userId] = { m, ts: Date.now() };
  return m;
}

// Доступ к массовой рассылке = членство в отдельной группе MASS_GROUP_ID (подписка Tribute на рассылку)
// true / false / null (null = Telegram не ответил, статус неизвестен — НЕ считать "не подписан")
// Оплаченная подписка на рассылку по базе (вебхук Tribute) — не зависит от того, остался ли человек в группе
async function hasActiveMassSub(userId) {
  if (!pgPool) return false;
  try {
    const r = await pgPool.query(
      "SELECT 1 FROM subs WHERE user_id=$1 AND group_kind='mass' AND active=TRUE AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '1 day') LIMIT 1",
      [String(userId)]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}
async function getMassAccess(userId) {
  // 1) оплачено по базе — доступ есть, даже если вышел из группы «Автоматическая рассылка» (она пустая, люди из неё уходят)
  if (await hasActiveMassSub(userId)) return true;
  // 2) иначе — по членству в группе (старые подписчики до вебхука)
  if (!MASS_GROUP_ID) return false;
  const res = await tgChatMember(MASS_GROUP_ID, userId);
  if (!res) return null;
  const s = res.status;
  return ["creator", "administrator", "member", "restricted"].includes(s) && res.is_member !== false;
}
const massCache = {};
async function getMassAccessCached(userId) {
  const c = massCache[userId];
  if (c && Date.now() - c.ts < 60000) return c.v;
  const v = await getMassAccess(userId);
  if (v === null) return c ? c.v : null; // сбой: последний известный или "неизвестно"
  massCache[userId] = { v, ts: Date.now() };
  return v;
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
    if (m.unknown) return res.json({ ok: false, transient: true, error: "Не удалось проверить доступ. Попробуй через минуту." });
    const massRaw = m.member ? await getMassAccessCached(user.id) : false;
    const mass = massRaw === true;
    if (pgPool) {
      pgPool.query(
        "INSERT INTO app_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET last_seen=NOW()",
        [String(user.id)]
      ).catch(function () {});
    }
    const trial = await getTrialState(user.id);
    res.json({ ok: true, member: m.member, admin: m.admin, mass: mass, name: user.first_name || "",
      trial: trial.active, trialEnds: trial.active ? trial.ends_at : null, trialUsed: trial.used, trialExpired: !!trial.expired,
      ai: !!ANTHROPIC_API_KEY });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    iPhone = f("телефон"), iEmail = f("email"), iDate = f("дата"), iCountry = f("стран", "country");
  const cell = (r2, i) => (i >= 0 && r2[i] != null ? String(r2[i]).trim() : "");
  const T = (v) => /^(true|да|yes|1|✅|✔|срочно|активн)/i.test(String(v || "").trim()); // флажок TRUE или текст Да/Yes/1
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r2 = rows[i];
    if (!r2 || !T(cell(r2, iAct))) continue;
    const role = cell(r2, iRole);
    if (!role) continue;
    const vCountry = normCountry(cell(r2, iCountry));
    out.push({ role, company: cell(r2, iCo), pay: cell(r2, iPay), direction: cell(r2, iDir), when: cell(r2, iWhen), urgent: T(cell(r2, iUrg)),
      phone: normPhone(cell(r2, iPhone), vCountry), country: vCountry, email: cell(r2, iEmail), date: cell(r2, iDate) });
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
        country: v.country || "", hasPhone, hasEmail,
      };
      if (isMember) { base.phone = v.phone; base.email = v.email; } // контакты — только участнику
      return base;
    });
    res.json({ ok: true, member: isMember, vacancies: safe });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

// --- Телефоны: код страны ---
// Коды и длина местного номера. Страна берётся из колонки «Страна» таблицы; если её нет —
// для номера без кода считаем DEFAULT_CONTACT_COUNTRY (база в основном норвежская).
const PHONE_CC = { "Норвегия": ["47", 8], "Дания": ["45", 8], "Британия": ["44", 10], "Великобритания": ["44", 10], "Нидерланды": ["31", 9],
  "Германия": ["49", 0], "Польша": ["48", 9], "Исландия": ["354", 7], "Фарерские острова": ["298", 6], "Швеция": ["46", 0], "Финляндия": ["358", 0],
  "Испания": ["34", 9], "Франция": ["33", 9], "Италия": ["39", 0], "Литва": ["370", 8], "Латвия": ["371", 8], "Эстония": ["372", 0], "Украина": ["380", 9] };
const PHONE_ALIASES = { norway: "Норвегия", no: "Норвегия", норвегия: "Норвегия", denmark: "Дания", dk: "Дания", дания: "Дания", uk: "Британия", gb: "Британия",
  britain: "Британия", "united kingdom": "Британия", британия: "Британия", великобритания: "Британия", netherlands: "Нидерланды", nl: "Нидерланды", нидерланды: "Нидерланды",
  iceland: "Исландия", исландия: "Исландия", "faroe islands": "Фарерские острова", фареры: "Фарерские острова", poland: "Польша", польша: "Польша", spain: "Испания", испания: "Испания" };
const DEFAULT_CONTACT_COUNTRY = process.env.DEFAULT_CONTACT_COUNTRY || "Норвегия";
function normCountry(v) {
  const k = String(v || "").replace(/[^\p{L}\s]/gu, "").trim().toLowerCase();
  if (!k) return "";
  if (PHONE_ALIASES[k]) return PHONE_ALIASES[k];
  for (const name of Object.keys(PHONE_CC)) if (name.toLowerCase() === k) return name;
  return String(v || "").trim();
}
function countryFromPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!/^(\+|00)/.test(String(phone || "").trim())) return "";
  for (const [name, [cc]] of Object.entries(PHONE_CC)) if (d.startsWith(cc)) return name;
  return "";
}
// Нормализует номер из таблицы в +<код><номер>. country — из колонки «Страна» (может быть пустой).
function normPhone(raw, country) {
  let p = String(raw || "").replace(/^[='\s]+/, "").trim();
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  if (!digits) return p;
  if (/^\+/.test(p)) return "+" + digits;
  if (/^00\d/.test(digits)) return "+" + digits.slice(2);
  // Единственная догадка: ровно 8 цифр без ведущего нуля = норвежский местный номер (формат Норвегии; у Дании тоже 8 — для неё нужна колонка «Страна»)
  const c = normCountry(country) || (digits.length === 8 && !/^0/.test(digits) ? DEFAULT_CONTACT_COUNTRY : "");
  const spec = PHONE_CC[c];
  if (spec) {
    const [cc, len] = spec; const d = digits.replace(/^0+/, "");
    if (d.startsWith(cc) && (!len || d.length === cc.length + len)) return "+" + d;   // код уже вписан без плюса
    return "+" + cc + d;
  }
  // Без страны, но длина ровно «код + местный номер» и начинается с кода известной страны — это код без плюса (47 478 62 107, 380 50 123 45 67)
  if (!/^0/.test(digits)) {
    for (const [, [cc, len]] of Object.entries(PHONE_CC)) if (len && digits.startsWith(cc) && digits.length === cc.length + len) return "+" + digits;
  }
  return p;   // не знаем страну — не трогаем и не дописываем «+»: лучше как в таблице, чем неверный код
}
// Сводка для /phones: какие номера разобраны, какие нет
function phoneAudit(list) {
  const out = { total: 0, ok: 0, bad: [] };
  for (const c of list) {
    if (!c.phone) continue; out.total++;
    if (/^\+\d{8,15}$/.test(c.phone)) out.ok++;
    else if (out.bad.length < 40) out.bad.push({ company: c.company || c.role || "", phone: c.phone, country: c.country || "" });
  }
  return out;
}

// --- Кэш контактов (60 сек), чтобы не дёргать скрипт на каждый запрос ---
let cache = { data: null, ts: 0 };
const CONTACTS_CSV_URL = process.env.CONTACTS_CSV_URL; // опубликованный CSV листа «Контакты» — как у вакансий

// Контакты из опубликованного CSV (колонки по заголовкам: Компания, Судно, Направление, Тип судна, Телефон, Email, Набирает)
function parseContactsCsv(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => String(x || "").trim().toLowerCase());
  const f = (...kws) => h.findIndex((x) => kws.some((k) => x.includes(k)));
  const iCo = f("компани"), iVes = f("судно"), iDir = f("направлен"), iType = f("тип"),
    iPhone = f("телефон"), iEmail = f("email", "почт"), iHire = f("набир", "hiring", "актив"), iCountry = f("стран", "country");
  const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const cCountry = normCountry(cell(r, iCountry));
    const company = cell(r, iCo), email = cell(r, iEmail), phone = normPhone(cell(r, iPhone), cCountry);
    if (!company && !email && !phone) continue;
    out.push({ company, vessel: cell(r, iVes), direction: cell(r, iDir), type: cell(r, iType), phone, email, hiring: cell(r, iHire), country: cCountry });
  }
  return out;
}

const CONTACTS_CACHE_MS = parseInt(process.env.CONTACTS_CACHE_MIN || "10", 10) * 60000;
async function getRawContacts() {
  if (cache.data && Date.now() - cache.ts < CONTACTS_CACHE_MS) return cache.data;
  if (CONTACTS_CSV_URL) {
    try {
      const list = parseContactsCsv(await fetchCsvCached(CONTACTS_CSV_URL));
      if (list.length) { cache = { data: list, ts: Date.now() }; return list; }
      console.log("[contacts] CSV пустой");
    } catch (e) { console.log("[contacts] CSV ошибка:", e.message); }
    if (cache.data) return cache.data;
    if (!CONTACTS_API_URL) throw new Error("contacts csv unavailable");
  }
  const url = CONTACTS_API_URL + "?token=" + encodeURIComponent(CONTACTS_TOKEN);
  // Apps Script иногда отвечает HTML-страницей "unable to open the file" — это временный сбой Google.
  // Пробуем 3 раза с паузой; если не вышло — отдаём последнюю удачную копию.
  let lastSnippet = "", lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); }
      catch (e) {
        lastStatus = r.status;
        lastSnippet = txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
        throw new Error("non-JSON");
      }
      if (!j.ok) throw new Error("sheet error: " + (j.error || ""));
      cache = { data: j.contacts, ts: Date.now() };
      return j.contacts;
    } catch (e) {
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  console.log("[contacts] Google не ответил JSON 3 раза, HTTP", lastStatus, ":", lastSnippet);
  if (cache.data) {
    // тревогу бьём только если копия уже старая (больше часа) — единичные сбои Google не заслуживают алерта
    if (Date.now() - cache.ts > 3600000) alertOwner("база контактов", "Google Script не отвечает больше часа (HTTP " + lastStatus + "): " + lastSnippet);
    return cache.data;
  }
  alertOwner("база контактов недоступна", "Google Script не отвечает и кэша нет (HTTP " + lastStatus + "): " + lastSnippet);
  throw new Error("contacts source unavailable");
}

// --- База контактов: участнику полностью, гостю с замазкой ---
app.post("/contacts", async (req, res) => {
  try {
    let isMember = false;
    const user = verifyInitData(req.body.initData);
    if (user) isMember = (await getMembershipCached(user.id)).member;

    const raw = await getRawContacts();
    const list = raw.map((c, idx) => {
      const country = c.country || countryFromPhone(c.phone) || (c.phone ? DEFAULT_CONTACT_COUNTRY : "");
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
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    const T = (v) => /^(true|да|yes|1|✅|✔|срочно|активн)/i.test(String(v || "").trim()); // флажок TRUE или текст Да/Yes/1

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r2 = rows[i];
      if (!r2 || !T(cell(r2, iAct))) continue;
      const title = cell(r2, iTitle);
      if (!title) continue;
      const id = youtubeId(cell(r2, iUrl));
      const order = parseInt(cell(r2, iOrd)) || 0;
      out.push({
        direction: cell(r2, iDir),
        order,
        title: title,
        duration: cell(r2, iDur),
        overview: order === 0,                          // порядок 0 — обзор направления (60 сек), открыт всем
        videoId: (isMember || order === 0) ? id : null, // остальные уроки — только участнику
      });
    }
    out.sort((a, b) => a.order - b.order);
    res.json({ ok: true, member: isMember, lessons: out });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});


// --- Живые цифры для главной (публично): письма за вчера, ответы за 7 дней ---
let pulseCache = { data: null, ts: 0 };
app.post("/pulse", async (req, res) => {
  try {
    if (!pgPool) return res.json({ ok: true, letters24h: 0, replies7d: 0 });
    if (pulseCache.data && Date.now() - pulseCache.ts < 10 * 60000) return res.json(pulseCache.data);
    const [l, r, m] = await Promise.all([
      pgPool.query("SELECT COUNT(*)::int AS n FROM inbox WHERE direction='out' AND ts > NOW() - INTERVAL '24 hours'"),
      pgPool.query("SELECT COUNT(*)::int AS n FROM inbox WHERE direction='in' AND COALESCE(auto,FALSE)=FALSE AND ts > NOW() - INTERVAL '7 days'"),
      pgPool.query("SELECT COUNT(*)::int AS n FROM subs WHERE group_kind='main' AND active=TRUE").catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    pulseCache = { data: { ok: true, letters24h: l.rows[0].n, replies7d: r.rows[0].n, members: m.rows[0].n }, ts: Date.now() };
    res.json(pulseCache.data);
  } catch (e) { res.json({ ok: true, letters24h: 0, replies7d: 0 }); }
});

// --- Отзывы (публичные, для всех): текст / аудио / видео ---
// --- Кружки менторов для экрана «Кто меня поведёт» в приложении ---
// Бот хранит file_id кружка в file_cache (команда /mentor_video). Здесь отдаём само видео: токен бота и file_id наружу не уходят.
const MENTOR_VIDEO_DIRS = ["crab", "wash", "merch", "yacht"];
const _mvCache = {}; // dir -> { fid, buf, mime }
async function mentorVideoRow(dir) {
  if (!pgPool || MENTOR_VIDEO_DIRS.indexOf(dir) < 0) return null;
  const r = await pgPool.query("SELECT file_id FROM file_cache WHERE name=$1", ["mentor_video_" + dir]);
  const v = r.rows[0] && r.rows[0].file_id;
  if (!v || v.indexOf(":") < 0) return null;
  return { kind: v.slice(0, v.indexOf(":")), fid: v.slice(v.indexOf(":") + 1) };
}
app.get("/mentorVideos", async (req, res) => {
  try {
    const out = {};
    for (const d of MENTOR_VIDEO_DIRS) {
      const row = await mentorVideoRow(d);
      if (row) out[d] = crypto.createHash("sha1").update(row.fid).digest("hex").slice(0, 10); // метка версии: сменили кружок — сменился адрес
    }
    res.json({ ok: true, videos: out });
  } catch (e) { res.json({ ok: false, videos: {} }); }
});
app.get("/mentorVideo/:dir", async (req, res) => {
  try {
    const dir = String(req.params.dir || "");
    const row = await mentorVideoRow(dir);
    if (!row) return res.status(404).end();
    let c = _mvCache[dir];
    if (!c || c.fid !== row.fid) {
      const g = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(row.fid)}`)).json();
      if (!g.ok || !g.result || !g.result.file_path) return res.status(404).end();
      if (g.result.file_size && g.result.file_size > 20 * 1024 * 1024) return res.status(413).end();
      const f = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${g.result.file_path}`);
      if (!f.ok) return res.status(502).end();
      c = _mvCache[dir] = { fid: row.fid, buf: Buffer.from(await f.arrayBuffer()), mime: "video/mp4" };
    }
    const total = c.buf.length;
    res.setHeader("Content-Type", c.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (m && (m[1] || m[2])) {   // iPhone без Range видео не играет
      let start = m[1] ? parseInt(m[1], 10) : Math.max(0, total - parseInt(m[2], 10));
      let end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || start >= total) { res.setHeader("Content-Range", `bytes */${total}`); return res.status(416).end(); }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      return res.end(c.buf.subarray(start, end + 1));
    }
    res.setHeader("Content-Length", total);
    res.end(c.buf);
  } catch (e) { console.log("[mentorVideo]", e.message); res.status(500).end(); }
});

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
    const T = (v) => /^(true|да|yes|1|✅|✔|срочно|активн)/i.test(String(v || "").trim()); // флажок TRUE или текст Да/Yes/1
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
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    if (!data.ok) return res.json({ ok: false, error: niceError(logReal("telegram", data.description || "send failed")) });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    if (!data.ok) return res.json({ ok: false, error: niceError(logReal("telegram", data.description || "send failed")) });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    if (!data.ok) return res.json({ ok: false, error: niceError(logReal("telegram", data.description || "send failed")) });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

// --- Рассылка резюме через Brevo ---
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "contact@crabnorway.com";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "AMORE";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "15", 10);
// Необязательный общий потолок писем в день на ВСЕХ участников (защита тарифа Brevo).
// 0 = выключено. Задаётся переменной GLOBAL_DAILY_LIMIT на Railway.
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || "0", 10);
const guestSends = {}; // uid -> кол-во отправок гостя (в памяти, мгновенно; сбрасывается при редеплое)

// Таблица дневных счётчиков отправки. Ключ user_id — строка (реальный id или 'GLOBAL').
if (pgPool) {
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS send_counters (user_id TEXT NOT NULL, day DATE NOT NULL, cnt INT NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))"
  ).catch((e) => console.log("send_counters init:", e.message));
  // Кому уже отправляли (чтобы массовая рассылка не слала повторно и продолжалась с места остановки).
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS sent_targets (user_id TEXT NOT NULL, target TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, target))"
  ).catch((e) => console.log("sent_targets init:", e.message));
  // Пользователи приложения — кому шлём уведомления о вакансиях.
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS app_users (user_id TEXT PRIMARY KEY, notify BOOLEAN NOT NULL DEFAULT TRUE, added TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("app_users init:", e.message));
  // Уже увиденные вакансии — чтобы уведомлять только о новых.
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS seen_vacancies (vkey TEXT PRIMARY KEY, role TEXT, direction TEXT, company TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("seen_vacancies init:", e.message));
  // Счётчик уведомлений в день на пользователя (лимит 3).
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS notif_counters (user_id TEXT NOT NULL, day DATE NOT NULL, cnt INT NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))"
  ).catch((e) => console.log("notif_counters init:", e.message));
  // Автопилот рассылки: кто включил, его почта/шаблон/язык/резюме.
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS autopilot (user_id TEXT PRIMARY KEY, reply_to TEXT, reply_name TEXT, subject TEXT, body TEXT, lang TEXT, cv_b64 TEXT, cv_name TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE, created TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_run DATE)"
  ).catch((e) => console.log("autopilot init:", e.message));
  // Ответы работодателей внутри AMORE: псевдоним каждому + входящие письма.
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS mail_aliases (user_id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, real_email TEXT, display_name TEXT, copy_to_real BOOLEAN NOT NULL DEFAULT TRUE, created TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("mail_aliases init:", e.message));
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS user_cv (user_id TEXT PRIMARY KEY, cv_b64 TEXT NOT NULL, cv_name TEXT NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("user_cv init:", e.message));
  // Данные конструктора резюме (поля, опыт, языки, фото) — чтобы человек после рейса мог открыть и отредактировать
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS user_cv_data (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("user_cv_data init:", e.message));
  // «Мой путь» участника: выбранное направление + прогресс по шагам (JSON)
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS member_path (user_id TEXT PRIMARY KEY, direction TEXT, data TEXT NOT NULL DEFAULT '{}', updated TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("member_path init:", e.message));
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS welcome_sent (user_id TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch((e) => console.log("welcome_sent init:", e.message));
  // Брошенная оплата: человек нажал «Оплатить» в апке. Бот ведёт цепочку, пока не придёт оплата.
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS pay_intents (id SERIAL PRIMARY KEY, tg_id BIGINT NOT NULL, plan TEXT, src TEXT NOT NULL DEFAULT '', " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ NULL, step_sent INT NOT NULL DEFAULT 0, answer TEXT NULL, " +
    "paid_after_step INT NULL, last_sent_at TIMESTAMPTZ NULL)"
  ).then(() => pgPool.query("CREATE INDEX IF NOT EXISTS pay_intents_open ON pay_intents (tg_id) WHERE paid_at IS NULL"))
   .catch((e) => console.log("pay_intents init:", e.message));
  // Онбординг после оплаты: день 1 / 3 / 7 — отправляет бот
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS onboarding (user_id BIGINT PRIMARY KEY, paid_at TIMESTAMPTZ NOT NULL, src TEXT NOT NULL DEFAULT '', " +
    "d1_sent BOOLEAN NOT NULL DEFAULT FALSE, d3_sent BOOLEAN NOT NULL DEFAULT FALSE, d7_sent BOOLEAN NOT NULL DEFAULT FALSE)"
  ).catch((e) => console.log("onboarding init:", e.message));
  pgPool.query("ALTER TABLE member_path ADD COLUMN IF NOT EXISTS created TIMESTAMPTZ NOT NULL DEFAULT NOW()").catch(() => {});
  pgPool.query(
    "CREATE TABLE IF NOT EXISTS inbox (id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'in', from_email TEXT, from_name TEXT, to_email TEXT, subject TEXT, body TEXT, message_id TEXT, in_reply_to TEXT, has_attachments BOOLEAN NOT NULL DEFAULT FALSE, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), read BOOLEAN NOT NULL DEFAULT FALSE)"
  ).then(() => pgPool.query("ALTER TABLE inbox ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE"))
   .then(() => pgPool.query("ALTER TABLE inbox ADD COLUMN IF NOT EXISTS digested BOOLEAN NOT NULL DEFAULT FALSE"))
   .catch((e) => console.log("inbox init:", e.message));
}

// Атомарно «резервирует» одно письмо в дневном счётчике ДО отправки.
// Возвращает {ok:true,count} если в пределах лимита, иначе {ok:false,count}.
// Инкремент происходит только если текущий счётчик < cap — поэтому burst-рассылка не перепрыгнет лимит.
async function reserveSend(key, cap, day) {
  const q = "INSERT INTO send_counters (user_id, day, cnt) VALUES ($1,$2,1) " +
    "ON CONFLICT (user_id, day) DO UPDATE SET cnt = send_counters.cnt + 1 " +
    "WHERE send_counters.cnt < $3 RETURNING cnt";
  const r = await pgPool.query(q, [String(key), day, cap]);
  if (r.rows.length) return { ok: true, count: r.rows[0].cnt };
  const cur = await pgPool.query("SELECT cnt FROM send_counters WHERE user_id=$1 AND day=$2", [String(key), day]);
  return { ok: false, count: cur.rows.length ? cur.rows[0].cnt : cap };
}
// Возвращает резерв обратно, если письмо в итоге не ушло (ошибка Brevo и т.п.).
async function refundSend(key, day) {
  try { await pgPool.query("UPDATE send_counters SET cnt = GREATEST(cnt-1,0) WHERE user_id=$1 AND day=$2", [String(key), day]); } catch (e) {}
}

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

/* ================== ПСЕВДОНИМЫ ДЛЯ ОТВЕТОВ РАБОТОДАТЕЛЕЙ ================== */
// Ответ работодателя идёт не на личную почту моряка, а на u<id>@reply.<домен>.
// Postmark ловит письмо и шлёт нам в /inboundMail → бот уведомляет человека.
const REPLY_DOMAIN = process.env.REPLY_DOMAIN || "reply.crabnorway.com";
const INBOUND_KEY = process.env.INBOUND_KEY;

// Вернёт { alias, name } — псевдоним для reply-to. Если базы нет — null (fallback на личную почту).
async function getReplyAlias(userId, realEmail, displayName) {
  if (!pgPool) return null;
  try {
    const alias = "u" + String(userId) + "@" + REPLY_DOMAIN;
    await pgPool.query(
      "INSERT INTO mail_aliases (user_id, alias, real_email, display_name) VALUES ($1,$2,$3,$4) " +
      "ON CONFLICT (user_id) DO UPDATE SET real_email=COALESCE(NULLIF($3,''), mail_aliases.real_email), display_name=COALESCE(NULLIF($4,''), mail_aliases.display_name)",
      [String(userId), alias, String(realEmail || ""), String(displayName || "").slice(0, 80)]
    );
    return { alias, name: String(displayName || "").slice(0, 80) };
  } catch (e) { logReal("getReplyAlias", e); return null; }
}

// Отправитель письма. SEND_FROM_ALIAS=1 → From = псевдоним моряка (u<id>@reply.<домен>).
// Тогда к нам в бота прилетают и автоответы («в отпуске», «не в офисе») — они идут на From, а не на Reply-To.
// Требует, чтобы reply.<домен> был подтверждён в Brevo (DKIM). Без переменной — как раньше, From = MAIL_FROM.
const SEND_FROM_ALIAS = String(process.env.SEND_FROM_ALIAS || "") === "1";
function senderFor(aliasInfo, displayName) {
  if (SEND_FROM_ALIAS && aliasInfo && aliasInfo.alias) {
    return { name: String(displayName || aliasInfo.name || MAIL_FROM_NAME).slice(0, 80), email: aliasInfo.alias };
  }
  return { name: MAIL_FROM_NAME, email: MAIL_FROM };
}

app.post("/sendApplication", async (req, res) => {
  try {
    if (!BREVO_API_KEY) return res.json({ ok: false, error: "BREVO_API_KEY not set" });
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);

    const b = req.body || {};
    // Массовая рассылка (флаг mass:true) — только для купивших отдельную подписку на рассылку.
    const wantMass = (b.mass === true || b.mass === "true");
    if (wantMass) {
      if (!m.member) return res.json({ ok: false, error: "members only" });
      const hasMass = await getMassAccessCached(user.id);
      if (hasMass === null) return res.json({ ok: false, error: "Не удалось проверить подписку. Попробуй через минуту." });
      if (!hasMass) return res.json({ ok: false, massRequired: true });
    }
    let to = String(b.to || "").trim();

    // Отклик по id вакансии: почту берём на СЕРВЕРЕ (гость её не получает в /vacancies).
    // Это же защищает от использования твоего домена для спама на произвольные адреса.
    if (b.vacId !== undefined && b.vacId !== null && b.vacId !== "") {
      const ordered = await fetchVacanciesOrdered();
      const vv = ordered[Number(b.vacId)];
      if (!vv || !vv.email) return res.json({ ok: false, error: "vacancy has no email" });
      to = String(vv.email).trim();
    } else if (!m.member) {
      // Гость может слать только на ОТКРЫТЫЕ ему контакты базы (первые 5) или на реальную вакансию.
      // Это разрешает бесплатный отклик из базы, но не даёт слать на произвольный адрес.
      let allowed = false;
      try {
        const raw = await getRawContacts();
        const openEmails = raw.slice(0, 5)
          .map((c) => String(c.email || "").trim().toLowerCase())
          .filter(Boolean);
        if (to && openEmails.indexOf(to.toLowerCase()) >= 0) allowed = true;
      } catch (e) {}
      if (!allowed) return res.json({ ok: false, error: niceError("guests can only apply to open contacts") });
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
    var dayKey = todayStr();
    var reservedUser = false, reservedGlobal = false;
    if (m.member) {
      capLimit = DAILY_LIMIT;
      if (pgPool) {
        // ЖЁСТКИЙ дневной лимит: резервируем счётчик в Postgres ДО отправки.
        // Защищает от burst-рассылки и переживает передеплой бэка.
        if (GLOBAL_DAILY_LIMIT > 0) {
          const g = await reserveSend("GLOBAL", GLOBAL_DAILY_LIMIT, dayKey);
          if (!g.ok) return res.json({ ok: false, limit: true, globalLimit: true, used: g.count, max: GLOBAL_DAILY_LIMIT });
          reservedGlobal = true;
        }
        const u = await reserveSend(user.id, DAILY_LIMIT, dayKey);
        if (!u.ok) {
          if (reservedGlobal) await refundSend("GLOBAL", dayKey);
          return res.json({ ok: false, limit: true, used: u.count, max: DAILY_LIMIT });
        }
        reservedUser = true;
        usedCount = u.count - 1; // сколько было ДО этого письма (для remaining)
      } else {
        // запасной вариант без базы: мягкий счётчик из Brevo (с задержкой)
        usedCount = await countTodaySends(tag);
        if (usedCount >= DAILY_LIMIT) return res.json({ ok: false, limit: true, used: usedCount, max: DAILY_LIMIT });
      }
    } else {
      // гость: 3 отклика всего. Brevo считает с задержкой, поэтому держим мгновенный счётчик в памяти и берём максимум.
      const brevoCount = await countSendsSince(tag, 90);
      usedCount = Math.max(brevoCount, guestSends[user.id] || 0);
      capLimit = GUEST_LIMIT;
      if (usedCount >= GUEST_LIMIT) return res.json({ ok: false, guestLimit: true, used: usedCount, max: GUEST_LIMIT });
    }

    // reply-to → псевдоним на нашем домене (ответ работодателя придёт в AMORE), личная почта — в базе.
    const aliasInfo = await getReplyAlias(user.id, replyTo, b.replyName || user.first_name || "");
    const rtEmail = aliasInfo ? aliasInfo.alias : replyTo;
    const rtName = (b.replyName ? String(b.replyName).slice(0, 80) : (aliasInfo && aliasInfo.name) || "");
    const payload = {
      sender: senderFor(aliasInfo, rtName),
      to: [{ email: to }],
      replyTo: (rtName ? { email: rtEmail, name: rtName } : { email: rtEmail }),
      subject: subject.slice(0, 200),
      textContent: text,
      tags: [tag],
    };
    if (b.cvBase64 && b.cvName) {
      payload.attachment = [{ content: String(b.cvBase64), name: String(b.cvName).slice(0, 80) }];
    }
    let data;
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST", headers: brevoHeaders(), body: JSON.stringify(payload),
      });
      data = await r.json();
      if (!r.ok || !data.messageId) throw new Error((data && (data.message || data.code)) || "send failed");
    } catch (sendErr) {
      // письмо не ушло — возвращаем зарезервированный счётчик обратно
      if (reservedUser) await refundSend(user.id, dayKey);
      if (reservedGlobal) await refundSend("GLOBAL", dayKey);
      const raw = logReal("sendApplication", sendErr);
      alertOwner("отправка резюме", raw);
      return res.json({ ok: false, error: niceError(raw) });
    }
    if (!m.member) guestSends[user.id] = usedCount + 1;
    // запоминаем адрес, чтобы массовая рассылка не слала повторно
    if (pgPool && to) {
      pgPool.query("INSERT INTO sent_targets (user_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING", [String(user.id), String(to).toLowerCase()]).catch(function(){});
      // и само письмо — в историю переписки
      pgPool.query("INSERT INTO inbox (user_id, direction, from_email, to_email, subject, body, message_id, read) VALUES ($1,'out',$2,$3,$4,$5,$6,TRUE)",
        [String(user.id), rtEmail, String(to).toLowerCase(), subject.slice(0, 200), text.slice(0, 20000), String(data.messageId || "")]).catch(function(){});
    }
    res.json({ ok: true, messageId: data.messageId, remaining: Math.max(0, capLimit - (usedCount + 1)), guest: !m.member });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
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
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

// --- Отправка готового резюме файлом в чат с ботом (надёжно на iOS, где скачивание в Telegram заблокировано) ---
app.post("/sendResumeFile", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const b = req.body || {};
    const b64 = String(b.fileBase64 || "");
    const name = String(b.fileName || "CV.pdf").replace(/[^\w.\-]/g, "_").slice(0, 80);
    if (!b64) return res.json({ ok: false, error: "no file" });
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > 8 * 1024 * 1024) return res.json({ ok: false, error: "bad file size" });

    const form = new FormData();
    form.append("chat_id", String(user.id));
    form.append("document", new Blob([buf]), name);
    form.append("caption", "📄 Твоё резюме AMORE. Сохрани файл или перешли работодателю.");
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: niceError(logReal("telegram", data.description || "send failed")) });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

// Список адресов, кому этот участник уже отправлял (для очереди массовой рассылки)
app.post("/massTargets", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, targets: [] });
    const r = await pgPool.query("SELECT target FROM sent_targets WHERE user_id=$1", [String(user.id)]);
    res.json({ ok: true, targets: r.rows.map(function (x) { return x.target; }) });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

/* ================== УВЕДОМЛЕНИЯ О НОВЫХ ВАКАНСИЯХ ================== */
const NOTIF_DAILY_LIMIT = parseInt(process.env.NOTIF_DAILY_LIMIT || "3", 10); // максимум уведомлений в день на человека
const VACANCY_POLL_MIN = parseInt(process.env.VACANCY_POLL_MIN || "10", 10);  // как часто проверять таблицу вакансий (минут)

function vacKey(v) {
  return crypto.createHash("sha1")
    .update([v.role, v.company, v.direction, v.phone, v.email, v.date].join("|"))
    .digest("hex");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Прямая ссылка на мини-аппку (короткое имя настроено в BotFather).
// При необходимости переопределяется переменной WEBAPP_URL на Railway.
const WEBAPP_URL = process.env.WEBAPP_URL || "https://t.me/Crabnorwaybot/amore";

// Отправка сообщения пользователю с кнопкой «Зайти в AMORE».
// Если человек заблокировал бота — выключаем ему уведомления.
async function tgNotify(chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🚢 Зайти в AMORE", url: WEBAPP_URL }]] },
      }),
    });
    const d = await r.json();
    if (!d.ok) {
      const desc = String(d.description || "");
      if (/blocked|deactivated|chat not found|kicked/i.test(desc) && pgPool) {
        pgPool.query("UPDATE app_users SET notify=FALSE WHERE user_id=$1", [String(chatId)]).catch(function () {});
      }
      return false;
    }
    return true;
  } catch (e) { return false; }
}

// Резервируем уведомление в дневном лимите (3/день). false = лимит исчерпан.
async function reserveNotif(userId, day) {
  if (!pgPool) return true;
  try {
    const r = await pgPool.query(
      "INSERT INTO notif_counters (user_id, day, cnt) VALUES ($1,$2,1) " +
      "ON CONFLICT (user_id, day) DO UPDATE SET cnt = notif_counters.cnt + 1 " +
      "WHERE notif_counters.cnt < $3 RETURNING cnt",
      [String(userId), day, NOTIF_DAILY_LIMIT]
    );
    return r.rows.length > 0;
  } catch (e) { return false; }
}

async function getNotifyUsers() {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query("SELECT user_id FROM app_users WHERE notify=TRUE");
    return r.rows.map((x) => x.user_id);
  } catch (e) { return []; }
}

function vacancyText(v) {
  let t = "🚢 <b>Новая вакансия</b>\n\n";
  t += "<b>" + htmlEsc(v.role) + "</b>\n";
  const line = [v.company, v.direction].filter(Boolean).map(htmlEsc).join(" · ");
  if (line) t += "📍 " + line + "\n";
  if (v.pay) t += "💰 " + htmlEsc(v.pay) + "\n";
  if (v.when) t += "🕒 " + htmlEsc(v.when) + "\n";
  if (v.urgent) t += "🔴 Срочно\n";
  t += "\n📲 Контакты — в приложении";
  return t;
}

// Рассылка одной вакансии всем, у кого не исчерпан дневной лимит
async function notifyVacancy(v) {
  const users = await getNotifyUsers();
  if (!users.length) return 0;
  const day = todayStr();
  const text = vacancyText(v);
  let sent = 0;
  for (const uid of users) {
    const allowed = await reserveNotif(uid, day);
    if (!allowed) continue;             // у человека уже 3 уведомления сегодня
    const ok = await tgNotify(uid, text);
    if (ok) sent++;
    await sleep(60);                    // не упираемся в лимиты Telegram
  }
  return sent;
}

// Проверка новых вакансий. Первый запуск только запоминает текущие (без рассылки).
let vacWatchBusy = false;
async function checkNewVacancies() {
  if (!pgPool || !VACANCIES_CSV_URL || vacWatchBusy) return;
  vacWatchBusy = true;
  try {
    const all = await fetchVacancies();
    if (!all.length) return;

    const cnt = await pgPool.query("SELECT COUNT(*)::int AS c FROM seen_vacancies");
    const firstRun = cnt.rows[0].c === 0;

    const fresh = [];
    for (const v of all) {
      const k = vacKey(v);
      const r = await pgPool.query(
        "INSERT INTO seen_vacancies (vkey, role, direction, company) VALUES ($1,$2,$3,$4) ON CONFLICT (vkey) DO NOTHING RETURNING vkey",
        [k, v.role || "", v.direction || "", v.company || ""]
      );
      if (r.rows.length) fresh.push(v);
    }

    if (firstRun) { console.log("вакансии: первичная индексация,", all.length, "шт. — уведомления не шлём"); return; }
    if (!fresh.length) return;

    console.log("новых вакансий:", fresh.length);
    for (const v of fresh) { await notifyVacancy(v); }
  } catch (e) {
    console.log("checkNewVacancies:", e.message);
  } finally {
    vacWatchBusy = false;
  }
}

if (pgPool && VACANCIES_CSV_URL) {
  setTimeout(checkNewVacancies, 20000); // первый прогон через 20 сек после старта
  setInterval(checkNewVacancies, Math.max(2, VACANCY_POLL_MIN) * 60000);
}

// Сводка за сегодня: сколько вакансий добавлено и по каким направлениям (только админ)
app.post("/vacancyDigest", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);
    if (!m.admin) return res.json({ ok: false, error: "not admin" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });

    const r = await pgPool.query(
      "SELECT COALESCE(NULLIF(direction,''),'другое') AS dir, COUNT(*)::int AS c " +
      "FROM seen_vacancies WHERE first_seen::date = CURRENT_DATE GROUP BY 1 ORDER BY c DESC"
    );
    const rows = r.rows;
    const total = rows.reduce((s, x) => s + x.c, 0);
    if (!total) return res.json({ ok: true, total: 0, sent: 0, preview: "Сегодня новых вакансий не добавлено." });

    let text = "⚓️ <b>Сегодня в AMORE добавили " + total + " " + (total === 1 ? "вакансию" : "вакансий") + "</b>\n\n";
    rows.forEach((x) => { text += "• " + htmlEsc(x.dir) + " — " + x.c + "\n"; });
    text += "\nКонтакты работодателей и отклик — в приложении. Пора заходить 👇";

    if (req.body.preview) return res.json({ ok: true, total: total, preview: text });

    const users = await getNotifyUsers();
    let sent = 0;
    for (const uid of users) {
      const ok = await tgNotify(uid, text);   // сводка идёт мимо лимита 3/день — ты шлёшь её вручную
      if (ok) sent++;
      await sleep(60);
    }
    res.json({ ok: true, total: total, sent: sent });
  } catch (e) {
    res.json({ ok: false, error: niceError(logReal("server", e)) });
  }
});

// --- Понятные сообщения об ошибках -------------------------------------
// Пользователь НИКОГДА не видит технический текст (IP, ссылки, английские ответы
// чужих сервисов). Настоящая ошибка пишется в логи Railway и падает владельцу в личку.
function logReal(where, e) {
  const msg = (e && e.message) ? e.message : String(e);
  console.log("[" + where + "]", msg);
  return msg;
}
let lastOwnerAlert = 0;
async function alertOwner(where, rawMsg) {
  try {
    if (!OWNER_ID) return;
    if (Date.now() - lastOwnerAlert < 10 * 60000) return; // не чаще раза в 10 минут
    lastOwnerAlert = Date.now();
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: OWNER_ID,
        text: "⚠️ <b>Сбой в AMORE</b>\n\nМесто: " + htmlEsc(where) + "\nПричина: " + htmlEsc(String(rawMsg).slice(0, 300)),
        parse_mode: "HTML",
      }),
    });
  } catch (e) {}
}
// Превращает любую техническую ошибку в человеческий текст
function niceError(rawMsg) {
  const s = String(rawMsg || "").toLowerCase();
  if (/unrecognised ip|unauthorized ip|authorised_ips|ip address/.test(s))
    return "Почтовый сервис временно не принимает отправку. Мы уже знаем о проблеме — попробуй через несколько минут.";
  if (/quota|limit|credits|too many/.test(s))
    return "Сегодня лимит отправки исчерпан. Попробуй завтра.";
  if (/api-key|api key|unauthorized|forbidden|401|403/.test(s))
    return "Почтовый сервис временно недоступен. Мы уже разбираемся — попробуй чуть позже.";
  if (/timeout|network|fetch failed|socket|econn/.test(s))
    return "Не получилось связаться с сервером. Проверь интернет и попробуй ещё раз.";
  if (/bad email|invalid email|recipient/.test(s))
    return "Похоже, у этого работодателя указана некорректная почта. Напиши ему другим способом.";
  return "Что-то пошло не так. Попробуй ещё раз, а если повторится — напиши в поддержку.";
}

/* ================== АВТОПИЛОТ РАССЫЛКИ ================== */
const INTERNAL_KEY = process.env.INTERNAL_KEY; // общий секрет бот↔бэкенд (в переменных Railway)

// Проверяет внутренний ключ бота. Без него серверную рассылку дёрнуть нельзя.
function botAuthed(req) {
  return INTERNAL_KEY && req.body && req.body.key === INTERNAL_KEY;
}

// Один почтовый отправитель за конкретного user_id (для автопилота, без initData).
// Переиспользует лимит 15/день и очередь sent_targets. Возвращает {ok|limit|skip|error}.
async function autopilotSendOne(userId, ap, to, company) {
  const tag = "uid_" + userId;
  const dayKey = todayStr();
  // жёсткий дневной лимит
  const rsv = await reserveSend(userId, DAILY_LIMIT, dayKey);
  if (!rsv.ok) return { limit: true };
  let subject = String(ap.subject || "").replace(/\{company\}/g, company || "your company").slice(0, 200);
  let text = String(ap.body || "").replace(/\{company\}/g, company || "your company");
  if (/_{2,}/.test(subject + text)) {
    // старые шаблоны с пустым «___» — подставляем имя (из подписи ответа или из базы бота)
    let nm = String(ap.reply_name || "").trim();
    if (!nm) { try { const u = await pgPool.query("SELECT full_name FROM users WHERE user_id=$1", [Number(userId)]); nm = String((u.rows[0] && u.rows[0].full_name) || "").trim(); } catch (e) {} }
    if (nm) { subject = subject.replace(/_{2,}/g, nm); text = text.replace(/_{2,}/g, nm); }
    else { text = text.replace(/My name is _{2,}\s*(and\s*)?/i, "").replace(/Mitt navn er _{2,}\s*(og\s*)?/i, "").replace(/_{2,}/g, ""); subject = subject.replace(/_{2,}/g, "").trim(); }
  }
  const aliasInfo = await getReplyAlias(userId, ap.reply_to, ap.reply_name || "");
  const rtEmail = aliasInfo ? aliasInfo.alias : ap.reply_to;
  const payload = {
    sender: senderFor(aliasInfo, ap.reply_name),
    to: [{ email: to }],
    replyTo: (ap.reply_name ? { email: rtEmail, name: String(ap.reply_name).slice(0, 80) } : { email: rtEmail }),
    subject, textContent: text, tags: [tag],
  };
  if (ap.cv_b64 && ap.cv_name) payload.attachment = [{ content: String(ap.cv_b64), name: String(ap.cv_name).slice(0, 80) }];
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: brevoHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(25000) });
    const data = await r.json();
    if (!r.ok || !data.messageId) throw new Error((data && (data.message || data.code)) || "send failed");
    try {
      await pgPool.query("INSERT INTO sent_targets (user_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING", [String(userId), String(to).trim().toLowerCase()]);
    } catch (e) { logReal("autopilot sent_targets", e); alertOwner("автопилот: не записался sent_targets", e.message); }
    try {
      await pgPool.query("INSERT INTO inbox (user_id, direction, from_email, to_email, subject, body, message_id, read) VALUES ($1,'out',$2,$3,$4,$5,$6,TRUE)",
        [String(userId), rtEmail, String(to).trim().toLowerCase(), subject, text.slice(0, 20000), String(data.messageId || "")]);
    } catch (e) { logReal("autopilot inbox", e); }
    return { ok: true };
  } catch (e) {
    await refundSend(userId, dayKey); // не ушло — вернуть лимит
    return { error: logReal("autopilot send", e) };
  }
}

// Включить автопилот (из апки, участник с активной подпиской на рассылку)
app.post("/autopilotOn", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    const m = await getMembershipCached(user.id);
    if (!m.member) return res.json({ ok: false, error: "members only" });
    if ((await getTrialState(user.id)).active) return res.json({ ok: false, trial: true, error: "Авторассылка откроется после активации подписки." });
    const hasMass = await getMassAccessCached(user.id);
    if (hasMass === null) return res.json({ ok: false, error: "Не удалось проверить подписку. Попробуй через минуту." });
    if (!hasMass) return res.json({ ok: false, massRequired: true });
    if (!pgPool) return res.json({ ok: false, error: "no db" });

    const b = req.body || {};
    const replyTo = String(b.replyTo || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) return res.json({ ok: false, error: "bad reply email" });
    if (!b.subject || !b.body) return res.json({ ok: false, error: "no template" });
    if (/_{2,}/.test(String(b.subject) + String(b.body))) return res.json({ ok: false, error: "В письме осталось пустое место «___» — впиши имя." });
    if (!b.cvBase64 || !b.cvName) return res.json({ ok: false, error: "no cv" });

    await pgPool.query(
      "INSERT INTO autopilot (user_id, reply_to, reply_name, subject, body, lang, cv_b64, cv_name, enabled) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) " +
      "ON CONFLICT (user_id) DO UPDATE SET reply_to=$2, reply_name=$3, subject=$4, body=$5, lang=$6, cv_b64=$7, cv_name=$8, enabled=TRUE",
      [String(user.id), replyTo, String(b.replyName || "").slice(0, 80), String(b.subject).slice(0, 200),
       String(b.body).slice(0, 4000), String(b.lang || "en"), String(b.cvBase64), String(b.cvName).slice(0, 80)]
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("autopilotOn", e)) }); }
});

// Выключить автопилот
app.post("/autopilotOff", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (pgPool) await pgPool.query("UPDATE autopilot SET enabled=FALSE WHERE user_id=$1", [String(user.id)]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("autopilotOff", e)) }); }
});

// Статус автопилота (для кнопки в апке)
app.post("/autopilotStatus", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, enabled: false });
    const r = await pgPool.query("SELECT enabled FROM autopilot WHERE user_id=$1", [String(user.id)]);
    res.json({ ok: true, enabled: r.rows.length ? !!r.rows[0].enabled : false });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("autopilotStatus", e)) }); }
});

// БОТ дёргает утром: запустить рассылку для всех с включённым автопилотом.
// Отвечает СРАЗУ, а прогон идёт в фоне (не зависит от таймаута бота, выдержит любое число юзеров).
let autopilotRunning = false, autopilotRunningSince = 0;
const autopilotLast = { finishedAt: null, summary: "", error: "", startedAt: null, trigger: "" };
async function autopilotRunAll(onlyUser) {
  if (autopilotRunning) {
    // прогон мог зависнуть (сеть, Brevo, Telegram без ответа) — тогда флаг держал бы все следующие дни. Через 3 часа считаем его мёртвым.
    if (Date.now() - autopilotRunningSince < 3 * 3600000) { console.log("[autopilot] прогон уже идёт с", new Date(autopilotRunningSince).toISOString()); return; }
    console.log("[autopilot] предыдущий прогон завис — сбрасываю флаг и запускаю заново");
    alertOwner("автопилот", "предыдущий прогон завис и был сброшен через 3 часа — запускаю заново");
  }
  autopilotRunning = true; autopilotRunningSince = Date.now(); autopilotLast.startedAt = new Date().toISOString(); autopilotLast.error = "";
  try {
    let rows;
    if (onlyUser) {
      rows = (await pgPool.query("SELECT * FROM autopilot WHERE enabled=TRUE AND user_id=$1", [String(onlyUser)])).rows;
    } else {
      rows = (await pgPool.query("SELECT * FROM autopilot WHERE enabled=TRUE")).rows;
    }
    const todayOslo = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" }); // YYYY-MM-DD
    let totalSent = 0, totalErr = 0, firstErr = "", usersDone = 0; const pausedNoAmore = [], skippedTg = [];
    for (const ap of rows) {
      const uid = ap.user_id;
      // уже отработан сегодня (например, прогон возобновился после перезапуска) — пропускаем
      const lr = ap.last_run ? new Date(ap.last_run).toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" }) : "";
      if (lr === todayOslo && !onlyUser) continue;
      const hasMass = await getMassAccessCached(uid);
      if (hasMass === null) { console.log("[autopilot]", uid, "Telegram не ответил — пропускаю сегодня, не выключаю"); skippedTg.push(uid); continue; }
      if (hasMass === false) { await pgPool.query("UPDATE autopilot SET enabled=FALSE WHERE user_id=$1", [uid]); await notifyAutopilotOff(uid); continue; }
      // рассылка — дополнение к AMORE: нет действующей подписки AMORE → пауза (enabled остаётся, после продления пойдёт само)
      const am = await getMembershipCached(uid).catch(() => ({ unknown: true }));
      if (am && am.unknown) { console.log("[autopilot]", uid, "AMORE: Telegram не ответил — пропускаю сегодня"); skippedTg.push(uid); continue; }
      if (!am || !am.member) {
        pausedNoAmore.push(uid);
        await pgPool.query("ALTER TABLE autopilot ADD COLUMN IF NOT EXISTS paused_notified DATE").catch(function () {});
        const pn = await pgPool.query("SELECT paused_notified FROM autopilot WHERE user_id=$1", [uid]).catch(() => ({ rows: [] }));
        const last = pn.rows[0] && pn.rows[0].paused_notified ? new Date(pn.rows[0].paused_notified) : null;
        if (!last || (new Date() - last) > 6 * 86400000) { // напоминаем раз в неделю, не каждый день
          await notifyAutopilotOff(uid, "amore");
          await pgPool.query("UPDATE autopilot SET paused_notified=NOW() WHERE user_id=$1", [uid]).catch(function () {});
        }
        console.log("[autopilot]", uid, "нет подписки AMORE — пауза");
        continue;
      }

      const norm = (e) => String(e || "").trim().toLowerCase();
      const sent = new Set((await pgPool.query("SELECT target FROM sent_targets WHERE user_id=$1", [uid])).rows.map((x) => norm(x.target)));
      // страховка: всё, что когда-либо уходило этому человеку по почте (inbox out), тоже считаем отправленным
      try { (await pgPool.query("SELECT to_email FROM inbox WHERE user_id=$1 AND direction='out'", [uid])).rows.forEach((x) => { if (x.to_email) sent.add(norm(x.to_email)); }); } catch (e) {}
      let raw = [];
      try { raw = await getRawContacts(); } catch (e) {
        alertOwner("автопилот", "не смог получить базу контактов — прогон остановлен: " + (e && e.message));
        console.log("[autopilot] база недоступна, прогон остановлен");
        break; // без базы продолжать бессмысленно; возобновление подхватит позже
      }
      // в очередь — только настоящие адреса: ссылки на фейсбук, пробелы и опечатки в колонке Email раньше считались ошибками и останавливали прогон
      const EMAIL_RX = /^[^\s@\/]+@[^\s@\/]+\.[a-z]{2,}$/i;
      const queue = raw.filter((c) => norm(c.email) && EMAIL_RX.test(String(c.email).trim()) && !sent.has(norm(c.email)));
      const skippedBad = raw.filter((c) => norm(c.email) && !EMAIL_RX.test(String(c.email).trim())).length;
      console.log("[autopilot]", uid, "уже отправлено:", sent.size, "в очереди:", queue.length, "кривых адресов пропущено:", skippedBad);
      if (sent.size === 0) { console.log("[autopilot] ВНИМАНИЕ: у", uid, "пустая история отправок"); alertOwner("автопилот", "у пользователя " + uid + " пустая история sent_targets — проверь /autopilot_debug"); }

      let sentCount = 0, errCount = 0, quotaHit = false, streak = 0, userErr = "";
      for (const c of queue) {
        const r = await autopilotSendOne(uid, ap, String(c.email).trim(), c.company || c.vessel || "");
        if (r.limit) break;
        if (r.ok) { sentCount++; streak = 0; }
        else if (r.error) {
          errCount++; streak++; if (!firstErr) firstErr = String(r.error).slice(0, 200); if (!userErr) userErr = String(r.error).slice(0, 200);
          // квота Brevo исчерпана — дальше бессмысленно для всех: останавливаем весь прогон и бьём тревогу сразу
          if (/quota|limit|credits|too many|daily/i.test(String(r.error))) { quotaHit = true; break; }
          // останавливаем только при 10 ошибках ПОДРЯД (значит, сломано что-то общее — ключ, домен, письмо), а не из-за пары плохих адресов
          if (streak >= 10) break;
        }
        await sleep(1500);
      }
      // ничего не ушло, хотя очередь была — скажем честно и человеку, и владельцу, а не молчим
      if (sentCount === 0 && queue.length > 0) {
        const why = userErr ? ("Ошибка: " + userErr) : "Причина неизвестна — проверь /autopilot_debug";
        console.log("[autopilot]", uid, "за сегодня 0 писем:", why);
        alertOwner("автопилот: 0 писем", "у пользователя " + uid + " сегодня не ушло ни одного письма (очередь " + queue.length + "). " + why);
        tgNotify(uid, "🤖 Сегодня авторассылка не смогла отправить письма — я уже передал Дане, разбираемся. Ничего делать не нужно, завтра пойдёт как обычно.").catch(function () {});
      }
      if (quotaHit) {
        lastOwnerAlert = 0; // этот алерт важнее антиспама
        alertOwner("Brevo: лимит писем исчерпан", "Автопилот остановлен на пользователе " + uid + " после " + (totalSent + sentCount) + " писем сегодня. Подними тариф Brevo — очередь догонит завтра. Ошибка: " + firstErr);
        console.log("[autopilot] квота Brevo исчерпана — прогон остановлен");
        break;
      }
      await pgPool.query("UPDATE autopilot SET last_run=CURRENT_DATE WHERE user_id=$1", [uid]);
      console.log("[autopilot]", uid, "отправлено:", sentCount, "ошибок:", errCount);
      if (sentCount > 0) await notifyAutopilotStarted(uid, sentCount);
      totalSent += sentCount; totalErr += errCount; usersDone++;
    }
    // итог владельцу — чтобы проблемы были видны в тот же день, а не от пользователей
    if (!onlyUser && OWNER_ID) {
      autopilotLast.summary = "пользователей " + usersDone + ", писем " + totalSent + ", ошибок " + totalErr + (firstErr ? ", первая ошибка: " + firstErr : "");
      const txt = "🤖 Автопилот: прогон завершён\nПользователей: " + usersDone + "\nПисем ушло: " + totalSent + "\nОшибок: " + totalErr + (firstErr ? "\nПервая ошибка: " + firstErr : "")
        + (pausedNoAmore.length ? "\nНа паузе (нет подписки AMORE): " + pausedNoAmore.join(", ") : "")
        + (skippedTg.length ? "\nПропущены (Telegram не ответил): " + skippedTg.join(", ") : "");
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: OWNER_ID, text: txt }) }).catch(function () {});
    }
  } catch (e) {
    logReal("autopilotRunAll", e);
    autopilotLast.error = (e && e.message) || String(e);
    alertOwner("автопилот: прогон упал", (e && e.message) || String(e));
  } finally {
    autopilotRunning = false; autopilotLast.finishedAt = new Date().toISOString();
  }
}

// Для бота: состояние автопилота — чтобы понять, почему не шлёт, без логов Railway
app.post("/autopilotStatus", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    let enabled = 0, dueToday = 0, ranToday = 0;
    if (pgPool) {
      const r = await pgPool.query("SELECT COUNT(*) FILTER (WHERE enabled)::int AS en, COUNT(*) FILTER (WHERE enabled AND (last_run IS NULL OR last_run < CURRENT_DATE))::int AS due, COUNT(*) FILTER (WHERE enabled AND last_run = CURRENT_DATE)::int AS ran FROM autopilot");
      enabled = r.rows[0].en; dueToday = r.rows[0].due; ranToday = r.rows[0].ran;
    }
    res.json({ ok: true, running: autopilotRunning, runningSince: autopilotRunning ? new Date(autopilotRunningSince).toISOString() : null,
      last: autopilotLast, brevoKey: !!BREVO_API_KEY, db: !!pgPool, massGroup: !!MASS_GROUP_ID, enabled, dueToday, ranToday,
      serverStartedAt: SERVER_STARTED_AT, nowOslo: new Date().toLocaleString("sv-SE", { timeZone: "Europe/Oslo" }) });
  } catch (e) { res.json({ ok: false, error: logReal("autopilotStatus", e) }); }
});
const SERVER_STARTED_AT = new Date().toISOString();

// Возобновление после перезапуска: если сейчас 09:00–15:00 по Осло и есть включённые, у кого сегодня не было прогона — догоняем.
async function autopilotResumeIfNeeded() {
  try {
    if (!pgPool || !BREVO_API_KEY) return;
    const hourOslo = parseInt(new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", hour12: false }), 10);
    if (hourOslo < 9 || hourOslo >= 15) return;
    const r = await pgPool.query("SELECT COUNT(*)::int AS n FROM autopilot WHERE enabled=TRUE AND (last_run IS NULL OR last_run < CURRENT_DATE)");
    if (r.rows[0].n > 0) { console.log("[autopilot] возобновляю прогон после перезапуска, пользователей:", r.rows[0].n); autopilotRunAll(null); }
  } catch (e) { logReal("autopilotResume", e); }
}
if (pgPool) setTimeout(autopilotResumeIfNeeded, 45000);
// Подогрев кэша контактов при старте (и повтор через минуту, если Google не ответил с первого раза)
setTimeout(function () { getRawContacts().then(function (c) { console.log("[contacts] прогрет кэш:", c.length); }).catch(function () { setTimeout(function () { getRawContacts().catch(function () {}); }, 60000); }); }, 5000);

// Уведомления пользователю от лица бэкенда (через Telegram Bot API напрямую)
async function notifyAutopilotStarted(uid, n) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(uid),
        text: "🚀 Автопилот запустил рассылку — сегодня твоё резюме уходит " + n + " работодателям.\n\nВечером пришлю, сколько открыли.",
        reply_markup: { inline_keyboard: [[{ text: "🚢 Открыть AMORE", url: WEBAPP_URL }]] } }),
    });
  } catch (e) {}
}
async function notifyAutopilotOff(uid, reason) {
  try {
    const text = reason === "amore"
      ? "🤖 Автопилот на паузе — подписка AMORE закончилась.\n\nРассылка работает только вместе с AMORE: продли подписку, и письма снова пойдут сами каждое утро, ничего заново включать не нужно."
      : "🤖 Автопилот выключен — подписка на рассылку закончилась.\n\nПродли, чтобы резюме снова уходило само каждое утро.";
    const kb = reason === "amore" ? { inline_keyboard: [[{ text: "Продлить AMORE", url: WEBAPP_URL + "?startapp=pay" }]] } : undefined;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(uid), text, reply_markup: kb }),
    });
  } catch (e) {}
}

app.post("/autopilotRun", async (req, res) => {
  if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  if (!pgPool || !BREVO_API_KEY) return res.json({ ok: false, error: "not ready" });
  autopilotRunAll(null);            // запускаем в фоне, НЕ ждём
  res.json({ ok: true, started: true });
});

// БОТ дёргает вечером/еженедельно: статистика за N дней по одному человеку (из Brevo).
app.post("/autopilotStats", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const uid = String(req.body.user_id || "");
    const days = Math.max(1, Math.min(30, parseInt(req.body.days || "1", 10)));
    if (!uid || !BREVO_API_KEY) return res.json({ ok: false, error: "bad params" });
    const tag = "uid_" + uid;
    const url = `https://api.brevo.com/v3/smtp/statistics/events?tags=${encodeURIComponent(tag)}&startDate=${daysAgoStr(days - 1)}&endDate=${todayStr()}&limit=2500`;
    const r = await fetch(url, { headers: brevoHeaders() });
    const data = await r.json();
    const ev = Array.isArray(data.events) ? data.events : [];
    const byMsg = {};
    ev.forEach(function (e) {
      const id = e.messageId || (e.email + "|" + e.date);
      if (!byMsg[id]) byMsg[id] = { sent: false, opened: false };
      if ((e.event || "") === "requests") byMsg[id].sent = true;
      if (/open/i.test(e.event || "")) byMsg[id].opened = true;
    });
    const msgs = Object.values(byMsg);
    const sent = msgs.filter((m) => m.sent).length || msgs.length;
    const opened = msgs.filter((m) => m.opened).length;
    res.json({ ok: true, sent, opened });
  } catch (e) { res.json({ ok: false, error: logReal("autopilotStats", e) }); }
});

// БОТ дёргает: список активных автопилотчиков (кому слать вечерние/недельные уведомления)
app.post("/autopilotUsers", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: true, users: [] });
    const r = await pgPool.query("SELECT user_id FROM autopilot WHERE enabled=TRUE");
    res.json({ ok: true, users: r.rows.map((x) => x.user_id) });
  } catch (e) { res.json({ ok: false, error: logReal("autopilotUsers", e) }); }
});

/* ================== ПРИЁМ ОТВЕТОВ РАБОТОДАТЕЛЕЙ (Postmark → сюда) ================== */
// Postmark присылает JSON письма на /inboundMail?key=INBOUND_KEY.
// Убираем цитирование прошлых писем, кладём в inbox, шлём человеку в бота.

function stripQuoted(text) {
  let t = String(text || "").replace(/\r/g, "");
  // обрезаем типовые начала цитаты ("On ... wrote:", "-----Original Message-----", строки с ">")
  const cut = [/\n\s*On .{0,200}wrote:\s*\n/i, /\n-{3,}\s*Original Message\s*-{3,}/i, /\n_{5,}\n/, /\nFrom: .{0,200}\nSent: /i, /\n>[^\n]*\n(>[^\n]*\n)*/];
  for (const re of cut) { const m = t.match(re); if (m && m.index > 0) t = t.slice(0, m.index); }
  return t.trim();
}

async function notifyInbound(uid, fromName, fromEmail, subject, body, inboxId, isAuto) {
  // В бота — только уведомление. Само письмо, перевод и ответ — на экране «Ответы работодателей» в приложении
  // (у гостя этот экран закрыт подпиской).
  const text = "📩 <b>Тебе ответил работодатель</b>\n\nПисьмо ждёт в приложении: там перевод на русский и помощь с ответом.";
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(uid), text, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "📩 Открыть ответ", url: WEBAPP_URL + "?startapp=inbox" }]] } }),
    });
  } catch (e) { logReal("notifyInbound", e); }
}

// Дублируем на личную почту, если человек это включил (по умолчанию — да).
async function forwardCopy(realEmail, fromName, fromEmail, subject, body) {
  if (!realEmail || !BREVO_API_KEY) return;
  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
        to: [{ email: realEmail }],
        replyTo: { email: fromEmail, name: fromName || fromEmail },
        subject: "[AMORE] Ответ работодателя: " + String(subject || "").slice(0, 150),
        textContent: "Работодатель " + (fromName || fromEmail) + " ответил на твой отклик.\n\n" + body + "\n\n— Копия из AMORE. Отвечать лучше через приложение — там перевод и помощь.",
        tags: ["inbound_copy"],
      }),
    });
  } catch (e) { logReal("forwardCopy", e); }
}

app.post("/inboundMail", async (req, res) => {
  // Postmark ждёт 200 быстро — отвечаем сразу, обработку делаем после.
  if (!INBOUND_KEY || String(req.query.key || "") !== INBOUND_KEY) return res.status(403).json({ ok: false });
  res.json({ ok: true });
  try {
    if (!pgPool) return;
    const m = req.body || {};
    // Куда пришло: ищем наш псевдоним среди получателей
    const rcpts = []
      .concat(m.ToFull || [], m.CcFull || [], m.BccFull || [])
      .map((x) => String((x && x.Email) || "").toLowerCase())
      .concat([String(m.OriginalRecipient || "").toLowerCase(), String(m.To || "").toLowerCase()]);
    const alias = rcpts.find((a) => a && a.endsWith("@" + REPLY_DOMAIN.toLowerCase()));
    if (!alias) { console.log("[inbound] no alias among recipients:", rcpts.join(",")); return; }

    const ar = await pgPool.query("SELECT user_id, real_email, copy_to_real FROM mail_aliases WHERE LOWER(alias)=$1", [alias]);
    if (!ar.rows.length) { console.log("[inbound] unknown alias:", alias); return; }
    const uid = ar.rows[0].user_id;

    const fromEmail = String((m.FromFull && m.FromFull.Email) || m.From || "").toLowerCase();
    const fromName = String((m.FromFull && m.FromFull.Name) || "").slice(0, 120);
    const subject = String(m.Subject || "").slice(0, 300);
    const rawBody = m.StrippedTextReply || m.TextBody || (m.HtmlBody ? String(m.HtmlBody).replace(/<[^>]+>/g, " ") : "");
    const body = stripQuoted(rawBody).slice(0, 20000);
    const hasAtt = Array.isArray(m.Attachments) && m.Attachments.length > 0;
    const msgId = String(m.MessageID || "");
    const headers = Array.isArray(m.Headers) ? m.Headers : [];
    const irt = (headers.find((h) => /^in-reply-to$/i.test(h.Name || "")) || {}).Value || "";

    // не шлём себе же (копии)
    if (fromEmail === MAIL_FROM.toLowerCase() || fromEmail.endsWith("@" + REPLY_DOMAIN.toLowerCase())) return;

    // автоответ («в отпуске», «не в офисе»)? Показываем человеку — это тоже сигнал, что письмо дошло.
    const hdr = (n) => String((headers.find((h) => String(h.Name || "").toLowerCase() === n) || {}).Value || "").toLowerCase();
    const isAuto = (hdr("auto-submitted") && hdr("auto-submitted") !== "no") || !!hdr("x-autoreply") || !!hdr("x-autorespond") ||
      /auto[_-]?reply/.test(hdr("precedence")) ||
      /^(automatic reply|automatisk svar|autosvar|auto: |out of office|fravær|abwesenheit|автоответ|autoreply)/i.test(subject.trim());

    const ins = await pgPool.query(
      "INSERT INTO inbox (user_id, direction, from_email, from_name, to_email, subject, body, message_id, in_reply_to, has_attachments, auto) VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [String(uid), fromEmail, fromName, alias, subject, body, msgId, String(irt).slice(0, 300), hasAtt, isAuto]
    );
    const inboxId = ins.rows[0].id;
    console.log("[inbound]", isAuto ? "автоответ" : "письмо", "для", uid, "от", fromEmail, "id", inboxId);

    // живые ответы — сразу; автоответы копим и отдаём одной сводкой в 18:00 (/inboxDigestRun)
    if (!isAuto) await notifyInbound(uid, fromName, fromEmail, subject, body, inboxId, isAuto);
    if (ar.rows[0].copy_to_real && ar.rows[0].real_email) {
      const mm = await getMembershipCached(uid).catch(function () { return null; });
      if (mm && mm.member) await forwardCopy(ar.rows[0].real_email, fromName, fromEmail, subject, body);
    }
  } catch (e) {
    logReal("inboundMail", e);
    alertOwner("приём письма", (e && e.message) || String(e));
  }
});

// Переписка пользователя (для апки). Только цепочки, где работодатель что-то прислал.
// Живые ответы и автоответы («в отпуске») отдаются раздельно. Гостю — только количество, без текста и адресов.
app.post("/myInbox", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, threads: [], live: 0, auto: 0, unread: 0 });
    const uid = String(user.id);
    const m = await getMembershipCached(user.id);
    if (m.unknown) return res.json({ ok: false, transient: true, error: "Не удалось проверить доступ. Попробуй через минуту." });
    await pgPool.query("ALTER TABLE inbox ADD COLUMN IF NOT EXISTS tr TEXT").catch(function () {});
    const rin = await pgPool.query(
      "SELECT id, from_email, from_name, subject, body, has_attachments, ts, read, COALESCE(auto,FALSE) AS auto, tr FROM inbox WHERE user_id=$1 AND direction='in' ORDER BY ts DESC LIMIT 300", [uid]);
    const threads = {};
    rin.rows.forEach((x) => {
      const key = String(x.from_email || "").toLowerCase();
      if (!threads[key]) threads[key] = { employer: key, name: "", messages: [], unread: 0, last: x.ts, auto: true };
      const t = threads[key];
      if (x.from_name && !t.name) t.name = x.from_name;
      if (!x.auto) t.auto = false;
      if (!x.read) t.unread++;
      t.messages.push({ id: x.id, dir: "in", subject: x.subject, body: x.body, att: x.has_attachments, ts: x.ts, auto: x.auto, tr: x.tr || "" });
    });
    const list = Object.values(threads);
    const live = list.filter((t) => !t.auto).length, auto = list.filter((t) => t.auto).length;
    const unread = list.filter((t) => !t.auto && t.unread > 0).length;
    if (!m.member) {
      // гость: ответы есть, но читать и отвечать можно только с подпиской
      const lastTs = list.filter((t) => !t.auto).map((t) => t.last).sort().pop() || null;
      return res.json({ ok: true, locked: true, live: live, auto: auto, unread: unread, last: lastTs, threads: [] });
    }
    if (list.length) {
      const rout = await pgPool.query(
        "SELECT id, to_email, subject, body, ts FROM inbox WHERE user_id=$1 AND direction='out' AND LOWER(to_email) = ANY($2::text[]) ORDER BY ts DESC LIMIT 400",
        [uid, list.map((t) => t.employer)]);
      rout.rows.forEach((x) => {
        const t = threads[String(x.to_email || "").toLowerCase()];
        if (t) t.messages.push({ id: x.id, dir: "out", subject: x.subject, body: x.body, ts: x.ts });
      });
    }
    const tsn = (v) => new Date(v).getTime() || 0;
    list.forEach((t) => t.messages.sort((a, b) => tsn(a.ts) - tsn(b.ts)));
    list.sort((a, b) => tsn(b.last) - tsn(a.last));
    res.json({ ok: true, locked: false, live: live, auto: auto, unread: unread, threads: list });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("myInbox", e)) }); }
});

app.post("/inboxRead", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (pgPool) await pgPool.query("UPDATE inbox SET read=TRUE WHERE user_id=$1 AND from_email=$2 AND direction='in'", [String(user.id), String(req.body.employer || "").toLowerCase()]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("inboxRead", e)) }); }
});

// Настройка: дублировать ли ответы на личную почту
app.post("/inboxCopyToggle", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (pgPool) await pgPool.query("UPDATE mail_aliases SET copy_to_real=$2 WHERE user_id=$1", [String(user.id), !!req.body.copy]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("inboxCopyToggle", e)) }); }
});

// Отправить ответ моряка работодателю в ту же цепочку. Адрес/тема/Message-ID берутся из входящего письма.
async function sendReplyCore(uid, inboxId, text) {
  if (!pgPool || !BREVO_API_KEY) return { ok: false, error: "not ready" };
  uid = String(uid || ""); inboxId = parseInt(inboxId || "0", 10); text = String(text || "").trim();
  if (!uid || !inboxId || !text) return { ok: false, error: "bad params" };
  const r = await pgPool.query("SELECT from_email, from_name, subject, message_id FROM inbox WHERE id=$1 AND user_id=$2 AND direction='in'", [inboxId, uid]);
  if (!r.rows.length) return { ok: false, error: "no such message" };
  const src = r.rows[0];
  const a = await pgPool.query("SELECT alias, display_name FROM mail_aliases WHERE user_id=$1", [uid]);
  if (!a.rows.length) return { ok: false, error: "no alias" };
  const alias = a.rows[0].alias, name = a.rows[0].display_name || "";

  // Ответы работодателям — ОТДЕЛЬНЫЙ лимит (не съедает квоту холодных откликов).
  const REPLY_DAILY_LIMIT = parseInt(process.env.REPLY_DAILY_LIMIT || "30", 10);
  const dayKey = todayStr();
  const rsv = await reserveSend(uid + "_reply", REPLY_DAILY_LIMIT, dayKey);
  if (!rsv.ok) return { ok: false, limit: true };

  let subject = String(src.subject || "");
  if (!/^re:/i.test(subject)) subject = "Re: " + subject;
  const headers = {};
  if (src.message_id) { headers["In-Reply-To"] = src.message_id; headers["References"] = src.message_id; }
  const payload = {
    sender: senderFor({ alias, name }, name),
    to: [{ email: src.from_email, name: src.from_name || undefined }],
    replyTo: (name ? { email: alias, name } : { email: alias }),
    subject: subject.slice(0, 200),
    textContent: text.slice(0, 20000),
    tags: ["uid_" + uid, "reply"],
  };
  if (Object.keys(headers).length) payload.headers = headers;
  let data;
  try {
    const rr = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: brevoHeaders(), body: JSON.stringify(payload) });
    data = await rr.json();
    if (!rr.ok || !data.messageId) throw new Error((data && (data.message || data.code)) || "send failed");
  } catch (e) {
    await refundSend(uid + "_reply", dayKey);
    return { ok: false, error: niceError(logReal("sendReply", e)) };
  }
  await pgPool.query(
    "INSERT INTO inbox (user_id, direction, from_email, to_email, subject, body, message_id, in_reply_to, read) VALUES ($1,'out',$2,$3,$4,$5,$6,$7,TRUE)",
    [uid, alias, String(src.from_email).toLowerCase(), subject.slice(0, 300), text.slice(0, 20000), String(data.messageId || ""), String(src.message_id || "")]
  );
  return { ok: true };
}

// БОТ (по внутреннему ключу). Тело: { key, user_id, inbox_id, text }.
app.post("/sendReply", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    res.json(await sendReplyCore(req.body.user_id, req.body.inbox_id, req.body.text));
  } catch (e) { res.json({ ok: false, error: niceError(logReal("sendReply", e)) }); }
});

/* ---------- Переписка в приложении: перевод, помощник с ответом, отправка ---------- */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "claude-sonnet-4-6";
const AI_INBOX_DAILY = parseInt(process.env.AI_INBOX_DAILY || "40", 10);
async function aiText(system, content, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 900, system: system, messages: [{ role: "user", content: content }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d && d.error && d.error.message) || ("AI " + r.status));
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
// общий вход для трёх эндпоинтов: подпись, участник, письмо этого человека
async function inboxGate(req, res) {
  const user = verifyInitData(req.body.initData);
  if (!user) { res.json({ ok: false, error: "bad signature" }); return null; }
  if (!pgPool) { res.json({ ok: false, error: "Сервис временно недоступен." }); return null; }
  const m = await getMembershipCached(user.id);
  if (m.unknown) { res.json({ ok: false, error: "Не удалось проверить доступ. Попробуй через минуту." }); return null; }
  if (!m.member) { res.json({ ok: false, locked: true, error: "Доступно участникам AMORE." }); return null; }
  const id = parseInt(req.body.id || "0", 10);
  const r = await pgPool.query("SELECT id, from_email, from_name, subject, body, tr FROM inbox WHERE id=$1 AND user_id=$2 AND direction='in'", [id, String(user.id)]);
  if (!r.rows.length) { res.json({ ok: false, error: "Письмо не найдено." }); return null; }
  return { uid: String(user.id), msg: r.rows[0] };
}

app.post("/inboxTranslate", async (req, res) => {
  try {
    const g = await inboxGate(req, res); if (!g) return;
    if (g.msg.tr) return res.json({ ok: true, text: g.msg.tr });
    if (!ANTHROPIC_API_KEY) return res.json({ ok: false, error: "Перевод временно недоступен." });
    const day = todayStr();
    const rsv = await reserveSend(g.uid + "_ai", AI_INBOX_DAILY, day);
    if (!rsv.ok) return res.json({ ok: false, error: "На сегодня лимит помощника исчерпан. Завтра снова заработает." });
    let out;
    try {
      out = await aiText("Переведи письмо работодателя на русский, точно и по-деловому. В конце отдельной строкой: 'СУТЬ: ...' — что он хочет от моряка (зовёт на звонок / просит документы / отказ / уточняет опыт / предлагает работу и т.п.). Без вступлений.",
        "Тема: " + (g.msg.subject || "") + "\n\n" + String(g.msg.body || "").slice(0, 8000), 900);
    } catch (e) { await refundSend(g.uid + "_ai", day); throw e; }
    await pgPool.query("UPDATE inbox SET tr=$2 WHERE id=$1", [g.msg.id, out.slice(0, 12000)]).catch(function () {});
    res.json({ ok: true, text: out });
  } catch (e) { logReal("inboxTranslate", e); res.json({ ok: false, error: "Не получилось перевести. Попробуй ещё раз чуть позже." }); }
});

const MAIL_ASSISTANT_PROMPT = "Ты — помощник моряка в деловой переписке с работодателем (судовладелец, крюинг, капитан).\n" +
  "Ты пишешь ОТ ИМЕНИ МОРЯКА, деловым, вежливым, коротким стилем, как пишут в морской индустрии.\n\nПравила:\n" +
  "- Язык ответа — тот же, что у письма работодателя (английский или норвежский). Если непонятно — английский.\n" +
  "- Коротко: 3-7 предложений. Без воды и лишних извинений. Подпись — имя моряка.\n" +
  "- Никогда не выдумывай факты о моряке: опыт, сертификаты, даты, гражданство. Если работодатель спрашивает то, чего нет в данных и человек не сказал — вставь плейсхолдер в квадратных скобках, например [дата готовности], и в комментарии попроси уточнить.\n" +
  "- Если работодатель просит документы — предложи прислать их ответом; не обещай того, чего у человека нет.\n" +
  "- Если это отказ — короткий вежливый ответ с просьбой иметь в виду на будущее.\n" +
  "- Если зовут на звонок/встречу — подтверди, уточни время и часовой пояс.\n\n" +
  "ФОРМАТ ОТВЕТА строго:\nКОММЕНТАРИЙ: 1-2 предложения по-русски — что работодатель хочет и что ты предлагаешь ответить (и чего не хватает, если есть плейсхолдеры).\nПИСЬМО:\n<текст письма на языке работодателя, готовый к отправке>";

app.post("/inboxDraft", async (req, res) => {
  try {
    const g = await inboxGate(req, res); if (!g) return;
    if (!ANTHROPIC_API_KEY) return res.json({ ok: false, error: "Помощник временно недоступен. Напиши ответ сам — отправка работает." });
    const day = todayStr();
    const rsv = await reserveSend(g.uid + "_ai", AI_INBOX_DAILY, day);
    if (!rsv.ok) return res.json({ ok: false, error: "На сегодня лимит помощника исчерпан. Напиши ответ сам или вернись завтра." });
    const th = await pgPool.query("SELECT direction, subject, body FROM inbox WHERE user_id=$1 AND (from_email=$2 OR to_email=$2) ORDER BY ts DESC LIMIT 6", [g.uid, g.msg.from_email]);
    const al = await pgPool.query("SELECT display_name FROM mail_aliases WHERE user_id=$1", [g.uid]);
    const ap = await pgPool.query("SELECT body FROM autopilot WHERE user_id=$1", [g.uid]).catch(function () { return { rows: [] }; });
    const hist = th.rows.reverse().map((t) => "[" + (t.direction === "out" ? "МОРЯК" : "РАБОТОДАТЕЛЬ") + "] " + (t.subject || "") + "\n" + String(t.body || "").slice(0, 1500)).join("\n\n");
    const low = " " + String(g.msg.body || "").toLowerCase();
    const lang = [" hei", " takk", " vi ", " deg", " søknad", " erfaring", " mvh"].some((w) => low.indexOf(w) >= 0) ? "норвежский" : "английский";
    const instruction = String(req.body.instruction || "").trim().slice(0, 1500);
    let content = "Имя моряка: " + ((al.rows[0] && al.rows[0].display_name) || "не указано") + "\n" +
      "Его исходное письмо-отклик (что он о себе писал):\n" + ((ap.rows[0] && String(ap.rows[0].body || "").slice(0, 1500)) || "нет данных") + "\n\n" +
      "ПЕРЕПИСКА С ЭТИМ РАБОТОДАТЕЛЕМ:\n" + hist + "\n\n" +
      "ПОСЛЕДНЕЕ ПИСЬМО РАБОТОДАТЕЛЯ (на него отвечаем; язык — " + lang + "):\nТема: " + (g.msg.subject || "") + "\n" + String(g.msg.body || "").slice(0, 6000) + "\n";
    if (instruction) content += "\n\nПОЖЕЛАНИЯ МОРЯКА К ОТВЕТУ: " + instruction;
    let out;
    try { out = await aiText(MAIL_ASSISTANT_PROMPT, content, 900); }
    catch (e) { await refundSend(g.uid + "_ai", day); throw e; }
    let comment = "", letter = out;
    const k = out.indexOf("ПИСЬМО:");
    if (k >= 0) { comment = out.slice(0, k).replace("КОММЕНТАРИЙ:", "").trim(); letter = out.slice(k + 7).trim(); }
    res.json({ ok: true, comment: comment, letter: letter });
  } catch (e) { logReal("inboxDraft", e); res.json({ ok: false, error: "Не получилось составить ответ. Попробуй ещё раз." }); }
});

app.post("/inboxSend", async (req, res) => {
  try {
    const g = await inboxGate(req, res); if (!g) return;
    const text = String(req.body.text || "").trim();
    if (text.length < 5) return res.json({ ok: false, error: "Письмо пустое." });
    if (/\[[^\]\n]{1,60}\]/.test(text)) return res.json({ ok: false, placeholder: true, error: "В письме остались места в [квадратных скобках] — впиши туда свои данные и отправь." });
    const r = await sendReplyCore(g.uid, g.msg.id, text);
    if (r.limit) return res.json({ ok: false, error: "Сегодня лимит писем исчерпан — отправь завтра." });
    res.json(r.ok ? { ok: true } : { ok: false, error: r.error === "no alias" ? "Сначала отправь хотя бы один отклик из приложения." : (r.error || "Не получилось отправить.") });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("inboxSend", e)) }); }
});

// БОТ: контекст письма + резюме человека для AI-помощника
app.post("/mailContext", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    const uid = String(req.body.user_id || "");
    const inboxId = parseInt(req.body.inbox_id || "0", 10);
    const m = await pgPool.query("SELECT id, from_email, from_name, subject, body, ts FROM inbox WHERE id=$1 AND user_id=$2", [inboxId, uid]);
    if (!m.rows.length) return res.json({ ok: false, error: "no such message" });
    const msg = m.rows[0];
    // вся переписка с этим работодателем, по порядку
    const th = await pgPool.query("SELECT direction, subject, body, ts FROM inbox WHERE user_id=$1 AND (from_email=$2 OR to_email=$2) ORDER BY ts ASC LIMIT 30", [uid, msg.from_email]);
    const al = await pgPool.query("SELECT display_name, real_email FROM mail_aliases WHERE user_id=$1", [uid]);
    const ap = await pgPool.query("SELECT subject, body FROM autopilot WHERE user_id=$1", [uid]);
    res.json({ ok: true, message: msg, thread: th.rows, name: al.rows.length ? al.rows[0].display_name : "", cover: ap.rows.length ? ap.rows[0] : null });
  } catch (e) { res.json({ ok: false, error: logReal("mailContext", e) }); }
});

// Диагностика автопилота: сколько записей sent_targets у каждого, last_run, размер очереди
app.post("/autopilotDebug", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    const users = (await pgPool.query("SELECT user_id, enabled, last_run FROM autopilot ORDER BY user_id")).rows;
    let raw = []; try { raw = await getRawContacts(); } catch (e) {}
    const total = raw.filter((c) => c.email && String(c.email).trim()).length;
    const out = [];
    for (const u of users) {
      const c = await pgPool.query("SELECT COUNT(*)::int AS n FROM sent_targets WHERE user_id=$1", [u.user_id]);
      out.push({ uid: u.user_id, enabled: u.enabled, last_run: u.last_run, sent: c.rows[0].n, contacts_total: total });
    }
    res.json({ ok: true, users: out });
  } catch (e) { res.json({ ok: false, error: logReal("autopilotDebug", e) }); }
});

// Восстановить sent_targets из истории Brevo (кому реально уходили письма за 90 дней)
app.post("/rebuildSentTargets", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool || !BREVO_API_KEY) return res.json({ ok: false, error: "not ready" });
    const only = req.body.user_id ? [String(req.body.user_id)] : (await pgPool.query("SELECT user_id FROM autopilot")).rows.map((x) => x.user_id);
    const result = {};
    for (const uid of only) {
      const tag = "uid_" + uid;
      let added = 0, seen = 0;
      for (let offset = 0; offset < 10000; offset += 2500) {
        const url = `https://api.brevo.com/v3/smtp/statistics/events?event=requests&tags=${encodeURIComponent(tag)}&startDate=${daysAgoStr(90)}&endDate=${todayStr()}&limit=2500&offset=${offset}`;
        const r = await fetch(url, { headers: brevoHeaders() });
        if (!r.ok) break;
        const d = await r.json();
        const ev = Array.isArray(d.events) ? d.events : [];
        if (!ev.length) break;
        for (const e of ev) {
          const em = String(e.email || "").trim().toLowerCase();
          if (!em || em.endsWith("@" + REPLY_DOMAIN)) continue;
          seen++;
          const ins = await pgPool.query("INSERT INTO sent_targets (user_id, target) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING target", [uid, em]);
          if (ins.rows.length) added++;
        }
        if (ev.length < 2500) break;
      }
      result[uid] = { seen, added };
    }
    res.json({ ok: true, result });
  } catch (e) { res.json({ ok: false, error: logReal("rebuildSentTargets", e) }); }
});

// Проверка одного адреса: как он записан в таблице контактов и у кого уже есть в истории отправок
// Сбросить кэш базы контактов и перечитать таблицу (после загрузки новых строк)
app.post("/contactsReload", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const before = cache.data ? cache.data.length : 0;
    cache = { data: null, ts: 0 };
    const list = await getRawContacts();
    const withEmail = list.filter((c) => c.email && String(c.email).trim()).length;
    const sample = list.slice(-3).map((c) => ({ email: c.email || "", company: c.company || c.vessel || "" }));
    res.json({ ok: true, before, after: list.length, withEmail, source: CONTACTS_CSV_URL ? "csv" : "apps-script", last3: sample });
  } catch (e) { res.json({ ok: false, error: logReal("contactsReload", e) }); }
});

app.post("/contactCheck", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const q = String(req.body.email || "").trim().toLowerCase();
    if (!q) return res.json({ ok: false, error: "no email" });
    let raw = []; try { raw = await getRawContacts(); } catch (e) {}
    const matches = raw.map((c, i) => ({ i, c })).filter(({ c }) => String(c.email || "").toLowerCase().indexOf(q) >= 0)
      .map(({ i, c }) => ({ row: i + 1, email_exact: JSON.stringify(String(c.email || "")), company: c.company || c.vessel || "" }));
    let inHistory = [];
    if (pgPool) {
      const r = await pgPool.query("SELECT user_id, target, ts FROM sent_targets WHERE LOWER(TRIM(target)) = $1 ORDER BY ts", [q]);
      inHistory = r.rows.map((x) => ({ uid: x.user_id, stored: JSON.stringify(x.target), ts: x.ts }));
    }
    res.json({ ok: true, matches, inHistory });
  } catch (e) { res.json({ ok: false, error: logReal("contactCheck", e) }); }
});

// Диагностика входящей почты: что вообще дошло до /inboundMail за последние дни
// Сводка автоответов за день — одним сообщением каждому (бот дёргает в 18:00 по Осло)
app.post("/inboxDigestRun", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool || !BOT_TOKEN) return res.json({ ok: true, users: 0, items: 0 });
    const r = await pgPool.query(
      "SELECT id, user_id, from_email, from_name, subject, body FROM inbox WHERE direction='in' AND auto=TRUE AND digested=FALSE AND ts > NOW() - INTERVAL '3 days' ORDER BY user_id, ts");
    const byUser = {};
    r.rows.forEach((x) => { (byUser[x.user_id] = byUser[x.user_id] || []).push(x); });
    let users = 0, items = 0;
    for (const uid of Object.keys(byUser)) {
      const list = byUser[uid];
      const text = "📬 <b>Сегодня " + list.length + " автоответ" + (list.length === 1 ? "" : (list.length < 5 ? "а" : "ов")) + "</b>\n" +
        "<i>Это «в отпуске / не в офисе»: письма дошли и лежат у людей в почте, отвечать на них не нужно. Живые ответы приходят отдельно и сразу.</i>";
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: String(uid), text, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "📬 Посмотреть", url: WEBAPP_URL + "?startapp=inbox_auto" }]] } }) });
        users++; items += list.length;
      } catch (e) { logReal("inboxDigest", e); }
      await pgPool.query("UPDATE inbox SET digested=TRUE WHERE id = ANY($1::int[])", [list.map((x) => x.id)]).catch(function () {});
    }
    res.json({ ok: true, users, items });
  } catch (e) { res.json({ ok: false, error: logReal("inboxDigestRun", e) }); }
});

app.post("/inboundStats", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    const days = Math.max(1, Math.min(60, parseInt(req.body.days, 10) || 7));
    const cnt = await pgPool.query(
      "SELECT direction, COUNT(*)::int AS n FROM inbox WHERE ts > NOW() - ($1 || ' days')::interval GROUP BY direction", [String(days)]);
    const lastIn = await pgPool.query(
      "SELECT user_id, from_email, from_name, subject, ts, auto FROM inbox WHERE direction='in' ORDER BY ts DESC LIMIT 8");
    const lastOut = await pgPool.query(
      "SELECT user_id, to_email, subject, ts FROM inbox WHERE direction='out' ORDER BY ts DESC LIMIT 5");
    const aliases = await pgPool.query("SELECT COUNT(*)::int AS n FROM mail_aliases");
    res.json({
      ok: true, days, counts: cnt.rows, lastIn: lastIn.rows, lastOut: lastOut.rows, aliases: aliases.rows[0].n,
      inboundKeySet: !!INBOUND_KEY, replyDomain: REPLY_DOMAIN, sendFromAlias: SEND_FROM_ALIAS,
      webhookUrl: (process.env.PUBLIC_URL || "https://amore-backend-production-c946.up.railway.app") + "/inboundMail?key=<INBOUND_KEY>",
    });
  } catch (e) { res.json({ ok: false, error: logReal("inboundStats", e) }); }
});

// Резюме на сервере: копия того, что человек сохранил для откликов (переживает чистку памяти телефона)
app.post("/cvSave", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    const b64 = String(req.body.cvBase64 || ""), name = String(req.body.cvName || "CV.pdf").replace(/[^\w.\-А-Яа-яЁё]/g, "_").slice(0, 80);
    if (!b64 || b64.length > 9000000) return res.json({ ok: false, error: "bad size" });
    await pgPool.query("INSERT INTO user_cv (user_id, cv_b64, cv_name, updated) VALUES ($1,$2,$3,NOW()) ON CONFLICT (user_id) DO UPDATE SET cv_b64=$2, cv_name=$3, updated=NOW()", [String(user.id), b64, name]);
    // если у человека включён автопилот — обновляем и там, чтобы утром ушла свежая версия
    pgPool.query("UPDATE autopilot SET cv_b64=$2, cv_name=$3 WHERE user_id=$1", [String(user.id), b64, name]).catch(function () {});
    res.json({ ok: true, name });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("cvSave", e)) }); }
});
// Данные конструктора: сохранить / получить
app.post("/cvDataSave", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    let raw = req.body.data;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    if (!raw || typeof raw !== "object") return res.json({ ok: false, error: "bad data" });
    let str = JSON.stringify(raw);
    // слишком большое фото — сохраняем текст без фото, а не отбрасываем всё резюме
    if (str.length > 4000000 && raw.photo) { raw = Object.assign({}, raw, { photo: "" }); str = JSON.stringify(raw); }
    if (str.length > 4000000) return res.json({ ok: false, error: "bad size" });
    await pgPool.query("INSERT INTO user_cv_data (user_id, data, updated) VALUES ($1,$2,NOW()) ON CONFLICT (user_id) DO UPDATE SET data=$2, updated=NOW()", [String(user.id), str]);
    res.json({ ok: true, updated: new Date().toISOString() });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("cvDataSave", e)) }); }
});
/* ================== НАМЕРЕНИЕ ОПЛАТИТЬ ================== */
// Апка шлёт перед открытием Tribute. tg_id берём из подписи Telegram (initData), а не из тела —
// иначе кто угодно мог бы натравить цепочку сообщений на чужой id.
async function payIntentHandler(req, res) {
  try {
    const user = verifyInitData(req.body && req.body.initData);
    if (!user || !pgPool) return res.json({ ok: false });
    const uid = Number(user.id);
    const plan = ["1m", "3m", "promo", "trial"].includes(String(req.body.plan)) ? String(req.body.plan) : "3m";
    const src = ["yacht", "washing"].includes(String(req.body.src)) ? String(req.body.src) : "";
    if (plan === "trial") {
      const t = await getTrialState(uid);
      if (t.used) return res.json({ ok: false, trialUsed: true, error: "Пробный период уже был использован — доступ по подписке." });
    }
    if (await hasActiveSub(uid)) return res.json({ ok: true, member: true }); // уже платит — цепочку не запускаем
    // открытое намерение за последние 14 дней — обновляем, цепочку не перезапускаем
    const open = await pgPool.query("SELECT id FROM pay_intents WHERE tg_id=$1 AND paid_at IS NULL AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC LIMIT 1", [uid]);
    if (open.rows.length) {
      await pgPool.query("UPDATE pay_intents SET plan=$2, src=$3 WHERE id=$1", [open.rows[0].id, plan, src]);
    } else {
      await pgPool.query("INSERT INTO pay_intents (tg_id, plan, src) VALUES ($1,$2,$3)", [uid, plan, src]);
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("payIntent", e)) }); }
}
app.post("/api/pay-intent", payIntentHandler);
app.post("/payIntent", payIntentHandler);

/* ================== «МОЙ ПУТЬ» УЧАСТНИКА ================== */
app.post("/pathGet", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, path: null });
    const uid = String(user.id);
    const [p, cv, ap, apps] = await Promise.all([
      pgPool.query("SELECT direction, data, updated FROM member_path WHERE user_id=$1", [uid]),
      pgPool.query("SELECT 1 FROM user_cv WHERE user_id=$1", [uid]),
      pgPool.query("SELECT enabled FROM autopilot WHERE user_id=$1", [uid]),
      pgPool.query("SELECT COUNT(*)::int AS n FROM inbox WHERE user_id=$1 AND direction='out'", [uid]),
    ]);
    let data = {}; if (p.rows.length) { try { data = JSON.parse(p.rows[0].data || "{}"); } catch (e) {} }
    res.json({
      ok: true,
      path: p.rows.length ? { direction: p.rows[0].direction, data, updated: p.rows[0].updated } : null,
      hasCv: cv.rows.length > 0,
      autopilot: ap.rows.length ? !!ap.rows[0].enabled : false,
      apps: apps.rows[0].n,
    });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("pathGet", e)) }); }
});
// Для бота (AI-ассистент): статус пути человека по user_id
const PATH_DOC_COUNTS = { crab: 2, wash: 3, yacht: 2, merchant: 3 };
const PATH_DIR2KEY = { "Рыболовные суда": "crab", "Замывка трюмов": "wash", "Яхты": "yacht", "Торговый флот": "merchant" };
app.post("/pathStatus", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const uid = String(req.body.user_id || "");
    if (!uid || !pgPool) return res.json({ ok: true, member: false, steps: [] });
    const mem = await getMembershipCached(uid).catch(() => ({ member: false }));
    const [p, cv, ap, apps] = await Promise.all([
      pgPool.query("SELECT direction, data FROM member_path WHERE user_id=$1", [uid]),
      pgPool.query("SELECT 1 FROM user_cv WHERE user_id=$1", [uid]),
      pgPool.query("SELECT enabled FROM autopilot WHERE user_id=$1", [uid]),
      pgPool.query("SELECT COUNT(*)::int AS n FROM inbox WHERE user_id=$1 AND direction='out'", [uid]),
    ]);
    let data = {}, direction = null;
    if (p.rows.length) { direction = p.rows[0].direction || null; try { data = JSON.parse(p.rows[0].data || "{}"); } catch (e) {} }
    const dk = direction ? PATH_DIR2KEY[direction] : null;
    let docsDone = !!data.docsInWork;
    if (dk && data.docs) { let n = 0; for (const k in data.docs) if (data.docs[k] && String(k).indexOf(dk + "-") === 0) n++; if (n >= (PATH_DOC_COUNTS[dk] || 99)) docsDone = true; }
    const autopilot = ap.rows.length ? !!ap.rows[0].enabled : false;
    const steps = [
      { n: 1, name: "выбрать направление", done: !!direction },
      { n: 2, name: "документы", done: docsDone },
      { n: 3, name: "резюме", done: cv.rows.length > 0 },
      { n: 4, name: "отклики / авторассылка", done: autopilot || apps.rows[0].n > 0 },
      { n: 5, name: "ментор и ветка", done: !!data.mentorSeen },
    ];
    const next = steps.find((x) => !x.done) || null;
    res.json({ ok: true, member: !!(mem && mem.member), direction, steps, next: next ? next.n : null, apps: apps.rows[0].n, autopilot });
  } catch (e) { res.json({ ok: false, error: logReal("pathStatus", e) }); }
});

// Для бота: гости, у кого есть прогресс по пути, но нет подписки — кандидаты на мягкие напоминания
app.post("/nudgeCandidates", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: true, items: [] });
    const nudgeSql = (skipMentorUsers) =>
      "SELECT p.user_id, p.direction, p.data, p.created, p.updated, " +
      "  EXISTS(SELECT 1 FROM user_cv c WHERE c.user_id=p.user_id) AS has_cv, " +
      "  (SELECT COUNT(*)::int FROM inbox i WHERE i.user_id=p.user_id AND i.direction='out') AS apps, " +
      "  (SELECT COUNT(*)::int FROM inbox i WHERE i.user_id=p.user_id AND i.direction='in' AND COALESCE(i.auto,FALSE)=FALSE) AS replies " +
      "FROM member_path p " +
      "WHERE p.created > NOW() - INTERVAL '7 days' " +
      "  AND NOT EXISTS (SELECT 1 FROM subs s WHERE s.user_id::text=p.user_id AND s.group_kind='main' AND s.active=TRUE)" +
      // тех, кто пришёл через бота ментора (яхтинг / замывка), ведёт бот ментора — основной бот им не напоминает
      (skipMentorUsers ? "  AND NOT EXISTS (SELECT 1 FROM mb_users m WHERE m.user_id::text=p.user_id)" : "");
    let r;
    try { r = await pgPool.query(nudgeSql(true)); }
    catch (e) { r = await pgPool.query(nudgeSql(false)); } // таблицы mb_users ещё нет
    const items = r.rows.map((x) => {
      let d = {}; try { d = JSON.parse(x.data || "{}"); } catch (e) {}
      const dk = x.direction ? PATH_DIR2KEY[x.direction] : null;
      let docsN = 0; if (dk && d.docs) for (const k in d.docs) if (d.docs[k] && String(k).indexOf(dk + "-") === 0) docsN++;
      return {
        user_id: x.user_id, direction: x.direction, created: x.created, updated: x.updated,
        hasCv: !!x.has_cv, apps: x.apps, replies: x.replies,
        docsDone: !!d.docsInWork || (dk && docsN >= (PATH_DOC_COUNTS[dk] || 99)), docsN,
        mentorSeen: !!d.mentorSeen, appsExhausted: x.apps >= GUEST_LIMIT_CONST,
      };
    });
    res.json({ ok: true, items });
  } catch (e) { res.json({ ok: false, error: logReal("nudgeCandidates", e) }); }
});
const GUEST_LIMIT_CONST = 3;

app.post("/pathSave", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: false, error: "no db" });
    const direction = req.body.direction == null ? null : String(req.body.direction).slice(0, 60);
    let data = req.body.data; if (typeof data !== "object" || !data) data = {};
    const str = JSON.stringify(data).slice(0, 20000);
    await pgPool.query(
      "INSERT INTO member_path (user_id, direction, data, updated) VALUES ($1,$2,$3,NOW()) " +
      "ON CONFLICT (user_id) DO UPDATE SET direction=COALESCE($2, member_path.direction), data=$3, updated=NOW()",
      [String(user.id), direction, str]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("pathSave", e)) }); }
});

// Приветствие после оплаты: один раз на человека. Шлём из вебхука Tribute, бот дублирует при входе в группу.
async function sendWelcomeIfNeeded(uid) {
  if (!pgPool || !BOT_TOKEN) return false;
  const r = await pgPool.query("INSERT INTO welcome_sent (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id", [String(uid)]);
  if (!r.rows.length) return false; // уже слали
  const text = "🎉 <b>Поздравляем со входом в семью AMORE!</b>\n\n" +
    "Теперь главное — не распыляться. Первый шаг: определись, в какое направление тебе реальнее всего попасть.\n\n" +
    "В приложении есть твой <b>путь из 5 шагов</b>:\n" +
    "1️⃣ Посмотри базовые видео по 4 направлениям и выбери своё\n" +
    "2️⃣ Документы — что нужно именно под него\n" +
    "3️⃣ Резюме\n" +
    "4️⃣ Отклики и авторассылка\n" +
    "5️⃣ Ментор и ветка направления в группе\n\n" +
    "Жми кнопку — начнём с первого шага 👇";
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(uid), text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🧭 Открыть AMORE → Мой путь", url: WEBAPP_URL + "?startapp=path" }]] } }),
  }).catch(function () {});
  return true;
}
app.post("/welcomeIfNeeded", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const sent = await sendWelcomeIfNeeded(String(req.body.user_id || ""));
    res.json({ ok: true, sent });
  } catch (e) { res.json({ ok: false, error: logReal("welcomeIfNeeded", e) }); }
});

app.post("/cvDataGet", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, data: null });
    const r = await pgPool.query("SELECT data, updated FROM user_cv_data WHERE user_id=$1", [String(user.id)]);
    if (!r.rows.length) return res.json({ ok: true, data: null });
    let parsed = null; try { parsed = JSON.parse(r.rows[0].data); } catch (e) {}
    res.json({ ok: true, data: parsed, updated: r.rows[0].updated });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("cvDataGet", e)) }); }
});

app.post("/cvGet", async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.json({ ok: false, error: "bad signature" });
    if (!pgPool) return res.json({ ok: true, cv: null });
    const r = await pgPool.query("SELECT cv_b64, cv_name, updated FROM user_cv WHERE user_id=$1", [String(user.id)]);
    if (!r.rows.length) return res.json({ ok: true, cv: null });
    const meta = !!req.body.metaOnly;
    res.json({ ok: true, cv: { name: r.rows[0].cv_name, updated: r.rows[0].updated, b64: meta ? undefined : r.rows[0].cv_b64 } });
  } catch (e) { res.json({ ok: false, error: niceError(logReal("cvGet", e)) }); }
});

/* ================== TRIBUTE: вебхуки подписок + синхронизация ================== */
// Tribute шлёт события new/renewed/cancelled с подписью trbt-signature = HMAC-SHA256(body, API key).
// Настройка: Tribute → Creator Dashboard → Settings → API Keys → Webhook URL:
//   https://<бэкенд>/tributeWebhook   и в Railway: TRIBUTE_API_KEY=<ключ из Tribute>
const TRIBUTE_API_KEY = process.env.TRIBUTE_API_KEY;
// Подписки Tribute, которые дают доступ в AMORE: общая (sUKo), Никита-яхтинг (s121b), Влад-замывка (s18v0).
// Остальные продукты аккаунта (вебинар, курс, лекция…) к AMORE не относятся и в учёт участников не попадают.
const AMORE_SUB_IDS = new Set(String(process.env.AMORE_SUB_IDS || "218140,246089,271002").split(",").map(function (x) { return Number(x.trim()); }).filter(Boolean));
const PERIOD_DAYS = { weekly: 7, monthly: 30, quarterly: 90, halfyearly: 180, yearly: 365, trial: 7, onetime: 30 };

/* ================== ПРОБНЫЙ ДОСТУП 24 ЧАСА ================== */
// Триал — отдельная подписка Tribute с пробным периодом; вебхук помечает её payload.type === "trial".
// trials: один ряд на человека навсегда — второй триал с того же аккаунта невозможен (repeat_attempts растёт, доступ не даётся).
const TRIAL_HOURS = Number(process.env.TRIAL_HOURS || 24);
async function ensureTrialsTable() {
  if (!pgPool) return;
  await pgPool.query("CREATE TABLE IF NOT EXISTS trials (user_id BIGINT PRIMARY KEY, started_at TIMESTAMP NOT NULL, ends_at TIMESTAMP NOT NULL, " +
    "sub_id INTEGER, src TEXT DEFAULT '', charged_at TIMESTAMP, cancelled_at TIMESTAMP, repeat_attempts INTEGER DEFAULT 0, " +
    "welcome_sent BOOLEAN DEFAULT FALSE, mentor_alerted BOOLEAN DEFAULT FALSE, nudges INTEGER DEFAULT 0, last_nudge_at TIMESTAMP, final_sent BOOLEAN DEFAULT FALSE)").catch(function () {});
}
// Статус триала для приложения: active — идёт сейчас; used — триал уже был (повторно нельзя)
async function getTrialState(uid) {
  if (!pgPool) return { active: false, used: false };
  try {
    await ensureTrialsTable();
    const r = await pgPool.query("SELECT started_at, ends_at, charged_at, cancelled_at FROM trials WHERE user_id=$1", [Number(uid)]);
    if (!r.rows.length) return { active: false, used: false };
    const t = r.rows[0];
    const active = !t.charged_at && !t.cancelled_at && new Date(t.ends_at) > new Date();
    const expired = !t.charged_at && !t.cancelled_at && !active;   // сутки прошли, Tribute ещё не списал — в апке доступ закрыт до списания
    return { active, expired, used: true, ends_at: t.ends_at, started_at: t.started_at, charged: !!t.charged_at };
  } catch (e) { return { active: false, used: false }; }
}
// Выгнать из группы (кик = бан + разбан, чтобы человек мог вернуться по новой подписке)
async function kickFromGroup(uid) {
  if (!BOT_TOKEN || !GROUP_ID) return false;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: GROUP_ID, user_id: Number(uid) }) });
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: GROUP_ID, user_id: Number(uid), only_if_banned: true }) });
    delete memCache[uid]; delete memCache[String(uid)];
    return true;
  } catch (e) { console.log("[trial] kick:", e.message); return false; }
}
async function tgText(chatId, text, kb) {
  if (!BOT_TOKEN) return;
  const body = { chat_id: String(chatId), text };
  if (kb) body.reply_markup = { inline_keyboard: kb };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(function () {});
}

// сырой body нужен для проверки подписи — берём его отдельным парсером только для этого пути
app.post("/tributeWebhook", async (req, res) => {
  try {
    if (!TRIBUTE_API_KEY) return res.status(500).json({ ok: false, error: "TRIBUTE_API_KEY not set" });
    const raw = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
    const sig = String(req.headers["trbt-signature"] || "");
    const expect = crypto.createHmac("sha256", TRIBUTE_API_KEY).update(raw).digest("hex");
    const okSig = sig && expect.length === sig.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig));
    if (!okSig) { console.log("[tribute] плохая подпись"); return res.status(403).json({ ok: false }); }
    res.json({ ok: true }); // отвечаем сразу, чтобы Tribute не ретраил

    let ev; try { ev = JSON.parse(raw.toString("utf8")); } catch (e) { return; }
    try { const q = ev.payload || {}; console.log("[tribute:raw]", ev.name, "uid", q.telegram_user_id, "sub", q.subscription_id, "type", q.type, "period", q.period, "amount", q.amount, "expires", q.expires_at); } catch (e) {}
    const name = String(ev.name || "");
    const p = ev.payload || {};
    const uid = p.telegram_user_id;
    if (!uid || !pgPool) return;
    const isMass = (MASS_GROUP_ID && String(p.channel_id) === String(MASS_GROUP_ID).replace(/^-100/, "")) ||
                   /рассылк/i.test(String(p.subscription_name || ""));
    const isMain = !isMass && (AMORE_SUB_IDS.has(Number(p.subscription_id)) ||
                   (GROUP_ID && String(p.channel_id) === String(GROUP_ID).replace(/^-100/, "")));
    const isTrial = String(p.type || "") === "trial";
    const kind = isMass ? "mass" : (isMain || isTrial) ? "main" : "other"; // other — другой продукт (вебинар, курс…), не AMORE
    const planDays = PERIOD_DAYS[String(p.period || "monthly")] || 30;
    const expires = p.expires_at ? new Date(p.expires_at) : null;
    const when = ev.created_at ? new Date(ev.created_at) : new Date();
    const label = (kind === "mass" ? "Рассылка" : "AMORE");
    const money = (p.amount != null ? (Number(p.amount) / 100).toFixed(0) : "") + " " + String(p.currency || "").toUpperCase();

    await pgPool.query("ALTER TABLE subs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP").catch(function () {});
    await pgPool.query("ALTER TABLE subs ADD COLUMN IF NOT EXISTS tribute_sub_id INTEGER").catch(function () {});
    // справочник «ID подписки Tribute → название»: по нему видно, чья подписка (общая / яхтинг / замывка)
    if (p.subscription_id) {
      await pgPool.query("CREATE TABLE IF NOT EXISTS tribute_subs (sub_id INTEGER PRIMARY KEY, name TEXT, updated TIMESTAMP DEFAULT NOW())").catch(function () {});
      await pgPool.query("INSERT INTO tribute_subs (sub_id, name) VALUES ($1,$2) ON CONFLICT (sub_id) DO UPDATE SET name=$2, updated=NOW()",
        [p.subscription_id, String(p.subscription_name || "")]).catch(function () {});
    }

    // журнал платежей: каждое событие Tribute с суммой и ID подписки — по нему считаются доли менторов.
    // Повторная доставка того же события Tribute не создаёт дубль (уникальный ключ).
    await pgPool.query("CREATE TABLE IF NOT EXISTS tribute_payments (id SERIAL PRIMARY KEY, ts TIMESTAMP NOT NULL, event TEXT NOT NULL, user_id BIGINT NOT NULL, " +
      "sub_id INTEGER, sub_name TEXT, group_kind TEXT, period TEXT, amount INTEGER, currency TEXT, UNIQUE (event, user_id, sub_id, ts))").catch(function () {});
    // old_member: человек уже был участником AMORE по другой ссылке до этой оплаты — бонус ментору за него не считается
    await pgPool.query("ALTER TABLE tribute_payments ADD COLUMN IF NOT EXISTS old_member BOOLEAN").catch(function () {});
    let oldMember = null;
    if (name === "new_subscription" && kind === "main") {
      const om = await pgPool.query("SELECT 1 FROM subs WHERE user_id=$1 AND group_kind='main' AND tribute_sub_id IS DISTINCT FROM $2 LIMIT 1",
        [uid, p.subscription_id || 0]).catch(function () { return null; });
      oldMember = !!(om && om.rows.length);
    }
    await pgPool.query("INSERT INTO tribute_payments (ts, event, user_id, sub_id, sub_name, group_kind, period, amount, currency, old_member) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
      [when, name, uid, p.subscription_id || 0, String(p.subscription_name || ""), kind, String(p.period || ""),
       name === "cancelled_subscription" || p.amount == null ? null : Math.round(Number(p.amount)), String(p.currency || "").toLowerCase(), oldMember])
      .catch(function (e) { console.log("[tribute] payments log:", e.message); });

    // ── Пробный доступ: вход, повтор, списание, отмена ──
    if (kind === "main") {
      await ensureTrialsTable();
      const tr = await pgPool.query("SELECT * FROM trials WHERE user_id=$1", [uid]).catch(function () { return { rows: [] }; });
      const trow = tr.rows[0] || null;
      if (name === "new_subscription" && isTrial) {
        if (trow) {
          // ПОВТОРНЫЙ ТРИАЛ: доступ не даём, из группы выгоняем, человеку и владельцу — сообщение
          await pgPool.query("UPDATE trials SET repeat_attempts=repeat_attempts+1 WHERE user_id=$1", [uid]).catch(function () {});
          await pgPool.query("UPDATE subs SET active=FALSE, left_at=$2 WHERE user_id=$1 AND group_kind='main'", [uid, when]).catch(function () {});
          const kicked = await kickFromGroup(uid);
          await tgText(uid, "Пробный период AMORE уже использован с этого аккаунта — второй раз он не даётся. Доступ открывается по подписке.",
            [[{ text: "Открыть AMORE", url: WEBAPP_URL + "?startapp=pay" }]]);
          await tgText(OWNER_ID, "⚠️ Повторный триал: id " + uid + " (попытка " + ((trow.repeat_attempts || 0) + 2) + ")" + (kicked ? "\nВыгнан из группы" : "\nНе удалось выгнать — проверь вручную") +
            "\nОтмени ему подписку в Tribute, чтобы через 24 ч не списалось как «конверсия».");
          console.log("[trial] repeat uid", uid);
          return;
        }
        // у человека уже есть действующая платная подписка — триал ему не нужен, иначе спишется дважды
        if (await hasOtherSub(uid)) {
          await tgText(uid, "У тебя уже есть действующая подписка AMORE — пробная тебе не нужна, по ней Tribute спишет ещё раз.\nОтмени её: @tribute → Мои подписки → «AMORE — пробная» → Отменить. Основная подписка не пострадает.",
            [[{ text: "Открыть Tribute", url: "https://t.me/tribute/app?startapp=subscriptions" }]]);
          await tgText(OWNER_ID, "⚠️ Действующий участник активировал пробную: id " + uid + "\nЕму ушла инструкция отменить. Проверь через день.");
        }
        const ends = expires && (expires - when) < 3 * 86400000 ? expires : new Date(when.getTime() + TRIAL_HOURS * 3600000);
        const si = await pgPool.query("SELECT src FROM pay_intents WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 1", [uid]).catch(function () { return { rows: [] }; });
        await pgPool.query("INSERT INTO trials (user_id, started_at, ends_at, sub_id, src) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO NOTHING",
          [uid, when, ends, p.subscription_id || null, (si.rows[0] && si.rows[0].src) || ""]).catch(function (e) { console.log("[trial] insert:", e.message); });
      } else if (name === "new_subscription" && !isTrial && trow && !trow.charged_at && !trow.cancelled_at
                 && trow.sub_id && Number(p.subscription_id) === Number(trow.sub_id)) {
        // первое списание по самой пробной подписке пришло как «новая подписка» — это конверсия, ничего отменять не надо
        await pgPool.query("UPDATE trials SET charged_at=$2 WHERE user_id=$1", [uid, when]).catch(function () {});
        delete memCache[uid]; delete memCache[String(uid)];
      } else if (name === "new_subscription" && !isTrial && trow && !trow.charged_at && !trow.cancelled_at) {
        // в триале купил обычную подписку (например, 3 месяца) — триал закрыт как конверсия; пробную подписку надо отменить вручную
        await pgPool.query("UPDATE trials SET charged_at=$2 WHERE user_id=$1", [uid, when]).catch(function () {});
        await tgText(uid, "Подписка AMORE оформлена — всё открыто.\n\nОдно важное: пробная подписка осталась активной, и Tribute спишет по ней ещё раз. Отмени её сейчас, это минута:\n@tribute → Мои подписки → «AMORE — пробная» → Отменить.\n\nОсновная подписка при этом не трогается.",
          [[{ text: "Открыть Tribute", url: "https://t.me/tribute/app?startapp=subscriptions" }]]);
        await tgText(OWNER_ID, "✅ Из пробного — сразу подписка: id " + uid + " (" + String(p.period || "") + ")\nЕму ушла инструкция отменить пробную. Через день проверь в Tribute, что пробная у него отменена — иначе спишется 50€ сверху.");
      } else if (name === "renewed_subscription" && trow && !trow.charged_at && !trow.cancelled_at) {
        // первое списание после триала = конверсия; с этого момента человек — обычный участник, стартует онбординг
        await pgPool.query("UPDATE trials SET charged_at=$2 WHERE user_id=$1", [uid, when]).catch(function () {});
        delete memCache[uid]; delete memCache[String(uid)];
      } else if (name === "cancelled_subscription" && trow && !trow.charged_at && !trow.cancelled_at) {
        await pgPool.query("UPDATE trials SET cancelled_at=$2 WHERE user_id=$1", [uid, when]).catch(function () {});
      }
    }
    // страховка: любое событие с деньгами по открытому триалу (кроме отмены) = списание прошло
    if (kind === "main" && name !== "cancelled_subscription" && !isTrial && p.amount != null && Number(p.amount) > 0) {
      const tr2 = await pgPool.query("SELECT 1 FROM trials WHERE user_id=$1 AND charged_at IS NULL AND cancelled_at IS NULL", [uid]).catch(function () { return { rows: [] }; });
      if (tr2.rows.length) {
        await pgPool.query("UPDATE trials SET charged_at=$2 WHERE user_id=$1", [uid, when]).catch(function () {});
        delete memCache[uid]; delete memCache[String(uid)];
        console.log("[trial] charged via", name, "uid", uid);
      }
    }
    const trialNow = isTrial && name === "new_subscription";

    if (kind === "other") { // чужой продукт: в журнал записали, участником AMORE не считаем
      console.log("[tribute]", name, "uid", uid, "другой продукт:", p.subscription_name || p.subscription_id);
      return;
    }
    if (name === "new_subscription" || name === "renewed_subscription") {
      const isNew = name === "new_subscription";
      await pgPool.query(
        "INSERT INTO subs (user_id, group_kind, joined_at, left_at, active, seeded, plan_days, last_paid, expires_at, tribute_sub_id) " +
        "VALUES ($1,$2,$3,NULL,TRUE,FALSE,$4,$3,$5,$6) " +
        "ON CONFLICT (user_id, group_kind) DO UPDATE SET " +
        "  joined_at=CASE WHEN $7 THEN $3 ELSE LEAST(COALESCE(subs.joined_at,$3),$3) END, " +
        "  left_at=NULL, active=TRUE, seeded=FALSE, plan_days=$4, last_paid=$3, expires_at=$5, tribute_sub_id=$6",
        [uid, kind, when, planDays, expires, p.subscription_id || null, isNew]
      );
      await pgPool.query("INSERT INTO sub_events (user_id, group_kind, event, ts) VALUES ($1,$2,$3,$4)", [uid, kind, isNew ? "join" : "renew", when]).catch(function () {});
      if (isNew && kind === "main" && !trialNow) sendWelcomeIfNeeded(uid).catch(function () {}); // триальщика приветствует бот своим текстом
      if (kind === "main") {
        // оплата закрывает цепочку «брошенной оплаты»; запоминаем, после какого сообщения оплатил
        await pgPool.query("UPDATE pay_intents SET paid_at=$2, paid_after_step=step_sent WHERE tg_id=$1 AND paid_at IS NULL", [uid, when])
          .catch(function (e) { console.log("[tribute] pay_intents:", e.message); });
        // конверсия из триала: списание = «оплатил» для онбординга и бонуса ментору
        const converted = !isNew && await pgPool.query("SELECT src FROM trials WHERE user_id=$1 AND charged_at=$2", [uid, when]).then(function (r) { return r.rows[0] || null; }).catch(function () { return null; });
        if (converted) {
          await pgPool.query("INSERT INTO onboarding (user_id, paid_at, src) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING",
            [uid, when, converted.src || ""]).catch(function (e) { console.log("[tribute] onboarding:", e.message); });
          sendWelcomeIfNeeded(uid).catch(function () {});
        }
        if (isNew && !trialNow) {
          // реферал: друг, которого привёл участник, оплатил → владельцу напоминание выдать месяц в подарок
          try {
            const rf = await pgPool.query("SELECT referred_by FROM referrals WHERE user_id=$1", [uid]);
            if (rf.rows.length && rf.rows[0].referred_by) {
              const by = rf.rows[0].referred_by;
              const u = await pgPool.query("SELECT username, full_name FROM users WHERE user_id=$1", [by]).catch(function () { return { rows: [] }; });
              const who = u.rows.length ? ((u.rows[0].full_name || "") + (u.rows[0].username ? " @" + u.rows[0].username : "")) : "";
              fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: OWNER_ID, text: "🎁 Реферал оплатил AMORE\nПривёл: id " + by + " " + who + "\nОплатил: id " + uid + "\n→ выдай ему месяц в подарок (Tribute → подписчик → продлить)" }) }).catch(function () {});
            }
          } catch (e) { console.log("[tribute] referral:", e.message); }
          const si = await pgPool.query("SELECT src FROM pay_intents WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 1", [uid]).catch(function () { return { rows: [] }; });
          await pgPool.query("INSERT INTO onboarding (user_id, paid_at, src) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING",
            [uid, when, (si.rows[0] && si.rows[0].src) || ""]).catch(function (e) { console.log("[tribute] onboarding:", e.message); });
        }
      }
      const txt = (trialNow ? "🆓 Пробный доступ 24 ч" : isNew ? "💳 Новая подписка" : "🔁 Продление") + " (" + label + "): id " + uid +
        "\n" + String(p.period || "") + " · " + money + (expires ? "\nдо " + expires.toISOString().slice(0, 10) : "") +
        (p.type && p.type !== "regular" ? "\nтип: " + p.type : "") +
        (p.subscription_name ? "\nподписка: " + p.subscription_name : "");
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: OWNER_ID, text: txt }) }).catch(function () {});
    } else if (name === "cancelled_subscription") {
      // отмена одной подписки не гасит запись, если человек уже перешёл на другую подписку той же группы
      // (например, с общей на подписку ментора): сверяем ID подписки
      await pgPool.query("UPDATE subs SET active=FALSE, left_at=$3, expires_at=COALESCE($4, expires_at) WHERE user_id=$1 AND group_kind=$2 " +
        "AND ($5::int IS NULL OR tribute_sub_id IS NULL OR tribute_sub_id=$5::int)", [uid, kind, when, expires, p.subscription_id || null]);
      await pgPool.query("INSERT INTO sub_events (user_id, group_kind, event, ts) VALUES ($1,$2,'leave',$3)", [uid, kind, when]).catch(function () {});
      const r = await pgPool.query("SELECT joined_at FROM subs WHERE user_id=$1 AND group_kind=$2", [uid, kind]);
      const days = (r.rows.length && r.rows[0].joined_at) ? Math.round((when - new Date(r.rows[0].joined_at)) / 86400000) : null;
      const txt = "❌ Отписка (" + label + "): id " + uid + (days != null ? ", был " + days + " дн." : "") +
        (p.cancel_reason ? "\nпричина в Tribute: " + p.cancel_reason : "") + (expires ? "\nдоступ до " + expires.toISOString().slice(0, 10) : "");
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: OWNER_ID, text: txt }) }).catch(function () {});
      // опрос «почему ушёл» — кнопки обрабатывает бот (exit_*)
      if (kind === "main") {
        const kb = [["job", "🚢 Нашёл работу"], ["price", "💶 Дорого"], ["nohelp", "🤷 Не помогло / ожидал другого"], ["pause", "⏸ Пауза, вернусь позже"], ["other", "✍️ Другое"]]
          .map(([c, t]) => [{ text: t, callback_data: "exit_" + c }]);
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: String(uid), text: "Вижу, ты отменил подписку AMORE. Без обид — подскажи одной кнопкой, почему? Это реально помогает делать лучше.", reply_markup: { inline_keyboard: kb } }) }).catch(function () {});
      }
    }
    console.log("[tribute]", name, "uid", uid, kind);
  } catch (e) {
    logReal("tributeWebhook", e);
    alertOwner("Tribute webhook", (e && e.message) || String(e));
  }
});

app.post("/phoneAudit", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const contacts = await getRawContacts().catch(() => []);
    let vacancies = []; try { vacancies = await fetchVacanciesOrdered(); } catch (e) {}
    res.json({ ok: true, contacts: phoneAudit(contacts), vacancies: phoneAudit(vacancies), defaultCountry: DEFAULT_CONTACT_COUNTRY });
  } catch (e) { res.json({ ok: false, error: logReal("phoneAudit", e) }); }
});

// Для бота: триалы, по которым надо что-то отправить (welcome / 4-часовые / финал / ментор). Бот отмечает отправку через /trialMark.
app.post("/trialsPending", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!pgPool) return res.json({ ok: true, items: [] });
    await ensureTrialsTable();
    const r = await pgPool.query("SELECT user_id, started_at, ends_at, src, welcome_sent, mentor_alerted, nudges, last_nudge_at, final_sent, charged_at, cancelled_at " +
      "FROM trials WHERE charged_at IS NULL AND cancelled_at IS NULL AND ends_at > NOW() - INTERVAL '1 hour' ORDER BY started_at");
    res.json({ ok: true, items: r.rows, trialHours: TRIAL_HOURS });
  } catch (e) { res.json({ ok: false, error: logReal("trialsPending", e) }); }
});
app.post("/trialMark", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    const uid = Number(req.body.user_id || 0), what = String(req.body.what || "");
    if (!uid || !pgPool) return res.json({ ok: false });
    const sql = { welcome: "UPDATE trials SET welcome_sent=TRUE WHERE user_id=$1", mentor: "UPDATE trials SET mentor_alerted=TRUE WHERE user_id=$1",
      nudge: "UPDATE trials SET nudges=nudges+1, last_nudge_at=NOW() WHERE user_id=$1", final: "UPDATE trials SET final_sent=TRUE WHERE user_id=$1" }[what];
    if (!sql) return res.json({ ok: false, error: "bad what" });
    await pgPool.query(sql, [uid]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: logReal("trialMark", e) }); }
});

// Полная синхронизация подписчиков из Tribute (GET /subscribers). Дёргает бот по внутреннему ключу.
app.post("/tributeSync", async (req, res) => {
  try {
    if (!botAuthed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!TRIBUTE_API_KEY || !pgPool) return res.json({ ok: false, error: "TRIBUTE_API_KEY not set" });
    const r = await fetch("https://tribute.tg/api/v1/subscribers", { headers: { "Api-Key": TRIBUTE_API_KEY, accept: "application/json" } });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch (e) { return res.json({ ok: false, error: "Tribute: non-JSON HTTP " + r.status }); }
    const list = Array.isArray(d) ? d : (d.result || d.subscribers || d.items || []);
    await pgPool.query("ALTER TABLE subs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP").catch(function () {});
    await pgPool.query("ALTER TABLE subs ADD COLUMN IF NOT EXISTS tribute_sub_id INTEGER").catch(function () {});
    // какие subscriptionId — рассылка: по каталогу /subscriptions
    let massIds = new Set();
    try {
      const rs = await fetch("https://tribute.tg/api/v1/subscriptions", { headers: { "Api-Key": TRIBUTE_API_KEY, accept: "application/json" } });
      const ds = await rs.json(); const cat = Array.isArray(ds) ? ds : (ds.result || []);
      cat.forEach((s) => { if (/рассылк/i.test(String(s.name || ""))) massIds.add(Number(s.subscriptionId)); });
      await pgPool.query("CREATE TABLE IF NOT EXISTS tribute_subs (sub_id INTEGER PRIMARY KEY, name TEXT, updated TIMESTAMP DEFAULT NOW())").catch(function () {});
      for (const s of cat) {
        if (!s.subscriptionId) continue;
        await pgPool.query("INSERT INTO tribute_subs (sub_id, name) VALUES ($1,$2) ON CONFLICT (sub_id) DO UPDATE SET name=$2, updated=NOW()",
          [Number(s.subscriptionId), String(s.name || "")]).catch(function () {});
      }
    } catch (e) {}
    let n = 0, active = 0;
    // у одного человека может быть несколько записей на одну группу (старая отменённая подписка + новая,
    // общая + подписка ментора). Оставляем одну: активную, а среди равных — с самой поздней датой окончания.
    const isAct = (x) => String(x.status || "") === "active" || String(x.status || "") === "pre_cancelled";
    const best = new Map();
    try { const ts = await pgPool.query("SELECT DISTINCT sub_id FROM trials WHERE sub_id IS NOT NULL"); ts.rows.forEach((r) => AMORE_SUB_IDS.add(Number(r.sub_id))); } catch (e) {}
    const kindOf = (x) => massIds.has(Number(x.subscriptionId)) ? "mass" : AMORE_SUB_IDS.has(Number(x.subscriptionId)) ? "main" : null;
    // Сверка триалов по данным Tribute (на случай, если вебхук списания не пришёл):
    // активна и срок продлён дальше конца пробных суток — списание прошло; не активна — отменена.
    let trialCharged = 0, trialCancelled = 0;
    try {
      await ensureTrialsTable();
      const open = await pgPool.query("SELECT user_id, sub_id, ends_at FROM trials WHERE charged_at IS NULL AND cancelled_at IS NULL");
      for (const t of open.rows) {
        const mine = list.filter((x) => String(x.telegramUserId) === String(t.user_id) && Number(x.subscriptionId) === Number(t.sub_id));
        if (!mine.length) continue;
        const x = mine.sort((a, b) => new Date(b.expireAt || 0) - new Date(a.expireAt || 0))[0];
        const exp = x.expireAt ? new Date(x.expireAt) : null;
        if (isAct(x) && exp && exp - new Date(t.ends_at) > 2 * 86400000) {
          await pgPool.query("UPDATE trials SET charged_at=$2 WHERE user_id=$1", [t.user_id, new Date(t.ends_at)]);
          await pgPool.query("INSERT INTO onboarding (user_id, paid_at, src) VALUES ($1,$2,(SELECT COALESCE(src,'') FROM trials WHERE user_id=$1)) ON CONFLICT (user_id) DO NOTHING", [t.user_id, new Date(t.ends_at)]).catch(function () {});
          delete memCache[t.user_id]; delete memCache[String(t.user_id)];
          trialCharged++;
        } else if (!isAct(x) && new Date() - new Date(t.ends_at) > 0) {
          await pgPool.query("UPDATE trials SET cancelled_at=$2 WHERE user_id=$1", [t.user_id, exp || new Date()]);
          trialCancelled++;
        }
      }
    } catch (e) { console.log("[trial] sync:", e.message); }
    for (const x of list) {
      if (!x.telegramUserId || !kindOf(x)) continue; // другие продукты аккаунта пропускаем
      const key = x.telegramUserId + "|" + kindOf(x);
      const cur = best.get(key);
      const better = !cur || (isAct(x) && !isAct(cur)) ||
        (isAct(x) === isAct(cur) && new Date(x.expireAt || 0) > new Date(cur.expireAt || 0));
      if (better) best.set(key, x);
    }
    for (const x of best.values()) {
      const uid = x.telegramUserId; if (!uid) continue;
      const kind = kindOf(x);
      const isActive = isAct(x);
      const act = x.activatedAt ? new Date(x.activatedAt) : null;
      const exp = x.expireAt ? new Date(x.expireAt) : null;
      let planDays = 30;
      if (act && exp) { const dd = Math.round((exp - act) / 86400000); planDays = dd >= 300 ? 365 : dd >= 150 ? 180 : dd >= 75 ? 90 : 30; }
      await pgPool.query(
        "INSERT INTO subs (user_id, group_kind, joined_at, left_at, active, seeded, plan_days, expires_at, tribute_sub_id) VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,$8) " +
        "ON CONFLICT (user_id, group_kind) DO UPDATE SET joined_at=LEAST(COALESCE(subs.joined_at,$3),$3), active=$5, left_at=$4, plan_days=$6, expires_at=$7, tribute_sub_id=$8, seeded=FALSE",
        [uid, kind, act, isActive ? null : (exp || new Date()), isActive, planDays, exp, x.subscriptionId || null]
      );
      n++; if (isActive) active++;
    }
    // Уборка: раньше синхронизация записывала в AMORE подписчиков других продуктов (вебинар, курс, лекция).
    // Кто из них реально состоит в группе AMORE — остаётся участником (без привязки к подписке), остальные снимаются.
    let fixed = 0, kept = 0;
    try {
      const wrong = await pgPool.query("SELECT user_id FROM subs WHERE group_kind='main' AND tribute_sub_id IS NOT NULL AND NOT (tribute_sub_id = ANY($1::int[]))", [[...AMORE_SUB_IDS]]);
      for (const row of wrong.rows) {
        const m = GROUP_ID ? await tgChatMember(GROUP_ID, row.user_id) : null;
        if (!m) continue; // Telegram не ответил — не трогаем, поправится при следующей синхронизации
        const inGroup = ["creator", "administrator", "member", "restricted"].includes(m.status) && m.is_member !== false;
        if (inGroup) { await pgPool.query("UPDATE subs SET tribute_sub_id=NULL WHERE user_id=$1 AND group_kind='main'", [row.user_id]); kept++; }
        else { await pgPool.query("UPDATE subs SET active=FALSE, tribute_sub_id=NULL, left_at=COALESCE(left_at, NOW()) WHERE user_id=$1 AND group_kind='main'", [row.user_id]); fixed++; }
        await sleep(60);
      }
    } catch (e) { logReal("tributeSync cleanup", e); }
    const tot = await pgPool.query("SELECT COUNT(*) FILTER (WHERE group_kind='main' AND active)::int AS main, COUNT(*) FILTER (WHERE group_kind='mass' AND active)::int AS mass FROM subs").catch(function () { return { rows: [{}] }; });
    res.json({ ok: true, total: n, active, removed: fixed, kept, mainActive: tot.rows[0].main, massActive: tot.rows[0].mass, trialCharged, trialCancelled });
  } catch (e) { res.json({ ok: false, error: logReal("tributeSync", e) }); }
});

const PORT = process.env.PORT || 3000;
/* ================== АНАЛИТИКА ПРИЛОЖЕНИЯ ================== */
// Приложение шлёт короткие события (открыл, увидел замок, нажал «оплатить»…). По ним бот строит воронку /funnel.
let _evReady = false; const _evRate = new Map();
app.post("/event", async (req, res) => {
  res.json({ ok: true });
  try {
    if (!pgPool) return;
    const b = req.body || {};
    const user = verifyInitData(b.initData);
    if (!user || !user.id) return;
    const evName = String(b.ev || "").slice(0, 40);
    if (!/^[a-z_0-9]+$/.test(evName)) return;
    const now = Date.now(); const r = _evRate.get(user.id) || { t: now, n: 0 };
    if (now - r.t > 3600000) { r.t = now; r.n = 0; }
    if (++r.n > 300) return; _evRate.set(user.id, r);
    if (_evRate.size > 20000) _evRate.clear();
    if (!_evReady) {
      await pgPool.query("CREATE TABLE IF NOT EXISTS app_events (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id BIGINT NOT NULL, ev TEXT NOT NULL, p TEXT, src TEXT, member BOOLEAN)");
      await pgPool.query("CREATE INDEX IF NOT EXISTS app_events_ev_ts ON app_events (ev, ts)");
      _evReady = true;
    }
    const src = /^(yacht|washing)$/.test(String(b.src || "")) ? String(b.src) : null;
    const pj = b.p && typeof b.p === "object" ? JSON.stringify(b.p).slice(0, 300) : null;
    await pgPool.query("INSERT INTO app_events (user_id, ev, p, src, member) VALUES ($1,$2,$3,$4,$5)", [user.id, evName, pj, src, b.m == 1 || b.m === true]);
  } catch (e) { console.log("[event]", e.message); }
});

app.listen(PORT, () => console.log("AMORE backend on port " + PORT));
