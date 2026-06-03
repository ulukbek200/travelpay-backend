const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const loadLocalEnv = () => {
  const envFiles = [
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
  ];

  envFiles.forEach((envFile) => {
    if (!fs.existsSync(envFile)) return;

    fs.readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;

        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      });
  });
};

loadLocalEnv();

const app = express();
const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'travelpay';
let mongoClientPromise;
const DAY_MS = 24 * 60 * 60 * 1000;

class StorageUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.statusCode = options.statusCode || 503;
    this.code = options.code || 'STORAGE_UNAVAILABLE';
    this.cause = options.cause;
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const defaultDb = {
  users: [
    {
      id: 1,
      name: 'Admin',
      email: 'admin@travelpay.kg',
      password: 'admin123',
      balance: 10000,
      role: 'admin',
      avatar: 'https://www.w3schools.com/howto/img_avatar.png',
      isLoggedIn: true,
      favorites: [],
      savings: {
        goalAmount: 0,
        currentAmount: 0,
        durationMonths: 0,
        startDate: '',
        endDate: '',
        monthlyPayment: 0,
        status: 'cancelled',
      },
    },
  ],
  tours: [
    {
      id: 1,
      title: 'РўСѓСЂ РЅР° РСЃСЃС‹Рє-РљСѓР»СЊ',
      description: 'РћР·РµСЂРѕ, РіРѕСЂРЅС‹Рµ РїРµР№Р·Р°Р¶Рё, РєСѓРїР°РЅРёРµ Рё СЃРїРѕРєРѕР№РЅС‹Р№ РѕС‚РґС‹С… РЅР° Р±РµСЂРµРіСѓ.',
      duration: '4 РґРЅСЏ',
      price: 14000,
      image: 'https://sputnik.kg/img/102749/78/1027497816_0:0:5241:3494_600x0_80_0_0_1de71c91552a01c3bc55f0df20f16329.jpg',
      location: 'РСЃСЃС‹Рє-РљСѓР»СЊ',
    },
    {
      id: 2,
      title: 'Р‘Р°С€РЅСЏ Р‘СѓСЂР°РЅР°',
      description: 'РСЃС‚РѕСЂРёС‡РµСЃРєРёР№ РѕРґРЅРѕРґРЅРµРІРЅС‹Р№ С‚СѓСЂ РїРѕ СЃР»РµРґР°Рј Р’РµР»РёРєРѕРіРѕ С€РµР»РєРѕРІРѕРіРѕ РїСѓС‚Рё.',
      duration: '1 РґРµРЅСЊ',
      price: 2500,
      image: 'https://central-asia.live/_next/image?url=https%3A%2F%2Fcentral-asia.live%2Fuploads%2Fburana-tower.jpg&w=3840&q=75',
      location: 'Р§СѓР№СЃРєР°СЏ РѕР±Р»Р°СЃС‚СЊ',
    },
  ],
};

const ensureDb = () => {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), 'utf8');
  }
};

const stripMongoId = ({ _id, ...item }) => item;

const isMongoConnectionError = (error) => {
  const message = error?.message?.toLowerCase() || '';
  const name = error?.name || '';

  return (
    name.includes('Mongo') ||
    message.includes('mongodb') ||
    message.includes('querysrv') ||
    message.includes('authentication failed') ||
    message.includes('bad auth') ||
    message.includes('server selection')
  );
};

const getMongoDb = async ({ allowFallback = false } = {}) => {
  if (!MONGODB_URI) return null;

  try {
    if (!mongoClientPromise) {
      const client = new MongoClient(MONGODB_URI);
      mongoClientPromise = client.connect();
    }

    const client = await mongoClientPromise;
    return client.db(MONGODB_DB_NAME);
  } catch (error) {
    mongoClientPromise = null;

    if (allowFallback) {
      console.error('MongoDB unavailable, falling back to local db for read-only operations:', error);
      return null;
    }

    throw new StorageUnavailableError(
      'Database connection failed. Check MONGODB_URI, MongoDB user password, and Network Access in MongoDB Atlas.',
      { code: 'DATABASE_UNAVAILABLE', cause: error },
    );
  }
};

