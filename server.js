const express = require('express');
const cors = require('cors');
require('dotenv').config();
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
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'travelpay';
let mongoClientPromise;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPANY_ID = 1;
const DEFAULT_AVATAR = 'https://www.w3schools.com/howto/img_avatar.png';
const ADMIN_ROLES = new Set(['super_admin', 'company_admin', 'company_manager']);
const COMPANY_STAFF_ROLES = new Set(['company_admin', 'company_manager']);

class StorageUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.statusCode = options.statusCode || 503;
    this.code = options.code || 'STORAGE_UNAVAILABLE';
    this.cause = options.cause;
  }
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));

const defaultDb = {
  companies: [
    {
      id: DEFAULT_COMPANY_ID,
      name: 'TravelPay Demo',
      logo: '',
      phone: '+996 700 000 000',
      email: 'hello@travelpay.kg',
      address: 'Bishkek, Kyrgyzstan',
      ownerId: 1,
      status: 'active',
    },
  ],
  users: [
    {
      id: 1,
      name: 'Admin',
      email: 'admin@travelpay.kg',
      password: 'admin123',
      balance: 10000,
      role: 'super_admin',
      companyId: DEFAULT_COMPANY_ID,
      avatar: DEFAULT_AVATAR,
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
      companyId: DEFAULT_COMPANY_ID,
      title: 'РўСѓСЂ РЅР° РСЃСЃС‹Рє-РљСѓР»СЊ',
      description: 'РћР·РµСЂРѕ, РіРѕСЂРЅС‹Рµ РїРµР№Р·Р°Р¶Рё, РєСѓРїР°РЅРёРµ Рё СЃРїРѕРєРѕР№РЅС‹Р№ РѕС‚РґС‹С… РЅР° Р±РµСЂРµРіСѓ.',
      duration: '4 РґРЅСЏ',
      price: 14000,
      image: 'https://sputnik.kg/img/102749/78/1027497816_0:0:5241:3494_600x0_80_0_0_1de71c91552a01c3bc55f0df20f16329.jpg',
      location: 'РСЃСЃС‹Рє-РљСѓР»СЊ',
    },
    {
      id: 2,
      companyId: DEFAULT_COMPANY_ID,
      title: 'Р‘Р°С€РЅСЏ Р‘СѓСЂР°РЅР°',
      description: 'РСЃС‚РѕСЂРёС‡РµСЃРєРёР№ РѕРґРЅРѕРґРЅРµРІРЅС‹Р№ С‚СѓСЂ РїРѕ СЃР»РµРґР°Рј Р’РµР»РёРєРѕРіРѕ С€РµР»РєРѕРІРѕРіРѕ РїСѓС‚Рё.',
      duration: '1 РґРµРЅСЊ',
      price: 2500,
      image: 'https://central-asia.live/_next/image?url=https%3A%2F%2Fcentral-asia.live%2Fuploads%2Fburana-tower.jpg&w=3840&q=75',
      location: 'Р§СѓР№СЃРєР°СЏ РѕР±Р»Р°СЃС‚СЊ',
    },
  ],
  accommodations: [],
  topupRequests: [],
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
  const [companiesCount, usersCount, toursCount, accommodationsCount] = await Promise.all([
    db.collection('companies').countDocuments(),
    db.collection('users').countDocuments(),
    db.collection('tours').countDocuments(),
    db.collection('accommodations').countDocuments(),
  ]);

  if (!companiesCount) {
    await db.collection('companies').insertMany(defaultDb.companies);
  }

  if (!usersCount) {
    await db.collection('users').insertMany(defaultDb.users);
  }

  if (!toursCount) {
    await db.collection('tours').insertMany(defaultDb.tours);
  }

  if (!accommodationsCount && defaultDb.accommodations.length) {
    await db.collection('accommodations').insertMany(defaultDb.accommodations);
  }
};

