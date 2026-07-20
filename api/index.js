const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const { initDatabase, dbQuery, dbInsert, dbUpdate, isSupabase } = require('../database');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'enrich-u-jwt-secret-2026';
const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY || '';
const MONNIFY_SECRET = process.env.MONNIFY_SECRET || '';
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE || '';
const MONNIFY_BASE_URL = process.env.MONNIFY_BASE_URL || 'https://api.monnify.com';
const SITE_URL = process.env.SITE_URL || 'https://myplatform-seven.vercel.app';
const VAT_RATE = parseFloat(process.env.VAT_RATE || '0.10');

const monnifyConfigured = MONNIFY_API_KEY && MONNIFY_SECRET;

const VIP_PLANS = {
  1: { amount: 3000, dailyReturn: 250, withdrawalDay: 'Tuesday' },
  2: { amount: 9000, dailyReturn: 800, withdrawalDay: 'Tuesday' },
  3: { amount: 27000, dailyReturn: 2700, withdrawalDay: 'Tuesday' },
  4: { amount: 54000, dailyReturn: 6000, withdrawalDay: 'Wednesday' },
  5: { amount: 81000, dailyReturn: 10200, withdrawalDay: 'Wednesday' },
  6: { amount: 120000, dailyReturn: 15000, withdrawalDay: 'Thursday' },
  7: { amount: 200000, dailyReturn: 18000, withdrawalDay: 'Thursday' },
  8: { amount: 230000, dailyReturn: 21000, withdrawalDay: 'Friday' },
  9: { amount: 280000, dailyReturn: 28000, withdrawalDay: 'Friday' }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Serve PWA files explicitly for Vercel
app.get('/manifest.json', (req, res) => res.sendFile(path.join(publicDir, 'manifest.json')));
app.get('/service-worker.js', (req, res) => res.sendFile(path.join(publicDir, 'service-worker.js')));
app.get('/icons/:file', (req, res) => res.sendFile(path.join(publicDir, 'icons', req.params.file)));

// DATABASE MIGRATION: Run once to add missing columns
app.get('/api/migrate-db', async (req, res) => {
  const { supabase: getSupabase } = require('../database');
  const sb = getSupabase();
  if (!sb) return res.json({ error: 'No Supabase client' });

  const results = [];

  async function tryExec(sql, label) {
    try {
      const r = await sb.rpc('exec_sql', { query: sql });
      results.push({ step: label, result: r.data || r.error || 'ok' });
    } catch(e) {
      results.push({ step: label, result: 'error: ' + e.message });
    }
  }

  const migrations = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS total_earned NUMERIC DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''",
    "ALTER TABLE investments ADD COLUMN IF NOT EXISTS reference TEXT DEFAULT ''",
    "ALTER TABLE investments ADD COLUMN IF NOT EXISTS total_collected NUMERIC DEFAULT 0",
    "ALTER TABLE investments ADD COLUMN IF NOT EXISTS days_collected INTEGER DEFAULT 0",
    "ALTER TABLE investments ADD COLUMN IF NOT EXISTS daily_return NUMERIC DEFAULT 0",
    "ALTER TABLE investments ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS vat_amount NUMERIC DEFAULT 0",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS credit_amount NUMERIC DEFAULT 0",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT ''",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS account_number TEXT DEFAULT ''",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS account_name TEXT DEFAULT ''",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT ''",
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference TEXT DEFAULT ''",
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''",
    "CREATE TABLE IF NOT EXISTS reset_requests (id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT DEFAULT '', email TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_date TIMESTAMPTZ DEFAULT NOW()",
  ];

  for (const sql of migrations) {
    const label = sql.replace(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+).*/, '$1.$2').replace(/CREATE TABLE IF NOT EXISTS (\w+).*/, 'create $1');
    await tryExec(sql, label);
  }

  // Reload schema cache
  await tryExec("NOTIFY pgrst, 'reload schema'", 'reload schema');

  res.json({ success: true, results });
});

// DEBUG: Check Supabase connection and table status
app.get('/api/debug-db', async (req, res) => {
  const { supabase: getSupabase, isSupabase } = require('../database');
  const sb = getSupabase();
  if (!sb) return res.json({ connected: false, error: 'No Supabase client' });

  const results = {};
  const tables = ['users', 'investments', 'transactions', 'withdrawals', 'task_claims', 'notifications', 'messages', 'reset_requests'];
  for (const t of tables) {
    try {
      const r = await sb.from(t).select('*').limit(1);
      results[t] = { exists: !r.error, error: r.error ? r.error.message : null, count: r.data ? r.data.length : 0 };
    } catch (e) {
      results[t] = { exists: false, error: e.message };
    }
  }

  res.json({ connected: true, isSupabase: isSupabase(), results });
});

function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please login to continue' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    req.username = decoded.username;
    req.isAdmin = decoded.is_admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ===================== AUTH ROUTES =====================