const seedMongoIfEmpty = async (db) => {
  const [usersCount, toursCount] = await Promise.all([
    db.collection('users').countDocuments(),
    db.collection('tours').countDocuments(),
  ]);

  if (!usersCount) {
    await db.collection('users').insertMany(defaultDb.users);
  }

  if (!toursCount) {
    await db.collection('tours').insertMany(defaultDb.tours);
  }
};

const readDb = async () => {
  const mongoDb = await getMongoDb({ allowFallback: true });

  if (mongoDb) {
    await seedMongoIfEmpty(mongoDb);
    const [users, tours] = await Promise.all([
      mongoDb.collection('users').find({}).sort({ id: 1 }).toArray(),
      mongoDb.collection('tours').find({}).sort({ id: 1 }).toArray(),
    ]);

    return {
      users: users.map(stripMongoId).map(normalizeUser),
      tours: tours.map(stripMongoId),
    };
  }

  ensureDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users)
        ? parsed.users.map(normalizeUser)
        : [],
      tours: Array.isArray(parsed.tours) ? parsed.tours : [],
    };
  } catch (error) {
    return defaultDb;
  }
};

const writeDb = (db) => {
  if (process.env.VERCEL && !MONGODB_URI) {
    throw new StorageUnavailableError(
      'Persistent storage is not configured. Set MONGODB_URI for deployed writes.',
      { code: 'PERSISTENT_STORAGE_UNAVAILABLE' },
    );
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
};

const saveDb = async (data) => {
  const mongoDb = await getMongoDb();

  if (!mongoDb) {
    writeDb(data);
    return;
  }

  const users = data.users.map(stripMongoId);
  const tours = data.tours.map(stripMongoId);

  await Promise.all([
    mongoDb.collection('users').deleteMany({}),
    mongoDb.collection('tours').deleteMany({}),
  ]);

  await Promise.all([
    users.length ? mongoDb.collection('users').insertMany(users) : Promise.resolve(),
    tours.length ? mongoDb.collection('tours').insertMany(tours) : Promise.resolve(),
  ]);
};

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const nextId = (items) => {
  const maxId = items.reduce((max, item) => {
    const value = Number(item.id);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return maxId + 1;
};

const normalizeTour = (tour) => ({
  ...tour,
  title: String(tour.title || '').trim(),
  description: String(tour.description || '').trim(),
  duration: String(tour.duration || '').trim(),
  location: String(tour.location || '').trim(),
  image: String(tour.image || '').trim(),
  price: Number(tour.price) || 0,
});

const normalizeSavings = (savings) => {
  if (!savings || typeof savings !== 'object') {
    return {
      goalAmount: 0,
      currentAmount: 0,
      durationMonths: 0,
      startDate: '',
      endDate: '',
      monthlyPayment: 0,
      status: 'cancelled',
    };
  }

  const goalAmount = Number(savings.goalAmount) || 0;
  const currentAmount = Number(savings.currentAmount) || 0;
  const durationMonths = Number(savings.durationMonths) || 0;
  const monthlyPayment = Number(savings.monthlyPayment) || 0;
  const startDate = savings.startDate ? new Date(savings.startDate).toISOString() : '';
  const endDate = savings.endDate ? new Date(savings.endDate).toISOString() : '';
  let status = savings.status || 'cancelled';

  if (!goalAmount || !durationMonths || !startDate) {
    status = 'cancelled';
  } else if (currentAmount >= goalAmount) {
    status = 'completed';
  } else if (endDate && new Date(endDate).getTime() < Date.now()) {
    status = 'expired';
  } else if (status !== 'cancelled') {
    status = 'active';
  }

  return {
    goalAmount,
    currentAmount,
    durationMonths,
    startDate,
    endDate,
    monthlyPayment,
    status,
  };
};

const ensureArray = (value) => (Array.isArray(value) ? value : []);
const normalizeString = (value, fallback = '') => String(value || fallback).trim();
const normalizeDateValue = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};
const createId = (prefix = 'id') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeTopUp = (entry) => ({
  id: entry?.id || createId('topup'),
  date: normalizeDateValue(entry?.date) || new Date().toISOString(),
  amount: Number(entry?.amount) || 0,
  status: normalizeString(entry?.status, 'completed') || 'completed',
  source: normalizeString(entry?.source, 'manual') || 'manual',
});

const normalizeBooking = (booking) => ({
  id: booking?.id || createId('booking'),
  tourId: booking?.tourId || booking?.id || '',
  tourTitle: normalizeString(booking?.tourTitle || booking?.title),
  location: normalizeString(booking?.location),
  image: normalizeString(booking?.image),
  amount: Number(booking?.amount) || Number(booking?.price) || 0,
  status: normalizeString(booking?.status, 'paid') || 'paid',
  purchasedAt: normalizeDateValue(booking?.purchasedAt || booking?.date) || new Date().toISOString(),
  travelDate: normalizeDateValue(booking?.travelDate) || '',
  paymentMethod: normalizeString(booking?.paymentMethod, 'savings') || 'savings',
});

const normalizeNotification = (item) => ({
  id: item?.id || createId('notification'),
  type: normalizeString(item?.type, 'info') || 'info',
  title: normalizeString(item?.title, 'Уведомление') || 'Уведомление',
  description: normalizeString(item?.description),
  date: normalizeDateValue(item?.date) || new Date().toISOString(),
  read: Boolean(item?.read),
});

const normalizeChallenge = (item) => ({
  id: item?.id || 'challenge-20000-30',
  title: normalizeString(item?.title, 'Накопить 20 000 сом за 30 дней') || 'Накопить 20 000 сом за 30 дней',
  targetAmount: Number(item?.targetAmount) || 20000,
  periodDays: Number(item?.periodDays) || 30,
  startDate: normalizeDateValue(item?.startDate) || new Date().toISOString(),
  completed: Boolean(item?.completed),
  rewardTitle: normalizeString(item?.rewardTitle, 'Challenge completed') || 'Challenge completed',
});

const normalizeBonusWheel = (bonusWheel) => ({
  lastSpinDate: normalizeDateValue(bonusWheel?.lastSpinDate),
  availableAt: normalizeDateValue(bonusWheel?.availableAt),
  history: ensureArray(bonusWheel?.history).map((entry) => ({
    id: entry?.id || createId('bonus'),
    rewardType: normalizeString(entry?.rewardType, 'bonus_som') || 'bonus_som',
    rewardValue: Number(entry?.rewardValue) || 0,
    label: normalizeString(entry?.label, '100 сом') || '100 сом',
    date: normalizeDateValue(entry?.date) || new Date().toISOString(),
  })),
});

const normalizeReferral = (referral, user) => {
  const baseCode = normalizeString(referral?.code || user?.email || user?.name || `travelpay-${user?.id || 'user'}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || `travelpay-${user?.id || 'user'}`;

  const invitedCount = Number(referral?.invitedCount) || ensureArray(referral?.invitedUsers).length || 0;
  const bonusAmount = Number(referral?.bonusAmount) || invitedCount * 1000;

  return {
    code: baseCode,
    link: `https://travelpay.app/ref/${baseCode}`,
    invitedCount,
    bonusAmount,
    invitedUsers: ensureArray(referral?.invitedUsers).map((entry) => ({
      email: normalizeString(entry?.email),
      joinedAt: normalizeDateValue(entry?.joinedAt) || new Date().toISOString(),
    })),
  };
};

const deriveLevel = (amount) => {
  if (amount >= 150000) return 'Platinum';
  if (amount >= 100000) return 'Gold';
  if (amount >= 50000) return 'Silver';
  return 'Bronze';
};

const normalizeUser = (user) => {
  if (!user) return null;

  const savings = normalizeSavings(user.savings);
  const topUps = ensureArray(user.topUps).map(normalizeTopUp).sort((a, b) => new Date(b.date) - new Date(a.date));
  const travelHistory = ensureArray(user.travelHistory || user.bookings).map(normalizeBooking).sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));
  const notifications = ensureArray(user.notifications).map(normalizeNotification).sort((a, b) => new Date(b.date) - new Date(a.date));
  const challenges = ensureArray(user.challenges).length
    ? ensureArray(user.challenges).map(normalizeChallenge)
    : [normalizeChallenge()];
  const bonusWheel = normalizeBonusWheel(user.bonusWheel);
  const referral = normalizeReferral(user.referral, user);

  const topUpTotal = topUps.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const currentAmount = Number(savings.currentAmount) || 0;
  const level = user.level || deriveLevel(Math.max(currentAmount, topUpTotal));

  const streakMonths = topUps.reduce((max, entry) => {
    const diffDays = Math.max(Math.floor((Date.now() - new Date(entry.date).getTime()) / DAY_MS), 0);
    return diffDays <= 120 ? Math.max(max, 1 + Math.floor((120 - diffDays) / 30)) : max;
  }, 0);

  const challenge = challenges[0];
  const challengeDeadline = challenge?.startDate
    ? new Date(new Date(challenge.startDate).getTime() + challenge.periodDays * DAY_MS)
    : null;
  const challengeCurrentAmount = topUps
    .filter((entry) => challenge?.startDate && new Date(entry.date).getTime() >= new Date(challenge.startDate).getTime())
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const challengeCompleted = challengeCurrentAmount >= (challenge?.targetAmount || 0);

  const achievementSet = new Set(ensureArray(user.achievements).map((item) => normalizeString(item)));
  if (currentAmount >= 10000) achievementSet.add('Первые 10 000 сом');
  if (currentAmount >= 50000) achievementSet.add('Первые 50 000 сом');
  if (savings.status === 'completed') achievementSet.add('Цель достигнута');
  if (travelHistory.length > 0) achievementSet.add('Первая поездка');
  if (challengeCompleted) achievementSet.add(challenge.rewardTitle);

  return {
    ...user,
    name: normalizeString(user.name),
    email: normalizeString(user.email).toLowerCase(),
    phone: normalizeString(user.phone),
    role: normalizeString(user.role, 'user') || 'user',
    avatar: normalizeString(user.avatar, 'https://www.w3schools.com/howto/img_avatar.png') || 'https://www.w3schools.com/howto/img_avatar.png',
    favorites: ensureArray(user.favorites),
    balance: Number(user.balance) || 0,
    savings,
    topUps,
    travelHistory,
    bookings: travelHistory,
    notifications,
    referral,
    bonusWheel,
    challenges: challenges.map((item, index) => (index === 0 ? {
      ...item,
      currentAmount: challengeCurrentAmount,
      deadline: challengeDeadline ? challengeDeadline.toISOString() : '',
      completed: item.completed || challengeCompleted,
    } : item)),
    achievements: Array.from(achievementSet),
    level,
    travelStreakMonths: Math.max(Number(user.travelStreakMonths) || 0, streakMonths),
  };
};