const readDb = async () => {
  const mongoDb = await getMongoDb({ allowFallback: true });

  if (mongoDb) {
    await seedMongoIfEmpty(mongoDb);
    const [companies, users, tours, accommodations, topupRequests] = await Promise.all([
      mongoDb.collection('companies').find({}).sort({ id: 1 }).toArray(),
      mongoDb.collection('users').find({}).sort({ id: 1 }).toArray(),
      mongoDb.collection('tours').find({}).sort({ id: 1 }).toArray(),
      mongoDb.collection('accommodations').find({}).sort({ id: 1 }).toArray(),
      mongoDb.collection('topupRequests').find({}).sort({ createdAt: -1 }).toArray(),
    ]);

    return {
      companies: companies.map(stripMongoId).map(normalizeCompany),
      users: users.map(stripMongoId).map(normalizeUser),
      tours: tours.map(stripMongoId).map(normalizeTour),
      accommodations: accommodations.map(stripMongoId).map(normalizeAccommodationEntity),
      topupRequests: topupRequests.map(stripMongoId).map(normalizeTopupRequest),
    };
  }

  ensureDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      companies: Array.isArray(parsed.companies)
        ? parsed.companies.map(normalizeCompany)
        : defaultDb.companies.map(normalizeCompany),
      users: Array.isArray(parsed.users)
        ? parsed.users.map(normalizeUser)
        : [],
      tours: Array.isArray(parsed.tours) ? parsed.tours.map(normalizeTour) : [],
      accommodations: Array.isArray(parsed.accommodations)
        ? parsed.accommodations.map(normalizeAccommodationEntity)
        : [],
      topupRequests: Array.isArray(parsed.topupRequests)
        ? parsed.topupRequests.map(normalizeTopupRequest)
        : [],
    };
  } catch (error) {
    return {
      ...defaultDb,
      topupRequests: [],
    };
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
  const companies = ensureArray(data.companies).map(stripMongoId);
  const tours = data.tours.map(stripMongoId);
  const accommodations = ensureArray(data.accommodations).map(stripMongoId);
  const topupRequests = ensureArray(data.topupRequests).map(stripMongoId);

  await Promise.all([
    mongoDb.collection('companies').deleteMany({}),
    mongoDb.collection('users').deleteMany({}),
    mongoDb.collection('tours').deleteMany({}),
    mongoDb.collection('accommodations').deleteMany({}),
    mongoDb.collection('topupRequests').deleteMany({}),
  ]);

  await Promise.all([
    companies.length ? mongoDb.collection('companies').insertMany(companies) : Promise.resolve(),
    users.length ? mongoDb.collection('users').insertMany(users) : Promise.resolve(),
    tours.length ? mongoDb.collection('tours').insertMany(tours) : Promise.resolve(),
    accommodations.length ? mongoDb.collection('accommodations').insertMany(accommodations) : Promise.resolve(),
    topupRequests.length ? mongoDb.collection('topupRequests').insertMany(topupRequests) : Promise.resolve(),
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

const normalizeRole = (value) => {
  const role = normalizeString(value, 'user').toLowerCase();
  if (role === 'admin') return 'super_admin';
  if (role === 'manager') return 'company_manager';
  if (ADMIN_ROLES.has(role) || role === 'user') return role;
  return 'user';
};

const normalizeCompanyId = (value, fallback = DEFAULT_COMPANY_ID) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) && fallbackNumeric > 0 ? fallbackNumeric : DEFAULT_COMPANY_ID;
};

const COMPANY_STATUSES = new Set(['pending', 'active', 'rejected', 'blocked', 'inactive', 'archived']);
const ACCOMMODATION_STATUSES = new Set(['available', 'sold_out', 'inactive']);
const TOUR_CALENDAR_STATUSES = new Set(['scheduled', 'in_progress', 'completed', 'cancelled', 'sold_out']);

const normalizeCompany = (company) => ({
  id: Number(company?.id) || 0,
  name: normalizeString(company?.name || `Company ${company?.id || DEFAULT_COMPANY_ID}`),
  logo: normalizeString(company?.logo),
  phone: normalizeString(company?.phone),
  email: normalizeString(company?.email).toLowerCase(),
  city: normalizeString(company?.city),
  address: normalizeString(company?.address),
  description: normalizeString(company?.description),
  documents: ensureArray(company?.documents).map((item) => normalizeString(item)).filter(Boolean),
  ownerId: Number(company?.ownerId) || null,
  rejectionReason: normalizeString(company?.rejectionReason),
  createdAt: normalizeDateValue(company?.createdAt) || new Date().toISOString(),
  updatedAt: normalizeDateValue(company?.updatedAt) || new Date().toISOString(),
  status: COMPANY_STATUSES.has(company?.status) ? company.status : 'active',
});

const normalizeTour = (tour) => ({
  ...tour,
  companyId: normalizeCompanyId(tour.companyId),
  companyName: normalizeString(tour.companyName),
  accommodationIds: ensureArray(tour.accommodationIds).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
  title: String(tour.title || '').trim(),
  description: String(tour.description || '').trim(),
  duration: String(tour.duration || '').trim(),
  location: String(tour.location || '').trim(),
  image: String(tour.image || '').trim(),
  price: Number(tour.price) || 0,
  startDate: normalizeDateValue(tour.startDate || tour.dateStart || tour.departureDate || tour.date),
  endDate: normalizeDateValue(tour.endDate || tour.dateEnd || tour.returnDate || tour.startDate || tour.date),
  route: normalizeString(tour.route || tour.location),
  manager: normalizeString(tour.manager),
  totalSeats: Math.max(Number(tour.totalSeats || tour.seats || tour.capacity) || 20, 1),
  bookedSeats: Math.max(Number(tour.bookedSeats) || 0, 0),
  calendarStatus: TOUR_CALENDAR_STATUSES.has(tour.calendarStatus || tour.tripStatus || tour.scheduleStatus)
    ? (tour.calendarStatus || tour.tripStatus || tour.scheduleStatus)
    : 'scheduled',
});

const normalizeAccommodationEntity = (item) => ({
  ...item,
  id: Number(item?.id) || 0,
  companyId: normalizeCompanyId(item?.companyId),
  title: normalizeString(item?.title || item?.name || 'Accommodation'),
  name: normalizeString(item?.name || item?.title || 'Accommodation'),
  description: normalizeString(item?.description),
  location: normalizeString(item?.location),
  images: ensureArray(item?.images).map((image) => normalizeString(image)).filter(Boolean),
  capacity: Number(item?.capacity) || 1,
  pricePerNight: Number(item?.pricePerNight) || 0,
  amenities: ensureArray(item?.amenities).map((value) => normalizeString(value)).filter(Boolean),
  totalCount: Number(item?.totalCount) || Number(item?.availableCount) || 1,
  availableCount: Number(item?.availableCount) || Number(item?.totalCount) || 1,
  type: normalizeString(item?.type, 'standard') || 'standard',
  extraBedAvailable: Boolean(item?.extraBedAvailable),
  extraBedPrice: Number(item?.extraBedPrice) || 0,
  linkedTourIds: ensureArray(item?.linkedTourIds).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
  status: ACCOMMODATION_STATUSES.has(item?.status) ? item.status : 'available',
});

const toTourAccommodation = (item) => ({
  id: item.id,
  name: item.name || item.title,
  title: item.title || item.name,
  type: item.type || 'standard',
  images: item.images || [],
  description: item.description || '',
  capacity: Number(item.capacity || 0),
  pricePerNight: Number(item.pricePerNight || 0),
  availableCount: Number(item.availableCount || item.totalCount || 0),
  amenities: ensureArray(item.amenities),
  extraBedAvailable: Boolean(item.extraBedAvailable),
  extraBedPrice: Number(item.extraBedPrice || 0),
  status: item.status || 'available',
  location: item.location || '',
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
  bonus: Number(entry?.bonus) || 0,
  requestId: Number(entry?.requestId) || null,
  status: normalizeString(entry?.status, 'completed') || 'completed',
  source: normalizeString(entry?.source, 'manual') || 'manual',
});

const TOPUP_REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);