app.post('/api/register', async (req, res) => {
  const { username, password, email, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (!email) return res.status(400).json({ error: 'Gmail address is required for password recovery' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const existing = await dbQuery('users', 'id', { username });
    if (existing.data && existing.data.length > 0) {
      return res.status(400).json({ error: 'Account already exists! Please login instead.' });
    }

    if (email) {
      const existingEmail = await dbQuery('users', 'id', { email });
      if (existingEmail.data && existingEmail.data.length > 0) {
        return res.status(400).json({ error: 'This email is already registered. Please login instead.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const refCode = 'ENRICH-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const referredBy = req.body.referralCode || null;
    const insertData = { username, password: hashedPassword, email: email || '', phone: phone || '', referral_code: refCode, referred_by: referredBy };
    try { insertData.plain_password = password; } catch(e) {}
    let result = await dbInsert('users', insertData);
    if (result.error && result.error.message && result.error.message.includes('plain_password')) {
      delete insertData.plain_password;
      result = await dbInsert('users', insertData);
    }

    if (result.error) return res.status(500).json({ error: 'Registration failed: ' + result.error.message });

    const user = result.data[0];
    const token = generateToken(user);

    await dbInsert('notifications', { user_id: user.id, title: 'Welcome to Enrich U!', message: 'Your account has been created successfully. Start investing to earn daily returns!' });

    res.json({ success: true, message: 'Account created successfully!', token, user: { id: user.id, username: user.username, balance: 0, totalEarned: 0 } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  try {
    let result = await dbQuery('users', '*', { username }, { single: true });
    if (!result.data && username.includes('@')) {
      result = await dbQuery('users', '*', { email: username }, { single: true });
    }
    if (!result.data) return res.status(400).json({ error: 'Invalid username/email or password' });

    const user = result.data;
    let valid = false;
    if (user.password) {
      valid = await bcrypt.compare(password, user.password);
    } else if (user.plain_password) {
      valid = (password === user.plain_password);
    }
    if (!valid) return res.status(400).json({ error: 'Invalid username or password' });

    const token = generateToken(user);
    res.json({ success: true, message: 'Login successful!', token, user: { id: user.id, username: user.username, balance: user.balance || 0, totalEarned: user.total_earned || 0, isAdmin: user.is_admin || false, nickname: user.nickname || '', avatarUrl: user.avatar_url || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('users', '*', { id: req.userId }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'User not found' });
    const u = result.data;
    res.json({ user: { id: u.id, username: u.username, balance: u.balance || 0, totalEarned: u.total_earned || 0, email: u.email || '', isAdmin: u.is_admin || false, nickname: u.nickname || '', avatarUrl: u.avatar_url || '', vipLevel: u.vip_level || 0, createdAt: u.created_at || '', bonusBalance: parseFloat(u.bonus_balance) || 0, bonusDate: u.bonus_date || '' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== VIP PLANS =====================
app.get('/api/vip-plans', (req, res) => res.json({ plans: VIP_PLANS }));

// ===================== INVESTMENT / PAYMENT =====================
app.post('/api/create-investment', requireAuth, async (req, res) => {
  const { vipLevel } = req.body;
  const plan = VIP_PLANS[vipLevel];
  if (!plan) return res.status(400).json({ error: 'Invalid VIP level' });

  try {
    const userRes = await dbQuery('users', 'vip_level', { id: req.userId }, { single: true });
    const currentVip = userRes.data ? (userRes.data.vip_level || 0) : 0;
    if (currentVip > 0 && parseInt(vipLevel) <= currentVip) return res.status(400).json({ error: `Cannot invest in VIP ${vipLevel}. You are already VIP ${currentVip}. Choose a higher level.` });

    const ref = `ENRICH-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    let accountDetails = null;

    if (monnifyConfigured) {
      try {
        const tokenRes = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
          headers: { 'Authorization': `Basic ${Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' }
        });
        if (tokenRes.data?.responseBody?.accessToken) {
          const accRes = await axios.post(`${MONNIFY_BASE_URL}/api/v2/BankTransfer/ReserveAccount`, {
            accountReference: ref, accountName: `EnrichU-${req.username}`, currencyCode: 'NGN',
            contractCode: MONNIFY_CONTRACT_CODE || MONNIFY_API_KEY, customerEmail: `${req.username}@enrichu.com`,
            customerName: req.username, bvn: '00000000000', redirectUrl: `${SITE_URL}/dashboard.html`
          }, { headers: { 'Authorization': `Bearer ${tokenRes.data.responseBody.accessToken}`, 'Content-Type': 'application/json' } });
          if (accRes.data?.responseBody) accountDetails = accRes.data.responseBody;
        }
      } catch (e) { console.log('Monnify API error:', e.message); }
    }

    if (!accountDetails) {
      const banks = ['Wema Bank', 'Sterling Bank', 'Kuda Bank', 'VBank'];
      accountDetails = {
        accountNumber: `${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        bankName: banks[Math.floor(Math.random() * banks.length)],
        accountName: `EnrichU-${req.username}`
      };
    }

    await dbInsert('transactions', { user_id: req.userId, type: 'investment', vip_level: parseInt(vipLevel), amount: plan.amount, status: 'pending', reference: ref, bank_name: accountDetails.bankName || accountDetails.bank_name || 'Bank', account_number: accountDetails.accountNumber || accountDetails.account_number || '0000000000', account_name: accountDetails.accountName || accountDetails.account_name || `EnrichU-${req.username}` });

    res.json({ success: true, message: 'Payment details generated.', paymentDetails: { reference: ref, amount: plan.amount, bankName: accountDetails.bankName || accountDetails.bank_name || 'Bank', accountNumber: accountDetails.accountNumber || accountDetails.account_number || '0000000000', accountName: accountDetails.accountName || accountDetails.account_name || `EnrichU-${req.username}`, vipLevel } });
  } catch (err) { res.status(500).json({ error: 'Failed: ' + err.message }); }
});

app.post('/api/verify-payment', requireAuth, async (req, res) => {
  const { reference } = req.body;
  try {
    const result = await dbQuery('transactions', 'id, vip_level, amount, status', { reference, user_id: req.userId }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'Transaction not found' });

    const tx = result.data;
    if (tx.status === 'completed') return res.json({ success: true, message: 'Payment already verified' });

    const plan = VIP_PLANS[tx.vip_level];
    const userLocation = NG_LOCATIONS[req.userId % NG_LOCATIONS.length];

    // Add payment amount to wallet
    const userRes = await dbQuery('users', 'balance, total_earned', { id: req.userId }, { single: true });
    const newBal = userRes.data.balance + tx.amount;
    await dbUpdate('users', { balance: newBal }, { id: req.userId });

    // Check if user has existing active investment (upgrade)
    const existingInv = await dbQuery('investments', 'id, vip_level, amount, status', { user_id: req.userId, status: 'active' });
    let refundAmount = 0;
    if (existingInv.data && existingInv.data.length > 0) {
      for (const inv of existingInv.data) {
        if (inv.vip_level < tx.vip_level) {
          refundAmount += inv.amount;
          await dbUpdate('investments', { status: 'upgraded' }, { id: inv.id });
          await dbInsert('notifications', { user_id: req.userId, title: 'VIP Upgraded', message: `Your VIP ${inv.vip_level} investment has been upgraded to VIP ${tx.vip_level}. ₦${inv.amount.toLocaleString()} has been refunded to your wallet.` });
        }
      }
    }

    // Credit refund to wallet
    if (refundAmount > 0) {
      const userBal2 = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
      await dbUpdate('users', { balance: userBal2.data.balance + refundAmount }, { id: req.userId });
    }

    // Create new investment
    await dbUpdate('transactions', { status: 'completed' }, { id: tx.id });
    await dbInsert('investments', { user_id: req.userId, vip_level: tx.vip_level, amount: tx.amount, daily_return: plan.dailyReturn, status: 'active', location: userLocation });

    // Update user's VIP level + deduct investment amount from wallet
    const userBal3 = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
    await dbUpdate('users', { balance: userBal3.data.balance - tx.amount, vip_level: tx.vip_level }, { id: req.userId });

    const msg = refundAmount > 0
      ? `Payment verified! VIP ${tx.vip_level} activated. ₦${refundAmount.toLocaleString()} refunded from previous investment.`
      : `Payment verified! Your VIP ${tx.vip_level} investment is now active.`;

    await dbInsert('notifications', { user_id: req.userId, title: 'Investment Activated!', message: msg });

    // Referral bonus: 10% of investment amount
    try {
      const investor = await dbQuery('users', 'referred_by', { id: req.userId }, { single: true });
      if (investor.data && investor.data.referred_by) {
        const referrer = await dbQuery('users', 'id, username, balance, total_earned', { referral_code: investor.data.referred_by }, { single: true });
        if (referrer.data) {
          const bonus = Math.round(tx.amount * 0.10);
          const refNewEarned = referrer.data.total_earned + bonus;
          const existingBonus = referrer.data.bonus_balance || 0;
          await dbUpdate('users', { bonus_balance: existingBonus + bonus, bonus_date: new Date().toISOString(), total_earned: refNewEarned }, { id: referrer.data.id });
          await dbInsert('transactions', { user_id: referrer.data.id, type: 'referral_bonus', vip_level: 0, amount: bonus, status: 'completed', reference: `REF-${reference}`, bank_name: '', account_number: '', account_name: '' });
          await dbInsert('notifications', { user_id: referrer.data.id, title: 'Referral Bonus!', message: `You earned ₦${bonus.toLocaleString()} referral bonus! It will be available for withdrawal in 2 weeks. ${req.username} just invested ₦${tx.amount.toLocaleString()} (VIP ${tx.vip_level}).` });
        }
      }
    } catch (e) { console.log('Referral bonus error:', e.message); }

    const finalBal = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
    res.json({ success: true, message: msg, newBalance: finalBal.data.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-investments', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('investments', '*', { user_id: req.userId }, { order: { column: 'created_at', ascending: false } });
    const investments = (result.data || []).map(i => ({ id: i.id, vipLevel: i.vip_level, amount: i.amount, dailyReturn: i.daily_return, status: i.status, totalCollected: i.total_collected, daysCollected: i.days_collected, createdAt: i.created_at }));
    res.json({ investments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== TASKS =====================
app.get('/api/task-status', requireAuth, (req, res) => {
  const now = new Date();
  const ng = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = ng.getDay(), h = ng.getHours(), m = ng.getMinutes(), t = h * 60 + m;
  const isWeekday = day >= 1 && day <= 5, isTaskTime = t >= 600 && t < 1020;
  res.json({ canClaim: isWeekday && isTaskTime, nigeriaTime: ng.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }), message: !isWeekday ? 'Tasks are only available Monday to Friday.' : !isTaskTime ? 'Tasks are available between 10:00 AM and 6:00 PM. No task yet.' : 'Tasks are active! Collect your daily returns.' });
});

app.post('/api/claim-task', requireAuth, async (req, res) => {
  const { investmentId } = req.body;
  const now = new Date();
  const ng = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = ng.getDay(), h = ng.getHours(), m = ng.getMinutes(), t = h * 60 + m;
  if (!(day >= 1 && day <= 5) || !(t >= 600 && t < 1020)) return res.status(400).json({ error: 'Tasks are only available Monday to Friday, 10:00 AM - 6:00 PM.' });

  try {
    const invResult = await dbQuery('investments', 'id, vip_level, daily_return, status, total_collected, days_collected', { id: investmentId, user_id: req.userId }, { single: true });
    if (!invResult.data) return res.status(404).json({ error: 'Investment not found' });

    const inv = invResult.data;
    if (inv.status !== 'active') return res.status(400).json({ error: 'This investment is not active' });

    const today = ng.toISOString().split('T')[0];
    const existingClaim = await dbQuery('task_claims', 'id', { user_id: req.userId, investment_id: investmentId, claim_date: today });
    if (existingClaim.data && existingClaim.data.length > 0) return res.status(400).json({ error: "Already collected today's return. Come back tomorrow!" });

    await dbInsert('task_claims', { user_id: req.userId, investment_id: investmentId, claim_date: today, amount: inv.daily_return });
    await dbUpdate('investments', { total_collected: inv.total_collected + inv.daily_return, days_collected: inv.days_collected + 1 }, { id: investmentId });

    const userRes = await dbQuery('users', 'balance, total_earned', { id: req.userId }, { single: true });
    const newBal = userRes.data.balance + inv.daily_return;
    const newEarned = userRes.data.total_earned + inv.daily_return;
    await dbUpdate('users', { balance: newBal, total_earned: newEarned }, { id: req.userId });

    await dbInsert('notifications', { user_id: req.userId, title: 'Daily Return Collected', message: `₦${inv.daily_return.toLocaleString()} has been added to your wallet from VIP ${inv.vip_level}.` });

    res.json({ success: true, message: `Collected ₦${inv.daily_return.toLocaleString()}!`, amount: inv.daily_return, newBalance: newBal, totalCollected: inv.total_collected + inv.daily_return, daysCollected: inv.days_collected + 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== WITHDRAWALS =====================
app.post('/api/withdraw', requireAuth, async (req, res) => {
  const { amount, bankName, accountNumber, accountName } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!bankName || !accountNumber || !accountName) return res.status(400).json({ error: 'Bank details required' });

  const vatAmount = Math.round(amount * VAT_RATE);
  const creditAmount = amount - vatAmount;

  try {
    const userRes = await dbQuery('users', 'balance, vip_level, created_at, bonus_balance, bonus_date', { id: req.userId }, { single: true });
    if (userRes.data.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const createdAt = new Date(userRes.data.created_at);
    const now = new Date();
    const daysSinceReg = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    if (daysSinceReg < 7) return res.status(400).json({ error: `Withdrawals are available 7 days after registration. Please wait ${7 - daysSinceReg} more day(s).` });

    const bonusBal = parseFloat(userRes.data.bonus_balance) || 0;
    const bonusDate = userRes.data.bonus_date ? new Date(userRes.data.bonus_date) : null;
    const bonusMatured = bonusBal > 0 && bonusDate && ((now - bonusDate) >= 14 * 24 * 60 * 60 * 1000);
    const availableBal = (parseFloat(userRes.data.balance) || 0) + (bonusMatured ? bonusBal : 0);
    if (amount > availableBal) return res.status(400).json({ error: `Insufficient balance. Available: ₦${availableBal.toLocaleString()}${bonusMatured ? '' : ` (₦${bonusBal.toLocaleString()} bonus locked for 2 weeks)`}` });

    const userVip = userRes.data.vip_level || 0;
    if (userVip < 1) return res.status(400).json({ error: 'No VIP level assigned' });

    const plan = VIP_PLANS[userVip];
    if (!plan) return res.status(400).json({ error: 'Invalid VIP level' });

    const ng = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = dayNames[ng.getDay()];
    if (currentDay !== plan.withdrawalDay) return res.status(400).json({ error: `Withdrawals for VIP ${userVip} are only on ${plan.withdrawalDay}s` });

    let deductFromBonus = 0;
    let deductFromBalance = amount;
    if (bonusMatured && bonusBal > 0) {
      if (amount <= bonusBal) {
        deductFromBonus = amount;
        deductFromBalance = 0;
      } else {
        deductFromBonus = bonusBal;
        deductFromBalance = amount - bonusBal;
      }
    }
    const updateData = { balance: userRes.data.balance - deductFromBalance };
    if (deductFromBonus > 0) updateData.bonus_balance = bonusBal - deductFromBonus;
    await dbUpdate('users', updateData, { id: req.userId });
    await dbInsert('withdrawals', { user_id: req.userId, amount, bank_name: bankName, account_number: accountNumber, account_name: accountName, status: 'pending', vat_amount: vatAmount, credit_amount: creditAmount });

    await dbInsert('notifications', { user_id: req.userId, title: 'Withdrawal Submitted', message: `Your withdrawal of ₦${amount.toLocaleString()} has been submitted. VAT (10%): ₦${vatAmount.toLocaleString()}. You will receive: ₦${creditAmount.toLocaleString()}.` });

    const newBal = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
    res.json({ success: true, message: `Withdrawal of ₦${amount.toLocaleString()} submitted. You will receive ₦${creditAmount.toLocaleString()} after 10% VAT.`, newBalance: newBal.data.balance, vatAmount, creditAmount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/claim-bonus', requireAuth, async (req, res) => {
  try {
    const userRes = await dbQuery('users', 'balance, bonus_balance, bonus_date', { id: req.userId }, { single: true });
    if (!userRes.data) return res.status(404).json({ error: 'User not found' });

    const bonusBal = parseFloat(userRes.data.bonus_balance) || 0;
    if (bonusBal <= 0) return res.status(400).json({ error: 'No bonus available' });

    const bonusDate = userRes.data.bonus_date ? new Date(userRes.data.bonus_date) : null;
    const now = new Date();
    if (!bonusDate || (now - bonusDate) < 14 * 24 * 60 * 60 * 1000) {
      const daysLeft = Math.ceil((14 * 24 * 60 * 60 * 1000 - (now - bonusDate)) / (1000 * 60 * 60 * 24));
      return res.status(400).json({ error: `Bonus unlocks in ${daysLeft} day(s)` });
    }

    const newBal = userRes.data.balance + bonusBal;
    await dbUpdate('users', { balance: newBal, bonus_balance: 0, bonus_date: null }, { id: req.userId });
    await dbInsert('notifications', { user_id: req.userId, title: 'Bonus Claimed', message: `₦${bonusBal.toLocaleString()} referral bonus has been added to your wallet.` });
    res.json({ success: true, message: `₦${bonusBal.toLocaleString()} bonus added to your balance`, newBalance: newBal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/withdraw-bonus', requireAuth, async (req, res) => {
  const { bankName, accountNumber, accountName } = req.body;
  if (!bankName || !accountNumber || !accountName) return res.status(400).json({ error: 'Bank details required' });

  try {
    const userRes = await dbQuery('users', 'balance, bonus_balance, bonus_date, vip_level, created_at', { id: req.userId }, { single: true });
    if (!userRes.data) return res.status(404).json({ error: 'User not found' });

    const bonusBal = parseFloat(userRes.data.bonus_balance) || 0;
    if (bonusBal <= 0) return res.status(400).json({ error: 'No bonus available' });

    const bonusDate = userRes.data.bonus_date ? new Date(userRes.data.bonus_date) : null;
    const now = new Date();
    if (!bonusDate || (now - bonusDate) < 14 * 24 * 60 * 60 * 1000) {
      const daysLeft = Math.ceil((14 * 24 * 60 * 60 * 1000 - (now - bonusDate)) / (1000 * 60 * 60 * 24));
      return res.status(400).json({ error: `Bonus unlocks in ${daysLeft} day(s)` });
    }

    const createdAt = new Date(userRes.data.created_at);
    const daysSinceReg = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    if (daysSinceReg < 7) return res.status(400).json({ error: `Wait ${7 - daysSinceReg} more day(s) before withdrawing` });

    const userVip = userRes.data.vip_level || 0;
    if (userVip < 1) return res.status(400).json({ error: 'No VIP level assigned' });

    const plan = VIP_PLANS[userVip];
    if (!plan) return res.status(400).json({ error: 'Invalid VIP level' });

    const ng = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = dayNames[ng.getDay()];
    if (currentDay !== plan.withdrawalDay) return res.status(400).json({ error: `Withdrawals for VIP ${userVip} are only on ${plan.withdrawalDay}s` });

    const amount = bonusBal;
    const vatAmount = Math.round(amount * VAT_RATE);
    const creditAmount = amount - vatAmount;

    await dbUpdate('users', { bonus_balance: 0, bonus_date: null }, { id: req.userId });
    await dbInsert('withdrawals', { user_id: req.userId, amount, bank_name: bankName, account_number: accountNumber, account_name: accountName, status: 'pending', vat_amount: vatAmount, credit_amount: creditAmount });

    await dbInsert('notifications', { user_id: req.userId, title: 'Bonus Withdrawal Submitted', message: `Your bonus withdrawal of ₦${amount.toLocaleString()} has been submitted. You will receive ₦${creditAmount.toLocaleString()} after 10% VAT.` });

    res.json({ success: true, message: `Bonus withdrawal of ₦${amount.toLocaleString()} submitted. You will receive ₦${creditAmount.toLocaleString()} after 10% VAT.`, vatAmount, creditAmount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-withdrawals', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('withdrawals', '*', { user_id: req.userId }, { order: { column: 'created_at', ascending: false } });
    const withdrawals = (result.data || []).map(w => ({ id: w.id, amount: w.amount, bankName: w.bank_name, accountNumber: w.account_number, accountName: w.account_name, status: w.status, adminNote: w.admin_note, vatAmount: w.vat_amount, creditAmount: w.credit_amount, createdAt: w.created_at }));
    res.json({ withdrawals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== NOTIFICATIONS =====================
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('notifications', '*', { user_id: req.userId }, { order: { column: 'created_at', ascending: false }, limit: 20 });
    res.json({ notifications: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    await dbUpdate('notifications', { is_read: true }, { user_id: req.userId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== ADMIN ROUTES =====================
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('users', '*', {}, { order: { column: 'created_at', ascending: false } });
    res.json({ users: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/withdrawals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('withdrawals', '*', {}, { order: { column: 'created_at', ascending: false } });
    res.json({ withdrawals: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await dbQuery('users', 'id', {});
    const investments = await dbQuery('investments', 'id, amount', { status: 'active' });
    const withdrawals = await dbQuery('withdrawals', 'id, amount', { status: 'pending' });
    const totalInvested = await dbQuery('investments', 'amount', {});

    const totalUsers = users.data?.length || 0;
    const activeInvestments = investments.data?.length || 0;
    const pendingWithdrawals = withdrawals.data?.length || 0;
    const totalInvestedAmount = totalInvested.data?.reduce((sum, i) => sum + (i.amount || 0), 0) || 0;
    const pendingWithdrawalAmount = withdrawals.data?.reduce((sum, w) => sum + (w.amount || 0), 0) || 0;

    res.json({ stats: { totalUsers, activeInvestments, pendingWithdrawals, totalInvestedAmount, pendingWithdrawalAmount } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/transactions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('transactions', '*', {}, { order: { column: 'created_at', ascending: false } });
    res.json({ transactions: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/investments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('investments', '*', {}, { order: { column: 'created_at', ascending: false } });
    res.json({ investments: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/withdrawal/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await dbQuery('withdrawals', 'user_id, amount', { id: parseInt(id) }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'Withdrawal not found' });

    await dbUpdate('withdrawals', { status: 'completed', admin_note: req.body.note || 'Approved by admin' }, { id: parseInt(id) });
    await dbInsert('notifications', { user_id: result.data.user_id, title: 'Withdrawal Approved', message: `Your withdrawal of ₦${result.data.amount.toLocaleString()} has been approved and processed.` });

    res.json({ success: true, message: 'Withdrawal approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/withdrawal/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await dbQuery('withdrawals', 'user_id, amount, account_number, account_name, bank_name', { id: parseInt(id) }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'Withdrawal not found' });

    await dbUpdate('withdrawals', { status: 'rejected', admin_note: req.body.note || 'Rejected by admin' }, { id: parseInt(id) });
    await dbUpdate('users', { balance: { op: 'increment', val: result.data.amount } }, { id: result.data.user_id });

    const userRes = await dbQuery('users', 'balance', { id: result.data.user_id }, { single: true });
    const refund = userRes.data.balance + result.data.amount;
    await dbUpdate('users', { balance: refund }, { id: result.data.user_id });

    await dbInsert('notifications', { user_id: result.data.user_id, title: 'Withdrawal Rejected', message: `Your withdrawal of ₦${result.data.amount.toLocaleString()} has been rejected. Amount has been refunded to your wallet. Reason: ${req.body.note || 'No reason provided'}` });

    res.json({ success: true, message: 'Withdrawal rejected and refunded' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/user/:id/toggle-admin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await dbQuery('users', 'is_admin, username', { id: parseInt(id) }, { single: true });
    if (!user.data) return res.status(404).json({ error: 'User not found' });
    if (user.data.username === 'admin') return res.status(400).json({ error: 'Cannot change admin status of the main admin account' });
    await dbUpdate('users', { is_admin: !user.data.is_admin }, { id: parseInt(id) });
    res.json({ success: true, message: 'Admin status toggled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== PASSWORD RESET REQUESTS =====================
app.post('/api/forgot-password-request', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Please enter your username or email' });
  try {
    let result = await dbQuery('users', 'id, username, email', { username: identifier }, { single: true });
    if (!result.data) result = await dbQuery('users', 'id, username, email', { email: identifier }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'No account found with that username or email' });
    const existing = await dbQuery('reset_requests', 'id', { user_id: result.data.id, status: 'pending' }, { single: true });
    if (existing.data) return res.status(400).json({ error: 'You already have a pending reset request. Please wait for admin to process it.' });
    await dbInsert('reset_requests', { user_id: result.data.id, username: result.data.username, email: result.data.email, status: 'pending' });
    res.json({ success: true, message: 'Your password reset request has been sent to admin. Please wait for approval.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/reset-requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const filter = status === 'all' ? {} : { status };
    const result = await dbQuery('reset_requests', 'id, user_id, username, email, status, created_at', filter, { order: { column: 'created_at', ascending: false } });
    res.json({ requests: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/approve-reset/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const request = await dbQuery('reset_requests', 'id, user_id, username', { id: parseInt(req.params.id) }, { single: true });
    if (!request.data) return res.status(404).json({ error: 'Request not found' });
    if (request.data.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
    const defaultPass = '123456';
    const hashed = await bcrypt.hash(defaultPass, 10);
    await dbUpdate('users', { password: hashed }, { id: request.data.user_id });
    await dbUpdate('reset_requests', { status: 'approved' }, { id: parseInt(req.params.id) });
    await dbInsert('notifications', { user_id: request.data.user_id, title: 'Password Reset', message: 'Your password has been reset by admin. Your new default password is 123456. Please login and change it immediately.' });
    res.json({ success: true, message: `Password reset for ${request.data.username}. Default password: ${defaultPass}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject-reset/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const request = await dbQuery('reset_requests', 'id, user_id, username', { id: parseInt(req.params.id) }, { single: true });
    if (!request.data) return res.status(404).json({ error: 'Request not found' });
    await dbUpdate('reset_requests', { status: 'rejected' }, { id: parseInt(req.params.id) });
    await dbInsert('notifications', { user_id: request.data.user_id, title: 'Password Reset Denied', message: 'Your password reset request was denied by admin. Please contact support for help.' });
    res.json({ success: true, message: 'Request rejected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== SETUP ADMIN =====================
app.get('/api/setup-admin', async (req, res) => {
  try {
    const result = await dbQuery('users', 'id, is_admin', { username: 'admin' }, { single: true });
    if (result.data) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await dbUpdate('users', { is_admin: true, password: hashedPassword, plain_password: 'admin123' }, { username: 'admin' });
      res.json({ success: true, message: 'Admin account ready. Username: admin, Password: admin123' });
    } else {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await dbInsert('users', { username: 'admin', password: hashedPassword, plain_password: 'admin123', email: 'enrichu001@gmail.com', is_admin: true, balance: 0, total_earned: 0, vip_level: 0 });
      res.json({ success: true, message: 'Admin account created. Username: admin, Password: admin123' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-columns', async (req, res) => {
  try {
    if (!isSupabase()) return res.json({ success: false, message: 'Not using Supabase' });
    const { supabase } = require('../database');
    const sb = supabase();
    const results = [];
    const columns = [
      { table: 'users', col: 'referral_code', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'referred_by', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'reset_code', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'reset_expires', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'nickname', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'avatar_url', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'full_name', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'phone', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'email', type: "TEXT DEFAULT ''" },
      { table: 'users', col: 'is_admin', type: "BOOLEAN DEFAULT false" },
      { table: 'transactions', col: 'vip_level', type: 'INTEGER DEFAULT 0' },
      { table: 'withdrawals', col: 'vat_amount', type: 'REAL DEFAULT 0' },
      { table: 'withdrawals', col: 'credit_amount', type: 'REAL DEFAULT 0' },
    ];
    for (const c of columns) {
      try {
        const { error } = await sb.rpc('exec_sql', { query: `ALTER TABLE ${c.table} ADD COLUMN IF NOT EXISTS ${c.col} ${c.type}` });
        if (error) results.push(`${c.table}.${c.col}: ${error.message}`);
        else results.push(`${c.table}.${c.col}: OK`);
      } catch (e) { results.push(`${c.table}.${c.col}: ${e.message}`); }
    }
    try { await sb.from('messages').select('id').limit(1); results.push('messages: exists'); } catch (e) {
      try { await sb.rpc('exec_sql', { query: "CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, sender TEXT DEFAULT 'user', message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())" }); results.push('messages: created'); } catch (e2) { results.push('messages: ' + e2.message); }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config-status', (req, res) => {
  res.json({
    monnify: monnifyConfigured ? 'configured' : 'not configured',
    vatRate: (VAT_RATE * 100) + '%',
    siteUrl: SITE_URL,
    monnifyUrl: MONNIFY_BASE_URL
  });
});

app.get('/api/migrate', async (req, res) => {
  try {
    if (!isSupabase()) return res.json({ success: false, message: 'Not using Supabase' });
    const { supabase } = require('../database');
    const sb = supabase();
    const results = [];
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0' }); results.push('transactions.vip_level added'); } catch (e) { results.push('transactions.vip_level: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS vat_amount REAL DEFAULT 0' }); results.push('withdrawals.vat_amount added'); } catch (e) { results.push('withdrawals.vat_amount: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS credit_amount REAL DEFAULT 0' }); results.push('withdrawals.credit_amount added'); } catch (e) { results.push('withdrawals.credit_amount: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT DEFAULT \'\'' }); results.push('users.referral_code added'); } catch (e) { results.push('users.referral_code: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT DEFAULT \'\'' }); results.push('users.referred_by added'); } catch (e) { results.push('users.referred_by: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code TEXT DEFAULT \'\'' }); results.push('users.reset_code added'); } catch (e) { results.push('users.reset_code: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TEXT DEFAULT \'\'' }); results.push('users.reset_expires added'); } catch (e) { results.push('users.reset_expires: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT DEFAULT \'\'' }); results.push('users.nickname added'); } catch (e) { results.push('users.nickname: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT \'\'' }); results.push('users.avatar_url added'); } catch (e) { results.push('users.avatar_url: ' + e.message); }
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE investments ADD COLUMN IF NOT EXISTS location TEXT DEFAULT \'\'' }); results.push('investments.location added'); } catch (e) { results.push('investments.location: ' + e.message); }
    try { await sb.from('messages').select('id').limit(1); } catch (e) { try { await sb.rpc('exec_sql', { query: 'CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, sender TEXT DEFAULT \'user\', message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())' }); results.push('messages table created'); } catch (e2) { results.push('messages table: ' + e2.message); } }
    try { await sb.from('transactions').delete().neq('id', 0); results.push('transactions cleared'); } catch (e) { results.push('clear transactions: ' + e.message); }
    try { await sb.from('withdrawals').delete().neq('id', 0); results.push('withdrawals cleared'); } catch (e) { results.push('clear withdrawals: ' + e.message); }
    try { await sb.from('task_claims').delete().neq('id', 0); results.push('task_claims cleared'); } catch (e) { results.push('clear task_claims: ' + e.message); }
    try { await sb.from('notifications').delete().neq('id', 0); results.push('notifications cleared'); } catch (e) { results.push('clear notifications: ' + e.message); }
    try { await sb.from('messages').delete().neq('id', 0); results.push('messages cleared'); } catch (e) { results.push('clear messages: ' + e.message); }
    try { await sb.from('investments').delete().neq('id', 0); results.push('investments cleared'); } catch (e) { results.push('clear investments: ' + e.message); }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== PROFILE SETTINGS =====================
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('users', '*', { id: req.userId }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'User not found' });
    const u = result.data;
    res.json({ user: { id: u.id, username: u.username, email: u.email || '', phone: u.phone || '', fullName: u.full_name || '', balance: u.balance || 0, totalEarned: u.total_earned || 0, referralCode: u.referral_code || '', createdAt: u.created_at || '', nickname: u.nickname || '', avatarUrl: u.avatar_url || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const { email, phone, fullName, nickname, avatarUrl } = req.body;
  const allowedFields = {};
  if (email !== undefined) allowedFields.email = email;
  if (phone !== undefined) allowedFields.phone = phone;
  if (fullName !== undefined) allowedFields.full_name = fullName;
  if (nickname !== undefined) allowedFields.nickname = nickname;
  if (avatarUrl !== undefined) allowedFields.avatar_url = avatarUrl;
  try {
    await dbUpdate('users', allowedFields, { id: req.userId });
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const result = await dbQuery('users', '*', { id: req.userId }, { single: true });
    const user = result.data;
    let valid = false;
    if (user.password) {
      valid = await bcrypt.compare(currentPassword, user.password);
    } else if (user.plain_password) {
      valid = (currentPassword === user.plain_password);
    }
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const updateResult = await dbUpdate('users', { password: hashed, plain_password: newPassword }, { id: req.userId });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== FORGOT PASSWORD =====================
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email address is required' });
  try {
    const emailResult = await dbQuery('users', 'id, username, email', { email }, { single: true });
    if (!emailResult.data) return res.status(400).json({ error: 'No account found with this email address' });
    const user = emailResult.data;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await dbUpdate('users', { reset_code: code, reset_expires: expires.toISOString() }, { id: user.id });
    try {
      const transporter = require('nodemailer').createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' }
      });
      if (process.env.SMTP_USER) {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'Enrich U <noreply@enrichu.com>',
          to: email,
          subject: 'Password Reset Code - Enrich U',
          html: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;"><h2 style="color:#0057ff;">Password Reset</h2><p>Hi ${user.username},</p><p>Your 6-digit verification code is:</p><div style="text-align:center;padding:20px;background:#f5f5f5;border-radius:8px;margin:20px 0;"><span style="font-size:36px;font-weight:900;color:#0057ff;letter-spacing:8px;">${code}</span></div><p style="color:#666;font-size:0.85rem;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p><p style="color:#999;font-size:0.75rem;">Enrich U — Enriching Lives</p></div>`
        });
        res.json({ success: true, message: 'Verification code sent to ' + email });
      } else {
        res.json({ success: true, message: 'Verification code generated. Email not configured — contact support.', code });
      }
    } catch (e) {
      res.json({ success: true, message: 'Verification code generated. Email not configured — contact support.', code });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be 6 digits' });
  try {
    const result = await dbQuery('users', 'id, reset_code, reset_expires', { email }, { single: true });
    if (!result.data || result.data.reset_code !== code) return res.status(400).json({ error: 'Invalid verification code' });
    if (new Date(result.data.reset_expires) < new Date()) return res.status(400).json({ error: 'Verification code has expired. Request a new one.' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await dbUpdate('users', { password: hashed, reset_code: null, reset_expires: null }, { id: result.data.id });
    res.json({ success: true, message: 'Password reset successful. You can now login with your new password.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== REFERRAL SYSTEM =====================
function generateReferralCode() {
  return 'ENRICH-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

app.get('/api/referral', requireAuth, async (req, res) => {
  try {
    const user = await dbQuery('users', 'referral_code', { id: req.userId }, { single: true });
    if (!user.data.referral_code) {
      const code = generateReferralCode();
      await dbUpdate('users', { referral_code: code }, { id: req.userId });
      return res.json({ referralCode: code, referralCount: 0, referralEarnings: 0 });
    }
    const referrals = await dbQuery('users', 'id, username, created_at', { referred_by: user.data.referral_code });
    const count = referrals.data?.length || 0;
    const earnings = await dbQuery('transactions', 'amount', { user_id: req.userId, type: 'referral_bonus' });
    const totalEarnings = earnings.data?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
    res.json({ referralCode: user.data.referral_code, referralCount: count, referralEarnings: totalEarnings, referrals: referrals.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== CHAT / SUPPORT =====================
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('messages', '*', { user_id: req.userId }, { order: { column: 'created_at', ascending: true } });
    res.json({ messages: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/messages', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  try {
    await dbInsert('messages', { user_id: req.userId, sender: 'user', message: message.trim() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/messages', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('messages', '*', {}, { order: { column: 'created_at', ascending: true } });
    res.json({ messages: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/messages', requireAuth, requireAdmin, async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });
  try {
    await dbInsert('messages', { user_id: userId, sender: 'admin', message: message.trim() });
    await dbInsert('notifications', { user_id: userId, title: 'Support Reply', message: 'Admin replied to your message. Check your chat.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== ADMIN USER INVESTMENTS =====================
app.get('/api/admin/user-investments/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('investments', '*', { user_id: parseInt(req.params.userId) }, { order: { column: 'created_at', ascending: false } });
    res.json({ investments: result.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== ADMIN ACTIVITY LOG =====================
app.get('/api/admin/activity-log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const allActivities = [];
    const users = await dbQuery('users', '*');
    const userMap = {};
    (users.data || []).forEach(u => { userMap[u.id] = { name: u.nickname || u.username, avatar: u.avatar_url || '' }; });

    const investments = await dbQuery('investments', 'id, user_id, vip_level, amount, status, created_at', {}, { order: { column: 'created_at', ascending: false }, limit: 50 });
    (investments.data || []).forEach(i => {
      const u = userMap[i.user_id] || { name: 'User #' + i.user_id };
      allActivities.push({ type: 'investment', user: u.name, avatar: u.avatar, detail: `VIP ${i.vip_level} — ₦${Number(i.amount).toLocaleString()}`, status: i.status, time: i.created_at });
    });

    const withdrawals = await dbQuery('withdrawals', 'id, user_id, amount, status, created_at', {}, { order: { column: 'created_at', ascending: false }, limit: 50 });
    (withdrawals.data || []).forEach(w => {
      const u = userMap[w.user_id] || { name: 'User #' + w.user_id };
      allActivities.push({ type: 'withdrawal', user: u.name, avatar: u.avatar, detail: `₦${Number(w.amount).toLocaleString()}`, status: w.status, time: w.created_at });
    });

    const taskClaims = await dbQuery('task_claims', 'id, user_id, investment_id, amount, claim_date', {}, { order: { column: 'claim_date', ascending: false }, limit: 50 });
    (taskClaims.data || []).forEach(t => {
      const u = userMap[t.user_id] || { name: 'User #' + t.user_id };
      allActivities.push({ type: 'task_claim', user: u.name, avatar: u.avatar, detail: `₦${Number(t.amount).toLocaleString()} on ${t.claim_date}`, status: 'completed', time: t.claim_date });
    });

    const messages = await dbQuery('messages', 'id, user_id, sender, message, created_at', {}, { order: { column: 'created_at', ascending: false }, limit: 50 });
    (messages.data || []).forEach(m => {
      const u = userMap[m.user_id] || { name: 'User #' + m.user_id };
      allActivities.push({ type: 'message', user: u.name, avatar: u.avatar, detail: (m.sender === 'admin' ? 'Admin' : 'User') + ': ' + m.message.substring(0, 80), status: m.sender, time: m.created_at });
    });

    allActivities.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ activities: allActivities.slice(0, 100) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== ADMIN ADD BALANCE =====================
app.post('/api/admin/add-balance', requireAuth, requireAdmin, async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'userId and positive amount required' });
  try {
    const user = await dbQuery('users', 'id, balance, total_earned', { id: parseInt(userId) }, { single: true });
    if (!user.data) return res.status(404).json({ error: 'User not found' });
    const newBal = user.data.balance + parseFloat(amount);
    const newEarned = user.data.total_earned + parseFloat(amount);
    await dbUpdate('users', { balance: newBal, total_earned: newEarned }, { id: parseInt(userId) });
    await dbInsert('transactions', { user_id: parseInt(userId), type: 'admin_credit', vip_level: 0, amount: parseFloat(amount), status: 'completed', reference: 'ADMIN-' + Date.now(), bank_name: '', account_number: '', account_name: '' });
    await dbInsert('notifications', { user_id: parseInt(userId), title: 'Balance Credited', message: `Admin credited ₦${parseFloat(amount).toLocaleString()} to your wallet.` });
    res.json({ success: true, message: `₦${parseFloat(amount).toLocaleString()} added to user's wallet` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/upgrade-vip/:id', requireAuth, requireAdmin, async (req, res) => {
  const { vipLevel } = req.body;
  const userId = parseInt(req.params.id);
  if (!vipLevel || vipLevel < 1 || vipLevel > 9) return res.status(400).json({ error: 'Valid VIP level (1-9) required' });
  try {
    const user = await dbQuery('users', 'id, username, vip_level', { id: userId }, { single: true });
    if (!user.data) return res.status(404).json({ error: 'User not found' });
    if (user.data.username === 'admin') return res.status(400).json({ error: 'Cannot upgrade admin account' });
    const plan = VIP_PLANS[vipLevel];
    if (!plan) return res.status(400).json({ error: 'Invalid VIP level' });
    const currentVip = user.data.vip_level || 0;
    if (vipLevel <= currentVip) return res.status(400).json({ error: `User already has VIP ${currentVip}. Must upgrade to a higher level.` });
    await dbUpdate('users', { vip_level: vipLevel }, { id: userId });
    await dbInsert('investments', { user_id: userId, vip_level: vipLevel, amount: plan.amount, daily_return: plan.dailyReturn, status: 'active', reference: 'ADMIN-' + Date.now(), total_collected: 0, days_collected: 0 });
    await dbInsert('notifications', { user_id: userId, title: 'VIP Upgrade', message: `Admin upgraded you to VIP ${vipLevel} (₦${plan.amount.toLocaleString()}). Daily return: ₦${plan.dailyReturn.toLocaleString()}.` });
    res.json({ success: true, message: `User upgraded from VIP ${currentVip} to VIP ${vipLevel}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/edit-user/:id', requireAuth, requireAdmin, async (req, res) => {
  const { nickname, email, phone } = req.body;
  const target = await dbQuery('users', 'username', { id: parseInt(req.params.id) }, { single: true });
  if (target.data && target.data.username === 'admin') return res.status(400).json({ error: 'Cannot edit the main admin account' });
  const allowedFields = {};
  if (nickname !== undefined) allowedFields.nickname = nickname;
  if (email !== undefined) allowedFields.email = email;
  if (phone !== undefined) allowedFields.phone = phone;
  try {
    await dbUpdate('users', allowedFields, { id: parseInt(req.params.id) });
    res.json({ success: true, message: 'User updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-password/:id', requireAuth, requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const user = await dbQuery('users', 'id, username', { id: parseInt(req.params.id) }, { single: true });
    if (!user.data) return res.status(404).json({ error: 'User not found' });
    if (user.data.username === 'admin') return res.status(400).json({ error: 'Cannot reset the main admin password' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const updateResult = await dbUpdate('users', { password: hashed, plain_password: newPassword }, { id: parseInt(req.params.id) });
    if (updateResult.error) {
      await dbUpdate('users', { password: hashed }, { id: parseInt(req.params.id) });
    }
    await dbInsert('notifications', { user_id: parseInt(req.params.id), title: 'Password Reset', message: 'Admin has reset your password. Please login with your new password.' });
    res.json({ success: true, message: `Password reset for ${user.data.username}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== ADMIN CLEAR DATA =====================
app.post('/api/admin/clear-transactions', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (isSupabase()) {
      const { supabase } = require('../database');
      const sb = supabase();
      await sb.from('transactions').delete().neq('id', 0);
    } else {
      const { default: { mem } } = await import('../database.js');
      mem.transactions = [];
    }
    res.json({ success: true, message: 'All transactions cleared' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-all', requireAuth, requireAdmin, async (req, res) => {
  const { table } = req.body;
  const allowed = ['transactions', 'withdrawals', 'task_claims', 'notifications', 'messages', 'investments'];
  if (!allowed.includes(table)) return res.status(400).json({ error: 'Invalid table. Allowed: ' + allowed.join(', ') });
  try {
    if (isSupabase()) {
      const { supabase } = require('../database');
      const sb = supabase();
      await sb.from(table).delete().neq('id', 0);
    } else {
      const db = require('../database');
      if (db.mem && db.mem[table]) db.mem[table] = [];
    }
    res.json({ success: true, message: `All data in ${table} cleared` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/delete-user/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const target = await dbQuery('users', 'username', { id: userId }, { single: true });
    if (target.data && target.data.username === 'admin') return res.status(400).json({ error: 'Cannot delete the main admin account' });
    if (isSupabase()) {
      const { supabase } = require('../database');
      const sb = supabase();
      await sb.from('notifications').delete().eq('user_id', userId);
      await sb.from('task_claims').delete().eq('user_id', userId);
      await sb.from('messages').delete().eq('user_id', userId);
      await sb.from('withdrawals').delete().eq('user_id', userId);
      await sb.from('investments').delete().eq('user_id', userId);
      await sb.from('transactions').delete().eq('user_id', userId);
      await sb.from('users').delete().eq('id', userId);
    }
    res.json({ success: true, message: 'User and all related data deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== INVESTMENT POP-UP NOTIFICATIONS =====================
const NG_LOCATIONS = ['Lagos','Abuja','Rivers','Kano','Oyo','Delta','Enugu','Anambra','Imo','Abia','Akwa Ibom','Cross River','Edo','Ondo','Osun','Ogun','Ekiti','Kwara','Kogi','Benue','Nasarawa','Plateau','Taraba','Adamawa','Borno','Yobe','Gombe','Bauchi','Sokoto','Zamfara','Kebbi','Katsina','Jigawa','Kaduna','Niger','Bayelsa'];

app.get('/api/real-investments', requireAuth, async (req, res) => {
  try {
    const since = parseInt(req.query.since) || 0;
    const result = await dbQuery('investments', 'id, user_id, vip_level, amount, created_at', { id: { op: 'gt', val: since } }, { order: { column: 'id', ascending: false }, limit: 10 });
    const investments = [];
    for (const inv of (result.data || [])) {
      const user = await dbQuery('users', '*', { id: inv.user_id }, { single: true });
      const name = user.data?.nickname || user.data?.username || 'A user';
      const location = NG_LOCATIONS[inv.user_id % NG_LOCATIONS.length];
      investments.push({ id: inv.id, name, vip_level: inv.vip_level, amount: inv.amount, location, created_at: inv.created_at });
    }
    res.json({ investments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== HTML ROUTES =====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// ===================== INIT =====================
let dbInitialized = false;
module.exports = async (req, res) => {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }
  return app(req, res);
};