const sanitizeUser = (user) => {
  if (!user) return null;

  const normalizedUser = normalizeUser(user);
  const { password, ...safeUser } = normalizedUser;
  return safeUser;
};

const aiRateLimit = new Map();

const isAiRateLimited = (ip) => {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 15;
  const history = aiRateLimit.get(ip) || [];
  const recent = history.filter((time) => now - time < windowMs);

  if (recent.length >= maxRequests) {
    aiRateLimit.set(ip, recent);
    return true;
  }

  recent.push(now);
  aiRateLimit.set(ip, recent);
  return false;
};

const formatTourForAssistant = (tour) => {
  const price = tour.price ? `${tour.price} KGS` : 'цена по запросу';
  return `- ${tour.title}: ${tour.location || 'направление уточняется'}, ${tour.duration || 'длительность уточняется'}, ${price}. ${tour.description || ''}`;
};

const buildPremiumTravelPayPrompt = ({ message, profile = '', favorites = '[]', tours = [] }) => {
  const toursInfo = tours.slice(0, 20).map(formatTourForAssistant).join('\n');

  return `
Ты — премиальный AI-ассистент платформы TravelPay.

Твоя задача — помогать пользователям с поиском туров, бронированием, оплатой,
возвратами, статусами платежей, безопасностью аккаунта, рекомендациями
путешествий и поддержкой клиентов.

Ты должен вести себя как живой premium travel-консьерж, а не как обычный бот.
Ты можешь отвечать на любые общие вопросы пользователя, если это не требует
выдумывать реальные платежи, бронирования, цены, документы или действия системы.

Стиль общения:
- отвечай дружелюбно и уверенно;
- пиши естественно, как человек;
- не отвечай слишком длинно;
- используй понятный язык;
- будь современным и энергичным;
- иногда задавай уточняющие вопросы;
- помогай пользователю дойти до результата;
- не используй сухие AI-фразы;
- не говори "как искусственный интеллект";
- не говори "я не имею доступа", вместо этого мягко объясняй ограничения.

Поведение:
- если пользователь спрашивает про накопления, анализируй goalAmount, currentAmount, durationMonths, monthlyPayment, endDate и topUps из профиля;
- умей считать, через сколько месяцев будет достигнута цель, если пользователь назвал сумму ежемесячного пополнения;
- если пользователь спрашивает, какие туры доступны сейчас, сравни currentAmount накоплений с ценами туров из базы;
- если пользователь спрашивает, сколько осталось до цели, считай остаток и подсказывай, какой взнос нужен до конца года или до конца срока;
- если пользователь ищет тур, спроси бюджет, даты, направление и количество человек;
- если хочет оплатить, объясни шаги оплаты;
- если спрашивает статус, попроси payment ID или номер бронирования;
- если хочет возврат, объясни процесс возврата и попроси номер бронирования/payment ID;
- если не знает куда поехать, предложи варианты под сезон, бюджет и стиль отдыха;
- если злится, отвечай спокойно и профессионально;
- если пишет коротко, отвечай коротко;
- если пишет подробно, отвечай подробнее.

Важные правила:
- никогда не выдумывай платежи;
- никогда не придумывай бронирования;
- не придумывай цены;
- не обещай то, чего система не умеет;
- если считаешь рекомендации по накоплениям, явно показывай формулу и вывод коротко;
- если информации недостаточно, задай вопрос;
- если запрос связан с аккаунтом, попроси уточняющие данные;
- цены называй только из базы TravelPay, иначе говори "цену нужно уточнить";
- если вопрос не про TravelPay или туризм, всё равно помоги кратко и полезно.

Ты хорошо разбираешься в путешествиях, популярных направлениях, авиаперелетах,
отелях, визах, страховании, бронировании туров, семейном отдыхе, luxury travel
и бюджетных поездках.

Тон бренда TravelPay: premium, минимализм, технологичность, удобство,
безопасность, быстрое бронирование и онлайн-оплата.

Отвечай на языке пользователя: RU, KG или EN.

Профиль пользователя:
${profile || 'Нет данных'}

Избранные туры:
${favorites || '[]'}

Туры из базы TravelPay:
${toursInfo || 'Пока нет туров в базе.'}

Вопрос пользователя:
${message}
`;
};