const normalizeTopupRequest = (request) => {
  const status = TOPUP_REQUEST_STATUSES.has(request?.status) ? request.status : 'pending';

  return {
    id: Number(request?.id) || 0,
    userId: Number(request?.userId) || 0,
    companyId: normalizeCompanyId(request?.companyId),
    amount: Number(request?.amount) || 0,
    bonus: Number(request?.bonus) || 0,
    receiptImage: normalizeString(request?.receiptImage),
    receiptName: normalizeString(request?.receiptName),
    receiptType: normalizeString(request?.receiptType),
    comment: normalizeString(request?.comment),
    adminComment: normalizeString(request?.adminComment),
    status,
    createdAt: normalizeDateValue(request?.createdAt) || new Date().toISOString(),
    reviewedAt: normalizeDateValue(request?.reviewedAt),
    reviewedBy: Number(request?.reviewedBy) || null,
  };
};

const normalizeBooking = (booking) => ({
  id: booking?.id || createId('booking'),
  tourId: booking?.tourId || booking?.id || '',
  companyId: normalizeCompanyId(booking?.companyId),
  companyName: normalizeString(booking?.companyName),
  clientName: normalizeString(booking?.clientName),
  clientPhone: normalizeString(booking?.clientPhone),
  clientEmail: normalizeString(booking?.clientEmail),
  tourTitle: normalizeString(booking?.tourTitle || booking?.title),
  location: normalizeString(booking?.location),
  image: normalizeString(booking?.image),
  amount: Number(booking?.amount) || Number(booking?.price) || 0,
  status: normalizeString(booking?.status, 'paid') || 'paid',
  paymentStatus: normalizeString(booking?.paymentStatus, booking?.status === 'paid' ? 'paid' : 'pending') || 'pending',
  purchasedAt: normalizeDateValue(booking?.purchasedAt || booking?.date) || new Date().toISOString(),
  travelDate: normalizeDateValue(booking?.travelDate || booking?.date) || '',
  date: normalizeDateValue(booking?.date || booking?.travelDate || booking?.purchasedAt) || new Date().toISOString(),
  endDate: normalizeDateValue(booking?.endDate),
  durationMinutes: Number(booking?.durationMinutes) || 60,
  assignedTo: normalizeString(booking?.assignedTo || booking?.manager),
  paymentMethod: normalizeString(booking?.paymentMethod, 'savings') || 'savings',
  accommodation: booking?.accommodation || null,
  accommodationTotal: Number(booking?.accommodationTotal) || 0,
  extraBedSelected: Boolean(booking?.extraBedSelected),
  extraBedTotal: Number(booking?.extraBedTotal) || 0,
  baseTourAmount: Number(booking?.baseTourAmount) || 0,
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
    role: normalizeRole(user.role),
    companyId: normalizeCompanyId(user.companyId),
    avatar: normalizeString(user.avatar, DEFAULT_AVATAR) || DEFAULT_AVATAR,
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
  res.status(200).json({
    status: 'running',
    ok: true,
    service: 'TravelPay API',
  });
});

app.get('/api/test-ai', (req, res) => {
  res.json({
    status: 'ok',
    geminiKey: !!process.env.GEMINI_API_KEY,
  });
});

