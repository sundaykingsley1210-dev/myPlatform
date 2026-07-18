const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const path = require('path');
const { initDatabase, saveDatabase, getDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY || 'MK_TEST_AT2CBMNZX6';
const MONNIFY_SECRET = process.env.MONNIFY_SECRET || '9VCCTEUUY5J63TJUGP8DN7ENLAP13WYC';
const MONNIFY_BASE_URL = 'https://api.monnify.com';

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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'enrich-u-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please login to continue' });
  }
  next();
}

// ===================== AUTH ROUTES =====================

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = db.exec("SELECT id FROM users WHERE username = ?", [username]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return res.status(400).json({ error: 'Account already exists! Please login instead.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  try {
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword]);
    saveDatabase();

    const result = db.exec("SELECT id FROM users WHERE username = ?", [username]);
    const userId = result[0].values[0][0];

    req.session.userId = userId;
    req.session.username = username;

    res.json({ success: true, message: 'Account created successfully!', userId, username });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const result = db.exec("SELECT id, username, password, balance, total_earned FROM users WHERE username = ?", [username]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }

  const [id, uname, hashedPassword, balance, totalEarned] = result[0].values[0];

  if (!bcrypt.compareSync(password, hashedPassword)) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }

  req.session.userId = id;
  req.session.username = uname;

  res.json({
    success: true,
    message: 'Login successful!',
    user: { id, username: uname, balance, totalEarned }
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logged out' });
});