const buildOpenAiMessages = (context) => [
  {
    role: 'system',
    content: buildPremiumTravelPayPrompt(context),
  },
  {
    role: 'user',
    content: context.message,
  },
];

const askOpenAi = async (context) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_OPENAI_API_KEY') return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: buildOpenAiMessages(context),
        temperature: 0.7,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } finally {
    clearTimeout(timeout);
  }
};

const askGemini = async (context) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY') return null;

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: buildPremiumTravelPayPrompt(context),
  });

  return response.text || null;
};

const premiumOfflineReply = (message, tours) => {
  const query = String(message || '').toLowerCase();
  const wantsPayment = query.includes('payment') || query.includes('оплат') || query.includes('платеж') || query.includes('платёж');
  const wantsRefund = query.includes('возврат') || query.includes('refund') || query.includes('вернуть');
  const wantsStatus = query.includes('статус') || query.includes('где мой платеж') || query.includes('где мой платёж');

  if (wantsStatus || wantsPayment) {
    return 'Я помогу проверить оплату. Отправьте, пожалуйста, payment ID или номер бронирования — без этих данных статус лучше не угадывать.';
  }

  if (wantsRefund) {
    return 'Помогу с возвратом. Обычно нужно отправить заявку, затем TravelPay проверяет оплату и условия тарифа/партнёра. Пришлите номер бронирования или payment ID — подскажу следующий шаг.';
  }

  const recommendedTours = tours.slice(0, 3).map(formatTourForAssistant).join('\n');

  if (recommendedTours) {
    return `Отлично, подберём комфортный вариант. Подскажите направление, даты, количество человек и примерный бюджет.\n\nСейчас в базе TravelPay есть:\n${recommendedTours}`;
  }

  return 'Отлично, подберём поездку под вас. Подскажите, пожалуйста: куда хотите поехать, даты, сколько человек и примерный бюджет?';
};

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'TravelPay API' });
});