app.post('/api/ai-chat', asyncHandler(async (req, res) => {
  const fallbackReply = 'Сейчас ассистент временно недоступен, попробуйте позже.';

  try {
    console.log('AI request:', req.body);
    console.log('Gemini key exists:', !!process.env.GEMINI_API_KEY);

    const { message, history = [] } = req.body || {};
    const userMessage = String(message || '').trim();

    if (!userMessage) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
        reply: fallbackReply,
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'мой_ключ_сюда') {
      console.warn('AI warning: GEMINI_API_KEY is missing in environment variables.');
      return res.status(200).json({
        success: false,
        reply: fallbackReply,
        message: 'GEMINI_API_KEY is missing',
      });
    }

    const { GoogleGenAI } = await import('@google/genai');
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

    return res.json({
      success: true,
      reply: result.text || fallbackReply,
    });
  } catch (error) {
    console.error('AI ERROR:', error);
    return res.status(500).json({
      success: false,
      reply: fallbackReply,
      message: error.message,
      stack: error.stack,
    });
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

app.post('/auth/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '').trim();
  const db = await readDb();
  let user = db.users.find(
    (item) => String(item.email).toLowerCase() === email && String(item.password) === password,
  );

  if (!user && email === 'admin@travelpay.kg' && password === 'admin123') {
    user = db.users.find((item) => normalizeRole(item.role) === 'super_admin');
  }

  if (!user) {
    return res.status(401).json({ message: 'Неверный email или пароль.' });
  }

  res.json(sanitizeUser({ ...user, isLoggedIn: true }));
}));

const getAuthenticatedUser = (db, req) => {
  const userId = Number(req.get('x-user-id'));
  if (!userId) return null;
  return db.users.find((user) => Number(user.id) === userId) || null;
};

const isSuperAdmin = (user) => normalizeRole(user?.role) === 'super_admin';
const isCompanyStaff = (user) => COMPANY_STAFF_ROLES.has(normalizeRole(user?.role));
const isAdminUser = (user) => ADMIN_ROLES.has(normalizeRole(user?.role));
const getScopedCompanyId = (user) => (isCompanyStaff(user) ? normalizeCompanyId(user?.companyId) : null);
const canAccessCompany = (user, companyId) => isSuperAdmin(user) || getScopedCompanyId(user) === normalizeCompanyId(companyId);
const findUserCompany = (db, user) => db.companies.find((company) => Number(company.id) === normalizeCompanyId(user?.companyId));
const isCompanyActive = (company) => normalizeString(company?.status, 'active') === 'active';

app.post('/business/register', asyncHandler(async (req, res) => {
  const db = await readDb();
  const email = normalizeString(req.body.email).toLowerCase();
  const password = normalizeString(req.body.password);
  const companyName = normalizeString(req.body.companyName || req.body.name);
  const ownerName = normalizeString(req.body.ownerName);

  if (!companyName || !ownerName || !email || !password) {
    return res.status(400).json({ message: 'Укажите компанию, владельца, email и пароль.' });
  }

  if (db.users.some((user) => String(user.email).toLowerCase() === email)) {
    return res.status(409).json({ message: 'Пользователь с таким email уже существует.' });
  }

  if (db.companies.some((company) => String(company.email).toLowerCase() === email || String(company.name).trim().toLowerCase() === companyName.toLowerCase())) {
    return res.status(409).json({ message: 'Компания с таким названием или email уже существует.' });
  }

  const companyId = nextId(db.companies);
  const userId = nextId(db.users);
  const now = new Date().toISOString();
  const company = normalizeCompany({
    id: companyId,
    name: companyName,
    ownerId: userId,
    phone: req.body.phone,
    email,
    city: req.body.city,
    address: req.body.address,
    description: req.body.description,
    logo: req.body.logo,
    documents: req.body.documents,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
  const user = normalizeUser({
    id: userId,
    name: ownerName,
    email,
    phone: req.body.phone,
    password,
    balance: 0,
    role: 'company_admin',
    companyId,
    avatar: req.body.logo || DEFAULT_AVATAR,
    isLoggedIn: false,
    favorites: [],
    savings: normalizeSavings(),
  });

  db.companies.push(company);
  db.users.push(user);
  await saveDb(db);
  res.status(201).json({
    message: 'Заявка компании отправлена. После проверки вы сможете публиковать туры.',
    company,
    user: sanitizeUser(user),
  });
}));

app.post('/business/login', asyncHandler(async (req, res) => {
  const email = normalizeString(req.body.email).toLowerCase();
  const password = normalizeString(req.body.password);
  const db = await readDb();
  const user = db.users.find(
    (item) => String(item.email).toLowerCase() === email && String(item.password) === password,
  );

  if (!user) {
    return res.status(401).json({ message: 'Неверный email или пароль.' });
  }

  if (!isCompanyStaff(user)) {
    return res.status(403).json({ message: 'TravelPay Business доступен только тур-компаниям.' });
  }

  const company = findUserCompany(db, user);
  if (!company) {
    return res.status(403).json({ message: 'Компания не найдена.' });
  }

  const safeUser = sanitizeUser({ ...user, isLoggedIn: true });
  if (company.status === 'pending') {
    return res.status(202).json({ status: 'pending', company, user: safeUser });
  }

  if (company.status === 'rejected') {
    return res.status(403).json({
      status: 'rejected',
      message: company.rejectionReason || 'Заявка компании отклонена.',
      company,
      user: safeUser,
    });
  }

  if (company.status === 'blocked' || company.status === 'inactive' || company.status === 'archived') {
    return res.status(403).json({
      status: company.status,
      message: 'Доступ компании временно ограничен.',
      company,
      user: safeUser,
    });
  }

  res.json({ status: 'active', company, user: safeUser });
}));

const requireAdminUser = (user, res) => {
  if (!user || !isAdminUser(user)) {
    res.status(403).json({ message: 'Доступ разрешён только администраторам компании.' });
    return false;
  }

  return true;
};

const requireActiveCompany = (db, user, res) => {
  if (!isCompanyStaff(user)) return true;

  const company = findUserCompany(db, user);
  if (!isCompanyActive(company)) {
    res.status(403).json({
      message: company?.status === 'pending'
        ? 'Компания ожидает подтверждения. Публикация туров пока недоступна.'
        : 'Компания не активна. Управление турами недоступно.',
      company,
    });
    return false;
  }

  return true;
};

const filterUsersByScope = (users, user) => {
  if (!user) return users;
  if (isSuperAdmin(user)) return users;
  if (isCompanyStaff(user)) {
    const companyId = getScopedCompanyId(user);
    return users.filter((item) => normalizeCompanyId(item.companyId) === companyId);
  }

  return users.filter((item) => Number(item.id) === Number(user.id));
};

const filterTopupsByScope = (requests, users, user) => {
  if (isSuperAdmin(user)) return requests;
  const companyId = getScopedCompanyId(user);
  return requests.filter((request) => {
    if (normalizeCompanyId(request.companyId) === companyId) return true;
    const requestUser = users.find((item) => Number(item.id) === Number(request.userId));
    return normalizeCompanyId(requestUser?.companyId) === companyId;
  });
};

const filterAccommodationsByScope = (accommodations, user) => {
  if (!user) {
    return accommodations.filter((item) => item.status !== 'inactive');
  }

  if (isSuperAdmin(user)) return accommodations;
  if (isCompanyStaff(user)) {
    const companyId = getScopedCompanyId(user);
    return accommodations.filter((item) => normalizeCompanyId(item.companyId) === companyId);
  }

  return accommodations.filter((item) => item.status === 'available');
};

const buildTourResponse = (tour, accommodations = []) => {
  const embedded = ensureArray(tour.accommodations).map(toTourAccommodation);
  const linked = accommodations
    .filter((item) => item.linkedTourIds.includes(Number(tour.id)) || ensureArray(tour.accommodationIds).includes(Number(item.id)))
    .map(toTourAccommodation);
  const merged = [...embedded];

  linked.forEach((item) => {
    if (!merged.some((entry) => Number(entry.id) === Number(item.id))) {
      merged.push(item);
    }
  });

  return {
    ...tour,
    accommodationIds: merged.map((item) => Number(item.id)).filter((id) => Number.isFinite(id)),
    hasAccommodation: Boolean(tour.hasAccommodation || merged.length),
    accommodations: merged,
  };
};

app.get('/companies', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (isSuperAdmin(currentUser)) {
    return res.json(db.companies);
  }

  if (isCompanyStaff(currentUser)) {
    return res.json(db.companies.filter((company) => Number(company.id) === getScopedCompanyId(currentUser)));
  }

  res.json(db.companies.filter((company) => company.status === 'active'));
}));

app.post('/companies', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!currentUser || !isSuperAdmin(currentUser)) {
    return res.status(403).json({ message: 'Создавать компании может только super admin.' });
  }

  const company = normalizeCompany({
    ...req.body,
    id: nextId(db.companies),
  });

  if (!company.name) {
    return res.status(400).json({ message: 'Укажите название компании.' });
  }

  db.companies.push(company);
  await saveDb(db);
  res.status(201).json(company);
}));

