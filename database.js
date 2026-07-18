let users = [];
let investments = [];
let transactions = [];
let withdrawals = [];
let taskClaims = [];
let nextIds = { users: 1, investments: 1, transactions: 1, withdrawals: 1, task_claims: 1 };

function initDatabase() {
  console.log('In-memory database initialized');
  return Promise.resolve();
}

function saveDatabase() {}

const db = {
  run(sql, params = []) {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('INSERT INTO USERS')) {
      const id = nextIds.users++;
      const now = new Date().toISOString();
      users.push({ id, username: params[0], password: params[1], full_name: '', phone: '', email: '', balance: 0, total_earned: 0, created_at: now });
      return;
    }
    if (s.startsWith('INSERT INTO INVESTMENTS')) {
      const id = nextIds.investments++;
      const now = new Date().toISOString();
      investments.push({ id, user_id: params[0], vip_level: params[1], amount: params[2], daily_return: params[3], status: 'active', total_collected: 0, days_collected: 0, created_at: now });
      return;
    }
    if (s.startsWith('INSERT INTO TRANSACTIONS')) {
      const id = nextIds.transactions++;
      const now = new Date().toISOString();
      transactions.push({ id, user_id: params[0], type: params[1], amount: params[2], status: params[3], reference: params[4], bank_name: params[5], account_number: params[6], account_name: params[7], created_at: now });
      return;
    }
    if (s.startsWith('INSERT INTO WITHDRAWALS')) {
      const id = nextIds.withdrawals++;
      const now = new Date().toISOString();
      withdrawals.push({ id, user_id: params[0], amount: params[1], bank_name: params[2], account_number: params[3], account_name: params[4], status: params[5], created_at: now });
      return;
    }
    if (s.startsWith('INSERT INTO TASK_CLAIMS')) {
      const id = nextIds.task_claims++;
      const now = new Date().toISOString();
      taskClaims.push({ id, user_id: params[0], investment_id: params[1], claim_date: params[2], amount: params[3], created_at: now });
      return;
    }
    if (s.startsWith('UPDATE USERS SET BALANCE = BALANCE +') && s.includes('TOTAL_EARNED')) {
      const u = users.find(u => u.id === params[2]);
      if (u) { u.balance += params[0]; u.total_earned += params[1]; }
      return;
    }
    if (s.startsWith('UPDATE USERS SET BALANCE = BALANCE +')) {
      const u = users.find(u => u.id === params[1]);
      if (u) u.balance += params[0];
      return;
    }
    if (s.startsWith('UPDATE USERS SET BALANCE = BALANCE -')) {
      const u = users.find(u => u.id === params[1]);
      if (u) u.balance -= params[0];
      return;
    }
    if (s.startsWith('UPDATE INVESTMENTS SET TOTAL_COLLECTED')) {
      const inv = investments.find(i => i.id === params[1]);
      if (inv) { inv.total_collected += params[0]; inv.days_collected += 1; }
      return;
    }
    if (s.startsWith('UPDATE TRANSACTIONS SET STATUS')) {
      const tx = transactions.find(t => t.id === params[0]);
      if (tx) tx.status = 'completed';
      return;
    }
  },

  exec(sql, params = []) {
    const s = sql.trim().toUpperCase();
    const col = (row, name) => row ? row[name] : undefined;

    if (s.includes('FROM USERS WHERE USERNAME = ?') && !s.includes('BALANCE')) {
      const user = users.find(u => u.username === params[0]);
      if (!user) return [];
      return [{ values: [[user.id, user.username, user.password, user.balance, user.total_earned]] }];
    }
    if (s.includes('FROM USERS WHERE ID = ?') && s.includes('BALANCE')) {
      const user = users.find(u => u.id === params[0]);
      if (!user) return [];
      return [{ values: [[user.balance]] }];
    }
    if (s.includes('FROM USERS WHERE ID = ?') && s.includes('USERNAME')) {
      const user = users.find(u => u.id === params[0]);
      if (!user) return [];
      return [{ values: [[user.id, user.username, user.balance, user.total_earned]] }];
    }
    if (s.includes('SELECT ID FROM USERS WHERE USERNAME')) {
      const user = users.find(u => u.username === params[0]);
      if (!user) return [];
      return [{ values: [[user.id]] }];
    }
    if (s.includes('FROM INVESTMENTS WHERE USER_ID = ? AND VIP_LEVEL = ? AND STATUS')) {
      const inv = investments.find(i => i.user_id === params[0] && i.vip_level === params[1] && i.status === 'active');
      if (!inv) return [];
      return [{ values: [[inv.id]] }];
    }
    if (s.includes('FROM INVESTMENTS WHERE ID = ? AND USER_ID = ?')) {
      const inv = investments.find(i => i.id === params[0] && i.user_id === params[1]);
      if (!inv) return [];
      return [{ values: [[inv.id, inv.vip_level, inv.daily_return, inv.status, inv.total_collected, inv.days_collected]] }];
    }
    if (s.includes('FROM INVESTMENTS WHERE USER_ID = ?') && s.includes('ORDER BY')) {
      const invs = investments.filter(i => i.user_id === params[0]).sort((a, b) => b.id - a.id);
      if (invs.length === 0) return [];
      return [{ values: invs.map(i => [i.id, i.vip_level, i.amount, i.daily_return, i.status, i.total_collected, i.days_collected, i.created_at]) }];
    }
    if (s.includes('SELECT DISTINCT VIP_LEVEL FROM INVESTMENTS')) {
      const invs = investments.filter(i => i.user_id === params[0] && i.status === 'active');
      const levels = [...new Set(invs.map(i => i.vip_level))];
      if (levels.length === 0) return [];
      return [{ values: levels.map(l => [l]) }];
    }
    if (s.includes('FROM TRANSACTIONS WHERE REFERENCE = ?')) {
      const tx = transactions.find(t => t.reference === params[0] && t.user_id === params[1]);
      if (!tx) return [];
      return [{ values: [[tx.id, tx.vip_level, tx.amount, tx.status]] }];
    }
    if (s.includes('FROM TASK_CLAIMS WHERE USER_ID = ? AND INVESTMENT_ID = ? AND CLAIM_DATE')) {
      const tc = taskClaims.find(t => t.user_id === params[0] && t.investment_id === params[1] && t.claim_date === params[2]);
      if (!tc) return [];
      return [{ values: [[tc.id]] }];
    }
    if (s.includes('FROM WITHDRAWALS WHERE USER_ID = ?')) {
      const wds = withdrawals.filter(w => w.user_id === params[0]).sort((a, b) => b.id - a.id);
      if (wds.length === 0) return [];
      return [{ values: wds.map(w => [w.id, w.amount, w.bank_name, w.account_number, w.account_name, w.status, w.created_at]) }];
    }
    return [];
  }
};

function getDb() { return db; }

module.exports = { initDatabase, saveDatabase, getDb };