app.post('/api/ai-chat', asyncHandler(async (req, res) => {
  const fallbackReply = 'Сейчас ассистент временно недоступен, попробуйте позже.';

  try {
    const { message, history = [] } = req.body || {};
    const userMessage = String(message || '').trim();

    if (!userMessage) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'мой_ключ_сюда') {
      return res.status(500).json({ reply: fallbackReply });
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const safeHistory = Array.isArray(history) ? history : [];

    const systemPrompt = `
Ты TravelPay AI — умный помощник платформы TravelPay.
Отвечай на русском языке.
Помогай пользователю:
- подобрать тур по Кыргызстану;
- объяснить накопление на путешествие;
- рассчитать примерный ежемесячный платеж;
- рассказать про бронирование;
- объяснить, как работает TravelPay;
- давать советы по отдыху, бюджету и маршрутам.

Не отвечай на темы, не связанные с TravelPay, туризмом, путешествиями, Кыргызстаном, оплатой и накоплением.
Отвечай понятно, коротко и дружелюбно.
`;

    const chatText = `
${systemPrompt}

История диалога:
${safeHistory.map((item) => `${item.role}: ${item.content}`).join('\n')}

Пользователь: ${userMessage}
TravelPay AI:
`;

    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: chatText,
    });

    return res.json({ reply: result.text || fallbackReply });
  } catch (error) {
    console.error('AI error:', error);
    return res.status(500).json({ reply: fallbackReply });
  }
}));