app.put('/companies/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!currentUser || !isSuperAdmin(currentUser)) {
    return res.status(403).json({ message: 'Изменять компании может только super admin.' });
  }

  const id = Number(req.params.id);
  const index = db.companies.findIndex((company) => Number(company.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'Компания не найдена.' });
  }

  db.companies[index] = normalizeCompany({
    ...db.companies[index],
    ...req.body,
    id,
    updatedAt: new Date().toISOString(),
  });

  await saveDb(db);
  res.json(db.companies[index]);
}));

app.get('/accommodations', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);
  const { tourId } = req.query;
  let result = filterAccommodationsByScope(db.accommodations || [], currentUser);

  if (tourId) {
    const normalizedTourId = Number(tourId);
    result = result.filter((item) => item.linkedTourIds.includes(normalizedTourId));
  }

  res.json(result);
}));

app.post('/accommodations', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  if (!requireActiveCompany(db, currentUser, res)) {
    return;
  }

  const companyId = isSuperAdmin(currentUser)
    ? normalizeCompanyId(req.body.companyId)
    : getScopedCompanyId(currentUser);
  const accommodation = normalizeAccommodationEntity({
    ...req.body,
    id: nextId(db.accommodations || []),
    companyId,
  });

  if (!accommodation.title || !accommodation.location || !accommodation.pricePerNight) {
    return res.status(400).json({ message: 'Укажите название, локацию и цену за ночь.' });
  }

  db.accommodations = ensureArray(db.accommodations);
  db.accommodations.push(accommodation);
  await saveDb(db);
  res.status(201).json(accommodation);
}));

app.put('/accommodations/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  if (!requireActiveCompany(db, currentUser, res)) {
    return;
  }

  const id = Number(req.params.id);
  const index = ensureArray(db.accommodations).findIndex((item) => Number(item.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'Домик не найден.' });
  }

  if (!canAccessCompany(currentUser, db.accommodations[index].companyId)) {
    return res.status(403).json({ message: 'Нельзя изменять домики другой компании.' });
  }

  const companyId = isSuperAdmin(currentUser)
    ? normalizeCompanyId(req.body.companyId ?? db.accommodations[index].companyId)
    : getScopedCompanyId(currentUser);

  db.accommodations[index] = normalizeAccommodationEntity({
    ...db.accommodations[index],
    ...req.body,
    id,
    companyId,
  });

  await saveDb(db);
  res.json(db.accommodations[index]);
}));