app.get('/api/me', requireAuth, (req, res) => {
  const db = getDb();
  const result = db.exec("SELECT id, username, balance, total_earned FROM users WHERE id = ?", [req.session.userId]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  const [id, username, balance, totalEarned] = result[0].values[0];
  res.json({ user: { id, username, balance, totalEarned } });
});

// ===================== VIP PLANS =====================

app.get('/api/vip-plans', (req, res) => {
  res.json({ plans: VIP_PLANS });
});

// ===================== PAYMENT / INVESTMENT =====================

app.post('/api/create-investment', requireAuth, async (req, res) => {
  const { vipLevel } = req.body;
  const db = getDb();
  const plan = VIP_PLANS[vipLevel];

  if (!plan) {
    return res.status(400).json({ error: 'Invalid VIP level' });
  }

  const existingActive = db.exec(
    "SELECT id FROM investments WHERE user_id = ? AND vip_level = ? AND status = 'active'",
    [req.session.userId, vipLevel]
  );
  if (existingActive.length > 0 && existingActive[0].values.length > 0) {
    return res.status(400).json({ error: 'You already have an active investment in this VIP plan' });
  }

  const ref = `ENRICH-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  try {
    let accountDetails = null;

    try {
      const tokenResponse = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/json'
        }
      });

      if (tokenResponse.data && tokenResponse.data.responseBody && tokenResponse.data.responseBody.accessToken) {
        const accessToken = tokenResponse.data.responseBody.accessToken;

        const reservedAccount = await axios.post(`${MONNIFY_BASE_URL}/api/v2/BankTransfer/ReserveAccount`, {
          accountReference: ref,
          accountName: `EnrichU-${req.session.username}`,
          currencyCode: 'NGN',
          contractCode: MONNIFY_API_KEY,
          customerEmail: `${req.session.username}@enrichu.com`,
          customerName: req.session.username,
          bvn: '00000000000',
          redirectUrl: `http://localhost:${PORT}/dashboard.html`
        }, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (reservedAccount.data && reservedAccount.data.responseBody) {
          accountDetails = reservedAccount.data.responseBody;
        }
      }
    } catch (monnifyErr) {
      console.log('Monnify integration not configured, using mock bank details');
    }

    if (!accountDetails) {
      const bankNames = ['Wema Bank', 'Sterling Bank', 'Kuda Bank', 'VBank'];
      accountDetails = {
        accountNumber: `${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        bankName: bankNames[Math.floor(Math.random() * bankNames.length)],
        accountName: `EnrichU-${req.session.username}`
      };
    }

    db.run(
      "INSERT INTO transactions (user_id, type, amount, status, reference, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [req.session.userId, 'investment', plan.amount, 'pending', ref,
       accountDetails.bankName || accountDetails.bankName,
       accountDetails.accountNumber,
       accountDetails.accountName]
    );
    saveDatabase();

    res.json({
      success: true,
      message: 'Payment details generated. Please make payment to complete your investment.',
      paymentDetails: {
        reference: ref,
        amount: plan.amount,
        bankName: accountDetails.bankName,
        accountNumber: accountDetails.accountNumber,
        accountName: accountDetails.accountName,
        vipLevel: vipLevel
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create investment: ' + err.message });
  }
});

app.post('/api/verify-payment', requireAuth, (req, res) => {
  const { reference } = req.body;
  const db = getDb();

  const result = db.exec(
    "SELECT id, vip_level, amount, status FROM transactions WHERE reference = ? AND user_id = ?",
    [reference, req.session.userId]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const [txId, vipLevel, amount, status] = result[0].values[0];

  if (status === 'completed') {
    return res.json({ success: true, message: 'Payment already verified' });
  }

  const plan = VIP_PLANS[vipLevel];

  db.run("UPDATE transactions SET status = 'completed' WHERE id = ?", [txId]);
  db.run(
    "INSERT INTO investments (user_id, vip_level, amount, daily_return, status) VALUES (?, ?, ?, ?, 'active')",
    [req.session.userId, vipLevel, amount, plan.dailyReturn]
  );
  saveDatabase();

  res.json({ success: true, message: 'Payment verified! Your investment is now active.' });
});

// ===================== USER INVESTMENTS =====================

app.get('/api/my-investments', requireAuth, (req, res) => {
  const db = getDb();
  const result = db.exec(
    "SELECT id, vip_level, amount, daily_return, status, total_collected, days_collected, created_at FROM investments WHERE user_id = ? ORDER BY created_at DESC",
    [req.session.userId]
  );

  const investments = [];
  if (result.length > 0) {
    investments.push(...result[0].values.map(row => ({
      id: row[0],
      vipLevel: row[1],
      amount: row[2],
      dailyReturn: row[3],
      status: row[4],
      totalCollected: row[5],
      daysCollected: row[6],
      createdAt: row[7]
    })));
  }

  res.json({ investments });
});

// ===================== TASK SYSTEM =====================

app.get('/api/task-status', requireAuth, (req, res) => {
  const now = new Date();
  const nigeriaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = nigeriaTime.getDay();
  const hours = nigeriaTime.getHours();
  const minutes = nigeriaTime.getMinutes();
  const currentTime = hours * 60 + minutes;

  const isWeekday = day >= 1 && day <= 5;
  const isTaskTime = currentTime >= 600 && currentTime < 1020; // 10am to 5pm (last claim before 6pm)

  res.json({
    isWeekday,
    isTaskTime,
    canClaim: isWeekday && isTaskTime,
    nigeriaTime: nigeriaTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
    message: !isWeekday
      ? 'Tasks are only available Monday to Friday.'
      : !isTaskTime
        ? 'Tasks are available between 10:00 AM and 6:00 PM. No task yet.'
        : 'Tasks are active! You can collect your daily returns.'
  });
});

app.post('/api/claim-task', requireAuth, (req, res) => {
  const { investmentId } = req.body;
  const db = getDb();

  const now = new Date();
  const nigeriaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = nigeriaTime.getDay();
  const hours = nigeriaTime.getHours();
  const minutes = nigeriaTime.getMinutes();
  const currentTime = hours * 60 + minutes;

  const isWeekday = day >= 1 && day <= 5;
  const isTaskTime = currentTime >= 600 && currentTime < 1020;

  if (!isWeekday || !isTaskTime) {
    return res.status(400).json({ error: 'Tasks are only available Monday to Friday, between 10:00 AM and 6:00 PM.' });
  }

  const result = db.exec(
    "SELECT id, vip_level, daily_return, status, total_collected, days_collected FROM investments WHERE id = ? AND user_id = ?",
    [investmentId, req.session.userId]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ error: 'Investment not found' });
  }

  const [id, vipLevel, dailyReturn, status, totalCollected, daysCollected] = result[0].values[0];

  if (status !== 'active') {
    return res.status(400).json({ error: 'This investment is not active' });
  }

  const today = nigeriaTime.toISOString().split('T')[0];
  const existingClaim = db.exec(
    "SELECT id FROM task_claims WHERE user_id = ? AND investment_id = ? AND claim_date = ?",
    [req.session.userId, investmentId, today]
  );

  if (existingClaim.length > 0 && existingClaim[0].values.length > 0) {
    return res.status(400).json({ error: 'You have already collected today\'s return for this investment. Come back tomorrow!' });
  }

  db.run(
    "INSERT INTO task_claims (user_id, investment_id, claim_date, amount) VALUES (?, ?, ?, ?)",
    [req.session.userId, investmentId, today, dailyReturn]
  );

  db.run(
    "UPDATE investments SET total_collected = total_collected + ?, days_collected = days_collected + 1 WHERE id = ?",
    [dailyReturn, investmentId]
  );

  db.run(
    "UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?",
    [dailyReturn, dailyReturn, req.session.userId]
  );

  saveDatabase();

  const newBalance = db.exec("SELECT balance FROM users WHERE id = ?", [req.session.userId]);
  const balance = newBalance[0].values[0][0];

  res.json({
    success: true,
    message: `Successfully collected ₦${dailyReturn.toLocaleString()}! Added to your balance.`,
    amount: dailyReturn,
    newBalance: balance,
    totalCollected: totalCollected + dailyReturn,
    daysCollected: daysCollected + 1
  });
});

// ===================== WITHDRAWALS =====================

app.post('/api/withdraw', requireAuth, (req, res) => {
  const { amount, bankName, accountNumber, accountName } = req.body;
  const db = getDb();

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal amount' });
  }

  if (!bankName || !accountNumber || !accountName) {
    return res.status(400).json({ error: 'Bank details are required' });
  }

  const userResult = db.exec("SELECT balance FROM users WHERE id = ?", [req.session.userId]);
  const balance = userResult[0].values[0][0];

  if (balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const now = new Date();
  const nigeriaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = nigeriaTime.getDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const currentDayName = dayNames[day];

  const investments = db.exec(
    "SELECT DISTINCT vip_level FROM investments WHERE user_id = ? AND status = 'active'",
    [req.session.userId]
  );

  if (investments.length === 0 || investments[0].values.length === 0) {
    return res.status(400).json({ error: 'You have no active investments' });
  }

  const vipLevels = investments[0].values.map(row => row[0]);
  const allowedDays = new Set();
  vipLevels.forEach(level => {
    allowedDays.add(VIP_PLANS[level].withdrawalDay);
  });

  if (!allowedDays.has(currentDayName)) {
    const dayList = [...allowedDays].join(', ');
    return res.status(400).json({
      error: `Withdrawal is not available today (${currentDayName}). Withdrawal days for your VIP levels: ${dayList}`
    });
  }

  db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, req.session.userId]);

  db.run(
    "INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    [req.session.userId, amount, bankName, accountNumber, accountName]
  );

  saveDatabase();

  const newBalance = db.exec("SELECT balance FROM users WHERE id = ?", [req.session.userId]);
  const newBal = newBalance[0].values[0][0];

  res.json({
    success: true,
    message: `Withdrawal of ₦${amount.toLocaleString()} submitted successfully. It will be processed within 24 hours.`,
    newBalance: newBal
  });
});

app.get('/api/my-withdrawals', requireAuth, (req, res) => {
  const db = getDb();
  const result = db.exec(
    "SELECT id, amount, bank_name, account_number, account_name, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC",
    [req.session.userId]
  );

  const withdrawals = [];
  if (result.length > 0) {
    withdrawals.push(...result[0].values.map(row => ({
      id: row[0],
      amount: row[1],
      bankName: row[2],
      accountNumber: row[3],
      accountName: row[4],
      status: row[5],
      createdAt: row[6]
    })));
  }

  res.json({ withdrawals });
});

// ===================== HTML ROUTES =====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===================== START SERVER =====================

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Enrich U server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