app.post('/api/ai-assistant', asyncHandler(async (req, res) => {
  try {
    if (isAiRateLimited(req.ip || req.socket.remoteAddress || 'local')) {
      return res.status(429).json({ error: 'Too many AI requests. Please try again in a minute.' });
    }

    const message = String(req.body.message || '').trim();
    const profile = req.body.profile || '';
    const favorites = req.body.favorites || '[]';
    const { tours } = await readDb();

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const aiContext = { message, profile, favorites, tours };
    const hasOpenAi = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'YOUR_OPENAI_API_KEY';
    const hasGemini = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY';

    if (!hasOpenAi && !hasGemini) {
      const answer = premiumOfflineReply(message, tours);
      return res.status(200).json({ answer, reply: answer, provider: 'offline' });
    }

    const openAiAnswer = await askOpenAi(aiContext);
    if (openAiAnswer) {
      return res.status(200).json({ answer: openAiAnswer, reply: openAiAnswer, provider: 'openai' });
    }

    const geminiAnswer = await askGemini(aiContext);
    if (geminiAnswer) {
      return res.status(200).json({ answer: geminiAnswer, reply: geminiAnswer, provider: 'gemini' });
    }

    const answer = premiumOfflineReply(message, tours);
    return res.status(200).json({ answer, reply: answer, provider: 'offline' });
  } catch (error) {
    console.error('AI assistant error:', error);
    const { tours } = await readDb();
    const answer = premiumOfflineReply(req.body?.message, tours);
    return res.status(200).json({ answer, reply: answer, provider: 'offline', warning: 'AI provider unavailable' });
  }
}));