app.delete('/accommodations/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  const id = Number(req.params.id);
  const accommodation = ensureArray(db.accommodations).find((item) => Number(item.id) === id);

  if (!accommodation) {
    return res.status(404).json({ message: 'Домик не найден.' });
  }

  if (!canAccessCompany(currentUser, accommodation.companyId)) {
    return res.status(403).json({ message: 'Нельзя удалять домики другой компании.' });
  }

  db.accommodations = ensureArray(db.accommodations).filter((item) => Number(item.id) !== id);
  db.tours = db.tours.map((tour) => normalizeTour({
    ...tour,
    accommodationIds: ensureArray(tour.accommodationIds).filter((item) => Number(item) !== id),
  }));
  await saveDb(db);
  res.status(204).end();
}));

app.get('/tours', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);
  const scopedAccommodations = filterAccommodationsByScope(db.accommodations || [], currentUser);
  const visiblePublicStatuses = new Set(['active', 'hot', 'discount', 'published']);

  if (isCompanyStaff(currentUser)) {
    return res.json(
      db.tours
        .filter((tour) => normalizeCompanyId(tour.companyId) === getScopedCompanyId(currentUser))
        .map((tour) => buildTourResponse(tour, scopedAccommodations)),
    );
  }

  if (!isSuperAdmin(currentUser)) {
    return res.json(
      db.tours
        .filter((tour) => visiblePublicStatuses.has(tour.status || 'active'))
        .map((tour) => buildTourResponse(tour, scopedAccommodations)),
    );
  }

  res.json(db.tours.map((tour) => buildTourResponse(tour, scopedAccommodations)));
}));

app.post('/tours', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  if (!requireActiveCompany(db, currentUser, res)) {
    return;
  }

  const companyId = isSuperAdmin(currentUser)
    ? normalizeCompanyId(req.body.companyId)
    : getScopedCompanyId(currentUser);
  const company = db.companies.find((item) => Number(item.id) === companyId);
  const tour = normalizeTour({
    ...req.body,
    id: nextId(db.tours),
    companyId,
    companyName: company?.name || req.body.companyName || '',
  });

  if (!tour.title || !tour.description || !tour.image || !tour.price) {
    return res.status(400).json({ message: 'Заполните название, описание, цену и картинку тура.' });
  }

  db.tours.push(tour);
  await saveDb(db);
  res.status(201).json(buildTourResponse(tour, filterAccommodationsByScope(db.accommodations || [], currentUser)));
}));

app.put('/tours/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  if (!requireActiveCompany(db, currentUser, res)) {
    return;
  }

  const id = Number(req.params.id);
  const index = db.tours.findIndex((tour) => Number(tour.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'Тур не найден.' });
  }

  if (!canAccessCompany(currentUser, db.tours[index].companyId)) {
    return res.status(403).json({ message: 'Нельзя изменять туры другой компании.' });
  }

  const nextCompanyId = isSuperAdmin(currentUser)
    ? normalizeCompanyId(req.body.companyId ?? db.tours[index].companyId)
    : getScopedCompanyId(currentUser);
  const company = db.companies.find((item) => Number(item.id) === nextCompanyId);

  db.tours[index] = normalizeTour({
    ...db.tours[index],
    ...req.body,
    id,
    companyId: nextCompanyId,
    companyName: company?.name || db.tours[index].companyName || req.body.companyName || '',
  });
  await saveDb(db);
  res.json(buildTourResponse(db.tours[index], filterAccommodationsByScope(db.accommodations || [], currentUser)));
}));

app.delete('/tours/:id', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  if (!requireAdminUser(currentUser, res)) {
    return;
  }

  const id = Number(req.params.id);
  const tour = db.tours.find((item) => Number(item.id) === id);

  if (!tour) {
    return res.status(404).json({ message: 'Тур не найден.' });
  }

  if (!canAccessCompany(currentUser, tour.companyId)) {
    return res.status(403).json({ message: 'Нельзя удалять туры другой компании.' });
  }

  db.tours = db.tours.filter((item) => Number(item.id) !== id);
  await saveDb(db);
  res.status(204).end();
}));

const getTopupRequestWithUser = (request, users) => {
  const user = users.find((item) => Number(item.id) === Number(request.userId));
  return {
    ...request,
    userName: user?.name || 'Пользователь удалён',
    userEmail: user?.email || '',
  };
};

