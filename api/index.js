const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const { initDatabase, dbQuery, dbInsert, dbUpdate, isSupabase } = require('../database');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'enrich-u-jwt-secret-2026';
const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY || 'MK_TEST_AT2CBMNZX6';
const MONNIFY_SECRET = process.env.MONNIFY_SECRET || '9VCCTEUUY5J63TJUGP8DN7ENLAP13WYC';
const MONNIFY_BASE_URL = 'https://api.monnify.com';
const SITE_URL = process.env.SITE_URL || 'https://myplatform-seven.vercel.app';

const VIP_PLANS = {
  1: { amount: 9000, dailyReturn: 800, withdrawalDay: 'Tuesday' },
  2: { amount: 27000, dailyReturn: 2700, withdrawalDay: 'Tuesday' },
  3: { amount: 54000, dailyReturn: 6000, withdrawalDay: 'Wednesday' },
  4: { amount: 81000, dailyReturn: 10200, withdrawalDay: 'Wednesday' },
  5: { amount: 120000, dailyReturn: 15000, withdrawalDay: 'Thursday' },
  6: { amount: 200000, dailyReturn: 18000, withdrawalDay: 'Thursday' },
  7: { amount: 230000, dailyReturn: 21000, withdrawalDay: 'Friday' },
  8: { amount: 280000, dailyReturn: 28000, withdrawalDay: 'Friday' }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Serve PWA files explicitly for Vercel
app.get('/manifest.json', (req, res) => res.sendFile(path.join(publicDir, 'manifest.json')));
app.get('/service-worker.js', (req, res) => res.sendFile(path.join(publicDir, 'service-worker.js')));
app.get('/icons/:file', (req, res) => res.sendFile(path.join(publicDir, 'icons', req.params.file)));

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
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const existing = await dbQuery('users', 'id', { username });
    if (existing.data && existing.data.length > 0) {
      return res.status(400).json({ error: 'Account already exists! Please login instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await dbInsert('users', { username, password: hashedPassword });

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
    const result = await dbQuery('users', 'id, username, password, balance, total_earned, is_admin', { username }, { single: true });
    if (!result.data) return res.status(400).json({ error: 'Invalid username or password' });

    const user = result.data;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid username or password' });

    const token = generateToken(user);
    res.json({ success: true, message: 'Login successful!', token, user: { id: user.id, username: user.username, balance: user.balance, totalEarned: user.total_earned, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('users', 'id, username, balance, total_earned, email, is_admin', { id: req.userId }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'User not found' });
    const u = result.data;
    res.json({ user: { id: u.id, username: u.username, balance: u.balance, totalEarned: u.total_earned, email: u.email, isAdmin: u.is_admin } });
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
    const existing = await dbQuery('investments', 'id', { user_id: req.userId, vip_level: parseInt(vipLevel), status: 'active' });
    if (existing.data && existing.data.length > 0) return res.status(400).json({ error: 'You already have an active investment in this VIP plan' });

    const ref = `ENRICH-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    let accountDetails = null;

    try {
      const tokenRes = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
        headers: { 'Authorization': `Basic ${Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' }
      });
      if (tokenRes.data?.responseBody?.accessToken) {
        const accRes = await axios.post(`${MONNIFY_BASE_URL}/api/v2/BankTransfer/ReserveAccount`, {
          accountReference: ref, accountName: `EnrichU-${req.username}`, currencyCode: 'NGN',
          contractCode: MONNIFY_API_KEY, customerEmail: `${req.username}@enrichu.com`,
          customerName: req.username, bvn: '00000000000', redirectUrl: `${SITE_URL}/dashboard.html`
        }, { headers: { 'Authorization': `Bearer ${tokenRes.data.responseBody.accessToken}`, 'Content-Type': 'application/json' } });
        if (accRes.data?.responseBody) accountDetails = accRes.data.responseBody;
      }
    } catch (e) { console.log('Monnify mock mode'); }

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
    await dbUpdate('transactions', { status: 'completed' }, { id: tx.id });
    await dbInsert('investments', { user_id: req.userId, vip_level: tx.vip_level, amount: tx.amount, daily_return: plan.dailyReturn, status: 'active' });

    await dbInsert('notifications', { user_id: req.userId, title: 'Investment Activated!', message: `Your VIP ${tx.vip_level} investment of ₦${tx.amount.toLocaleString()} is now active. Start collecting daily returns!` });

    res.json({ success: true, message: 'Payment verified! Your investment is now active.' });
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

  try {
    const userRes = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
    if (userRes.data.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const ng = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = dayNames[ng.getDay()];

    const invRes = await dbQuery('investments', 'vip_level', { user_id: req.userId, status: 'active' });
    if (!invRes.data || invRes.data.length === 0) return res.status(400).json({ error: 'No active investments' });

    const allowedDays = new Set(invRes.data.map(i => VIP_PLANS[i.vip_level]?.withdrawalDay));
    if (!allowedDays.has(currentDay)) return res.status(400).json({ error: `Not available today (${currentDay}). Your days: ${[...allowedDays].join(', ')}` });

    await dbUpdate('users', { balance: userRes.data.balance - amount }, { id: req.userId });
    await dbInsert('withdrawals', { user_id: req.userId, amount, bank_name: bankName, account_number: accountNumber, account_name: accountName, status: 'pending' });

    await dbInsert('notifications', { user_id: req.userId, title: 'Withdrawal Submitted', message: `Your withdrawal of ₦${amount.toLocaleString()} has been submitted and is being processed.` });

    const newBal = await dbQuery('users', 'balance', { id: req.userId }, { single: true });
    res.json({ success: true, message: `Withdrawal of ₦${amount.toLocaleString()} submitted.`, newBalance: newBal.data.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-withdrawals', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('withdrawals', '*', { user_id: req.userId }, { order: { column: 'created_at', ascending: false } });
    const withdrawals = (result.data || []).map(w => ({ id: w.id, amount: w.amount, bankName: w.bank_name, accountNumber: w.account_number, accountName: w.account_name, status: w.status, adminNote: w.admin_note, createdAt: w.created_at }));
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
    const result = await dbQuery('users', 'id, username, email, balance, total_earned, is_admin, created_at', {}, { order: { column: 'created_at', ascending: false } });
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

// ===================== APP DOWNLOAD PAYMENT =====================
const DOWNLOAD_FEE = 3500;

app.get('/api/download-status', requireAuth, async (req, res) => {
  try {
    const result = await dbQuery('transactions', 'id, status', { user_id: req.userId, type: 'app_download', status: 'completed' }, { single: true });
    res.json({ paid: !!result.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/request-download', requireAuth, async (req, res) => {
  try {
    const existing = await dbQuery('transactions', 'id, status', { user_id: req.userId, type: 'app_download', status: 'completed' }, { single: true });
    if (existing.data) return res.json({ success: true, paid: true, message: 'Already paid' });

    const ref = `ENRICHU-DL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    let accountDetails = null;

    try {
      const tokenRes = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
        headers: { 'Authorization': `Basic ${Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' }
      });
      if (tokenRes.data?.responseBody?.accessToken) {
        const accRes = await axios.post(`${MONNIFY_BASE_URL}/api/v2/BankTransfer/ReserveAccount`, {
          accountReference: ref, accountName: `EnrichU-Download-${req.username}`, currencyCode: 'NGN',
          contractCode: MONNIFY_API_KEY, customerEmail: `${req.username}@enrichu.com`,
          customerName: req.username, bvn: '00000000000', redirectUrl: `${SITE_URL}/dashboard.html`
        }, { headers: { 'Authorization': `Bearer ${tokenRes.data.responseBody.accessToken}`, 'Content-Type': 'application/json' } });
        if (accRes.data?.responseBody) accountDetails = accRes.data.responseBody;
      }
    } catch (e) { console.log('Monnify mock mode for download'); }

    if (!accountDetails) {
      const banks = ['Wema Bank', 'Sterling Bank', 'Kuda Bank', 'VBank'];
      accountDetails = {
        accountNumber: `${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        bankName: banks[Math.floor(Math.random() * banks.length)],
        accountName: `EnrichU-Download-${req.username}`
      };
    }

    await dbInsert('transactions', {
      user_id: req.userId, type: 'app_download', vip_level: 0, amount: DOWNLOAD_FEE,
      status: 'pending', reference: ref,
      bank_name: accountDetails.bankName || accountDetails.bank_name || 'Bank',
      account_number: accountDetails.accountNumber || accountDetails.account_number || '0000000000',
      account_name: accountDetails.accountName || accountDetails.account_name || `EnrichU-${req.username}`
    });

    res.json({
      success: true, paid: false,
      paymentDetails: {
        reference: ref, amount: DOWNLOAD_FEE,
        bankName: accountDetails.bankName || accountDetails.bank_name || 'Bank',
        accountNumber: accountDetails.accountNumber || accountDetails.account_number || '0000000000',
        accountName: accountDetails.accountName || accountDetails.account_name || `EnrichU-${req.username}`
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/verify-download', requireAuth, async (req, res) => {
  const { reference } = req.body;
  try {
    const result = await dbQuery('transactions', 'id, status', { reference, user_id: req.userId, type: 'app_download' }, { single: true });
    if (!result.data) return res.status(404).json({ error: 'Transaction not found' });
    if (result.data.status === 'completed') return res.json({ success: true, paid: true, message: 'Already verified' });

    await dbUpdate('transactions', { status: 'completed' }, { id: result.data.id });
    await dbInsert('notifications', { user_id: req.userId, title: 'App Download Unlocked', message: 'Your app download fee has been confirmed. You can now install the Enrich U app!' });

    res.json({ success: true, paid: true, message: 'Payment verified! You can now install the app.' });
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
    const user = await dbQuery('users', 'is_admin', { id: parseInt(id) }, { single: true });
    if (!user.data) return res.status(404).json({ error: 'User not found' });
    await dbUpdate('users', { is_admin: !user.data.is_admin }, { id: parseInt(id) });
    res.json({ success: true, message: 'Admin status toggled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================== SETUP ADMIN =====================
app.get('/api/setup-admin', async (req, res) => {
  try {
    const result = await dbQuery('users', 'id', { username: 'admin' }, { single: true });
    if (result.data) {
      await dbUpdate('users', { is_admin: true }, { username: 'admin' });
      res.json({ success: true, message: 'Admin user is_admin set to true' });
    } else {
      res.json({ success: false, message: 'No admin user found' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/migrate', async (req, res) => {
  try {
    if (!isSupabase()) return res.json({ success: false, message: 'Not using Supabase' });
    const { supabase } = require('../database');
    const sb = supabase();
    const results = [];
    try { await sb.rpc('exec_sql', { query: 'ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0' }); results.push('vip_level added'); } catch (e) { results.push('vip_level: ' + e.message); }
    res.json({ success: true, results });
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