app.get('/tours', asyncHandler(async (req, res) => {
  const db = await readDb();
  res.json(db.tours);
}));

app.post('/auth/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const db = await readDb();
  const user = db.users.find(
    (item) => String(item.email).toLowerCase() === email && String(item.password) === password,
  );

  if (!user) {
    return res.status(401).json({ message: 'Неверный email или пароль.' });
  }

  res.json(sanitizeUser({ ...user, isLoggedIn: true }));
}));

app.post('/tours', asyncHandler(async (req, res) => {
  const db = await readDb();
  const tour = normalizeTour({ ...req.body, id: nextId(db.tours) });

  if (!tour.title || !tour.description || !tour.image || !tour.price) {
    return res.status(400).json({ message: 'Р—Р°РїРѕР»РЅРёС‚Рµ РЅР°Р·РІР°РЅРёРµ, РѕРїРёСЃР°РЅРёРµ, С†РµРЅСѓ Рё РєР°СЂС‚РёРЅРєСѓ С‚СѓСЂР°.' });
  }

  db.tours.push(tour);
  await saveDb(db);
  res.status(201).json(tour);
}));

app.put('/tours/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const id = Number(req.params.id);
  const index = db.tours.findIndex((tour) => Number(tour.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'РўСѓСЂ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  db.tours[index] = normalizeTour({ ...db.tours[index], ...req.body, id });
  await saveDb(db);
  res.json(db.tours[index]);
}));

app.delete('/tours/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const id = Number(req.params.id);
  const nextTours = db.tours.filter((tour) => Number(tour.id) !== id);

  if (nextTours.length === db.tours.length) {
    return res.status(404).json({ message: 'РўСѓСЂ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  db.tours = nextTours;
  await saveDb(db);
  res.status(204).end();
}));

app.get('/users', asyncHandler(async (req, res) => {
  const { email } = req.query;
  const { users } = await readDb();
  const result = email
    ? users.filter((user) => String(user.email).toLowerCase() === String(email).toLowerCase())
    : users;

  res.json(result.map(sanitizeUser));
}));

app.get('/users/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { users } = await readDb();
  const user = users.find((item) => Number(item.id) === id);

  if (!user) {
    return res.status(404).json({ message: 'Пользователь не найден.' });
  }

  res.json(sanitizeUser(user));
}));

app.post('/users', asyncHandler(async (req, res) => {
  const db = await readDb();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!req.body.name || !email || !req.body.password) {
    return res.status(400).json({ message: 'РРјСЏ, email Рё РїР°СЂРѕР»СЊ РѕР±СЏР·Р°С‚РµР»СЊРЅС‹.' });
  }

  if (db.users.some((user) => String(user.email).toLowerCase() === email)) {
    return res.status(409).json({ message: 'РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ СЃ С‚Р°РєРёРј email СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓРµС‚.' });
  }

  const user = normalizeUser({
    id: nextId(db.users),
    name: String(req.body.name).trim(),
    email,
    password: String(req.body.password),
    balance: Number(req.body.balance) || 0,
    avatar: req.body.avatar || 'https://www.w3schools.com/howto/img_avatar.png',
    role: req.body.role || 'user',
    isLoggedIn: true,
    favorites: Array.isArray(req.body.favorites) ? req.body.favorites : [],
    savings: normalizeSavings(req.body.savings),
    topUps: req.body.topUps,
    notifications: req.body.notifications,
    achievements: req.body.achievements,
    referral: req.body.referral,
    bonusWheel: req.body.bonusWheel,
    challenges: req.body.challenges,
    travelHistory: req.body.travelHistory,
    bookings: req.body.bookings,
  });

  db.users.push(user);
  await saveDb(db);
  res.status(201).json(sanitizeUser(user));
}));