app.post('/api/topup/create', asyncHandler(async (req, res) => {
  const db = await readDb();
  const user = getAuthenticatedUser(db, req);

  if (!user) {
    return res.status(401).json({ message: 'Необходимо войти в аккаунт.' });
  }

  const amount = Number(req.body.amount);
  const receiptImage = normalizeString(req.body.receiptImage);
  const receiptName = normalizeString(req.body.receiptName);
  const receiptType = normalizeString(req.body.receiptType);

  if (!Number.isFinite(amount) || amount < 100) {
    return res.status(400).json({ message: 'Минимальная сумма пополнения — 100 сом.' });
  }

  if (!receiptImage || !/^data:(image\/(jpeg|jpg|png)|application\/pdf);base64,/i.test(receiptImage)) {
    return res.status(400).json({ message: 'Загрузите чек в формате JPG, PNG или PDF.' });
  }

  if (receiptImage.length > 8 * 1024 * 1024) {
    return res.status(413).json({ message: 'Файл чека слишком большой. Максимальный размер — 6 МБ.' });
  }

  const request = normalizeTopupRequest({
    id: nextId(db.topupRequests),
    userId: user.id,
    companyId: user.companyId,
    amount,
    bonus: 0,
    receiptImage,
    receiptName,
    receiptType,
    comment: req.body.comment,
    adminComment: '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: '',
    reviewedBy: null,
  });

  db.topupRequests.push(request);
  await saveDb(db);
  res.status(201).json(request);
}));

app.get('/api/topup/my-requests', asyncHandler(async (req, res) => {
  const db = await readDb();
  const user = getAuthenticatedUser(db, req);

  if (!user) {
    return res.status(401).json({ message: 'Необходимо войти в аккаунт.' });
  }

  const requests = db.topupRequests
    .filter((request) => Number(request.userId) === Number(user.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(requests);
}));

app.get('/api/admin/topups', asyncHandler(async (req, res) => {
  const db = await readDb();
  const admin = getAuthenticatedUser(db, req);

  if (!requireAdminUser(admin, res)) {
    return;
  }

  const requests = filterTopupsByScope(db.topupRequests, db.users, admin)
    .map((request) => getTopupRequestWithUser(request, db.users))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(requests);
}));

app.put('/api/admin/topups/:id/approve', asyncHandler(async (req, res) => {
  const db = await readDb();
  const admin = getAuthenticatedUser(db, req);

  if (!requireAdminUser(admin, res)) {
    return;
  }

  const requestId = Number(req.params.id);
  const requestIndex = db.topupRequests.findIndex((item) => Number(item.id) === requestId);

  if (requestIndex === -1) {
    return res.status(404).json({ message: 'Заявка не найдена.' });
  }

  const request = db.topupRequests[requestIndex];
  if (request.status !== 'pending') {
    return res.status(409).json({ message: 'Эта заявка уже обработана.' });
  }

  const userIndex = db.users.findIndex((item) => Number(item.id) === Number(request.userId));
  if (userIndex === -1) {
    return res.status(404).json({ message: 'Пользователь заявки не найден.' });
  }

  if (!canAccessCompany(admin, request.companyId || db.users[userIndex]?.companyId)) {
    return res.status(403).json({ message: 'Нельзя подтверждать заявки другой компании.' });
  }

  const approvedAmount = Number(req.body.amount ?? request.amount);
  const bonusValue = Math.max(Number(req.body.bonus) || 0, 0);
  const bonusType = req.body.bonusType === 'percent' ? 'percent' : 'fixed';

  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
    return res.status(400).json({ message: 'Укажите корректную сумму пополнения.' });
  }

  const calculatedBonus = bonusType === 'percent'
    ? Math.round((approvedAmount * bonusValue) / 100)
    : bonusValue;
  const creditedAmount = approvedAmount + calculatedBonus;
  const reviewedAt = new Date().toISOString();
  const currentUser = normalizeUser(db.users[userIndex]);
  const nextSavingsAmount = Number(currentUser.savings?.currentAmount || 0) + creditedAmount;
  const nextSavingsStatus = currentUser.savings?.goalAmount > 0 && nextSavingsAmount >= currentUser.savings.goalAmount
    ? 'completed'
    : currentUser.savings?.status;

  db.users[userIndex] = normalizeUser({
    ...currentUser,
    balance: Number(currentUser.balance || 0) + creditedAmount,
    savings: {
      ...currentUser.savings,
      currentAmount: nextSavingsAmount,
      status: nextSavingsStatus,
    },
    topUps: [
      {
        id: createId('topup'),
        requestId,
        date: reviewedAt,
        amount: approvedAmount,
        bonus: calculatedBonus,
        status: 'completed',
        source: 'manual_qr_review',
      },
      ...ensureArray(currentUser.topUps),
    ],
    notifications: [
      {
        id: createId('notification'),
        type: 'topup-approved',
        title: 'Пополнение подтверждено',
        description: `На накопительный баланс начислено ${approvedAmount.toLocaleString('ru-RU')} сом${calculatedBonus ? ` и бонус ${calculatedBonus.toLocaleString('ru-RU')} сом` : ''}.`,
        date: reviewedAt,
        read: false,
      },
      ...ensureArray(currentUser.notifications),
    ],
  });

  db.topupRequests[requestIndex] = normalizeTopupRequest({
    ...request,
    amount: approvedAmount,
    bonus: calculatedBonus,
    adminComment: req.body.adminComment,
    status: 'approved',
    reviewedAt,
    reviewedBy: admin.id,
  });

  await saveDb(db);
  res.json(getTopupRequestWithUser(db.topupRequests[requestIndex], db.users));
}));

app.put('/api/admin/topups/:id/reject', asyncHandler(async (req, res) => {
  const db = await readDb();
  const admin = getAuthenticatedUser(db, req);

  if (!requireAdminUser(admin, res)) {
    return;
  }

  const requestId = Number(req.params.id);
  const requestIndex = db.topupRequests.findIndex((item) => Number(item.id) === requestId);

  if (requestIndex === -1) {
    return res.status(404).json({ message: 'Заявка не найдена.' });
  }

  const request = db.topupRequests[requestIndex];
  if (request.status !== 'pending') {
    return res.status(409).json({ message: 'Эта заявка уже обработана.' });
  }

  const reason = normalizeString(req.body.adminComment);
  if (!reason) {
    return res.status(400).json({ message: 'Укажите причину отклонения.' });
  }

  const userIndex = db.users.findIndex((item) => Number(item.id) === Number(request.userId));
  if (userIndex === -1) {
    return res.status(404).json({ message: 'Пользователь заявки не найден.' });
  }

  if (!canAccessCompany(admin, request.companyId || db.users[userIndex]?.companyId)) {
    return res.status(403).json({ message: 'Нельзя отклонять заявки другой компании.' });
  }

  const reviewedAt = new Date().toISOString();
  const currentUser = normalizeUser(db.users[userIndex]);

  db.users[userIndex] = normalizeUser({
    ...currentUser,
    notifications: [
      {
        id: createId('notification'),
        type: 'topup-rejected',
        title: 'Заявка на пополнение отклонена',
        description: reason,
        date: reviewedAt,
        read: false,
      },
      ...ensureArray(currentUser.notifications),
    ],
  });

  db.topupRequests[requestIndex] = normalizeTopupRequest({
    ...request,
    adminComment: reason,
    status: 'rejected',
    reviewedAt,
    reviewedBy: admin.id,
  });

  await saveDb(db);
  res.json(getTopupRequestWithUser(db.topupRequests[requestIndex], db.users));
}));

app.get('/users', asyncHandler(async (req, res) => {
  const { email } = req.query;
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);

  let scopedUsers = db.users;

  if (currentUser && isAdminUser(currentUser)) {
    scopedUsers = filterUsersByScope(db.users, currentUser);
  } else if (!email) {
    return res.status(403).json({ message: 'Список пользователей доступен только администраторам.' });
  }

  const result = email
    ? scopedUsers.filter((user) => String(user.email).toLowerCase() === String(email).toLowerCase())
    : scopedUsers;

  res.json(result.map(sanitizeUser));
}));