app.put('/users/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const id = Number(req.params.id);
  const index = db.users.findIndex((user) => Number(user.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  db.users[index] = normalizeUser({
    ...db.users[index],
    ...req.body,
    id,
    balance: Number(req.body.balance ?? db.users[index].balance) || 0,
    favorites: Array.isArray(req.body.favorites) ? req.body.favorites : db.users[index].favorites,
    savings: normalizeSavings(req.body.savings ?? db.users[index].savings),
  });

  await saveDb(db);
  res.json(sanitizeUser(db.users[index]));
}));

app.put('/users/:id/favorites', asyncHandler(async (req, res) => {
  const db = await readDb();
  const id = Number(req.params.id);
  const index = db.users.findIndex((user) => Number(user.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'Пользователь не найден.' });
  }

  db.users[index] = normalizeUser({
    ...db.users[index],
    favorites: Array.isArray(req.body.favorites) ? req.body.favorites : [],
  });

  await saveDb(db);
  res.json(sanitizeUser(db.users[index]));
}));

app.delete('/users/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const id = Number(req.params.id);
  const nextUsers = db.users.filter((user) => Number(user.id) !== id);

  if (nextUsers.length === db.users.length) {
    return res.status(404).json({ message: 'РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  db.users = nextUsers;
  await saveDb(db);
  res.status(204).end();
}));

const detectLanguage = (message) => {
  const text = String(message || '').toLowerCase();
  if (/[үңөқғһ]/i.test(text)) return 'KG';
  if (/[а-яё]/i.test(text)) return 'RU';
  return 'EN';
};

app.post('/api/chat', asyncHandler(async (req, res) => {
  const message = String(req.body.message || '').trim();
  const { tours } = await readDb();

  if (!message) {
    return res.json({ reply: 'Напишите направление, даты, количество путешественников и примерный бюджет — подберу лучший вариант.' });
  }

  const profile = req.body.profile || '';
  const favorites = req.body.favorites || '[]';
  const aiContext = { message, profile, favorites, tours };
  try {
    const openAiAnswer = await askOpenAi(aiContext);
    if (openAiAnswer) {
      return res.json({ reply: openAiAnswer, provider: 'openai' });
    }

    const geminiAnswer = await askGemini(aiContext);
    if (geminiAnswer) {
      return res.json({ reply: geminiAnswer, provider: 'gemini' });
    }

    const prompt = buildPremiumTravelPayPrompt(aiContext);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'qwen3:8b',
        prompt,
        stream: false,
        options: { temperature: 0.6 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Ollama status ${response.status}`);
    }

    const data = await response.json();
    const reply = data.response || premiumOfflineReply(message, tours);
    return res.json({ reply });
  } catch (error) {
    return res.json({ reply: premiumOfflineReply(message, tours) });
  }
}));

app.use((error, req, res, next) => {
  console.error('API error:', error);
  const isStorageError = error instanceof StorageUnavailableError;
  const isMongoError = isMongoConnectionError(error) || isMongoConnectionError(error?.cause);
  const statusCode = error.statusCode || (isStorageError || isMongoError ? 503 : 500);

  if (isStorageError || isMongoError) {
    return res.status(statusCode).json({
      code: error.code || 'DATABASE_UNAVAILABLE',
      message: 'База данных временно недоступна. Проверьте MONGODB_URI, пароль пользователя MongoDB и Network Access в MongoDB Atlas.',
    });
  }

  res.status(statusCode).json({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TravelPay API is running on http://localhost:${PORT}`);
  });
}

module.exports = app;