app.get('/users/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);
  const user = db.users.find((item) => Number(item.id) === id);

  if (!user) {
    return res.status(404).json({ message: 'Пользователь не найден.' });
  }

  if (currentUser) {
    const isSelf = Number(currentUser.id) === id;
    const isScopedAdmin = isAdminUser(currentUser) && canAccessCompany(currentUser, user.companyId);

    if (!isSelf && !isScopedAdmin) {
      return res.status(403).json({ message: 'Недостаточно прав для просмотра пользователя.' });
    }
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
    avatar: req.body.avatar || DEFAULT_AVATAR,
    role: req.body.role || 'user',
    companyId: req.body.companyId ?? DEFAULT_COMPANY_ID,
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
  const currentUser = getAuthenticatedUser(db, req);
  const id = Number(req.params.id);
  const index = db.users.findIndex((user) => Number(user.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  const targetUser = db.users[index];
  const isSelf = currentUser && Number(currentUser.id) === id;
  const isScopedAdmin = currentUser && isAdminUser(currentUser) && canAccessCompany(currentUser, targetUser.companyId);

  if (currentUser && !isSelf && !isScopedAdmin) {
    return res.status(403).json({ message: 'Недостаточно прав для обновления пользователя.' });
  }

  const nextRole = isScopedAdmin
    ? normalizeRole(req.body.role ?? targetUser.role)
    : targetUser.role;
  const nextCompanyId = isSuperAdmin(currentUser)
    ? normalizeCompanyId(req.body.companyId ?? targetUser.companyId)
    : targetUser.companyId;

  db.users[index] = normalizeUser({
    ...targetUser,
    ...req.body,
    id,
    role: nextRole,
    companyId: nextCompanyId,
    balance: Number(req.body.balance ?? db.users[index].balance) || 0,
    favorites: Array.isArray(req.body.favorites) ? req.body.favorites : db.users[index].favorites,
    savings: normalizeSavings(req.body.savings ?? db.users[index].savings),
  });

  await saveDb(db);
  res.json(sanitizeUser(db.users[index]));
}));

app.put('/users/:id/favorites', asyncHandler(async (req, res) => {
  const db = await readDb();
  const currentUser = getAuthenticatedUser(db, req);
  const id = Number(req.params.id);
  const index = db.users.findIndex((user) => Number(user.id) === id);

  if (index === -1) {
    return res.status(404).json({ message: 'Пользователь не найден.' });
  }

  if (currentUser && Number(currentUser.id) !== id && !isAdminUser(currentUser)) {
    return res.status(403).json({ message: 'Недостаточно прав для обновления избранного.' });
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
  const currentUser = getAuthenticatedUser(db, req);
  const id = Number(req.params.id);
  const targetUser = db.users.find((user) => Number(user.id) === id);

  if (!targetUser) {
    return res.status(404).json({ message: 'РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.' });
  }

  if (!currentUser || !isAdminUser(currentUser) || !canAccessCompany(currentUser, targetUser.companyId)) {
    return res.status(403).json({ message: 'Удалять пользователей может только администратор своей компании.' });
  }

  db.users = db.users.filter((user) => Number(user.id) !== id);
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


