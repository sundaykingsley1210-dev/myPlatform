const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
let useSupabase = false;

// In-memory fallback tables
const mem = {
  users: [],
  investments: [],
  transactions: [],
  withdrawals: [],
  task_claims: [],
  notifications: [],
  messages: [],
  reset_requests: []
};
let nextId = { users: 1, investments: 1, transactions: 1, withdrawals: 1, task_claims: 1, notifications: 1, messages: 1, reset_requests: 1 };

function initDatabase() {
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    useSupabase = true;
    console.log('Connected to Supabase');
  } else {
    console.log('No Supabase credentials - using in-memory database');
  }
  return Promise.resolve();
}

function saveDatabase() {}

// ========== IN-MEMORY HELPERS ==========
function memFilter(rows, filters) {
  return rows.filter(row => {
    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined) {
        if (row[key] !== null && row[key] !== undefined) return false;
      } else if (typeof value === 'object' && value.op) {
        const v = row[key];
        switch (value.op) {
          case 'eq': if (v !== value.val) return false; break;
          case 'neq': if (v === value.val) return false; break;
          case 'gt': if (!(v > value.val)) return false; break;
          case 'lt': if (!(v < value.val)) return false; break;
          case 'gte': if (!(v >= value.val)) return false; break;
          case 'lte': if (!(v <= value.val)) return false; break;
          case 'in': if (!value.val.includes(v)) return false; break;
          case 'like': if (!new RegExp('^' + value.val.replace(/%/g, '.*') + '$').test(v)) return false; break;
          case 'ilike': if (!new RegExp('^' + value.val.replace(/%/g, '.*') + '$', 'i').test(v)) return false; break;
        }
      } else {
        if (row[key] !== value) return false;
      }
    }
    return true;
  });
}

function memSelect(table, columns, filters, options) {
  let rows = memFilter(mem[table] || [], filters);
  if (options.order) {
    const dir = options.order.ascending ? 1 : -1;
    rows.sort((a, b) => (a[options.order.column] > b[options.order.column] ? dir : -dir));
  }
  if (options.limit) rows = rows.slice(0, options.limit);
  if (columns !== '*') {
    const cols = columns.split(',').map(c => c.trim());
    rows = rows.map(r => {
      const obj = {};
      cols.forEach(c => { obj[c] = r[c]; });
      return obj;
    });
  }
  return options.single ? (rows[0] || null) : rows;
}

function memInsert(table, data) {
  const id = nextId[table]++;
  const row = { id, ...data };
  mem[table] = mem[table] || [];
  mem[table].push(row);
  return row;
}

function memUpdate(table, data, filters) {
  const rows = memFilter(mem[table] || [], filters);
  rows.forEach(row => Object.assign(row, data));
  return rows;
}

// ========== MAIN API ==========
async function dbQuery(table, columns = '*', filters = {}, options = {}) {
  if (!useSupabase) {
    const result = memSelect(table, columns, filters, options);
    if (options.single) return { data: result, error: null };
    return { data: result || [], error: null };
  }

  let query = supabase.from(table).select(columns);
  for (const [key, value] of Object.entries(filters)) {
    if (value === null) { query = query.is(key, null); }
    else if (typeof value === 'object' && value.op) {
      switch (value.op) {
        case 'eq': query = query.eq(key, value.val); break;
        case 'neq': query = query.neq(key, value.val); break;
        case 'gt': query = query.gt(key, value.val); break;
        case 'lt': query = query.lt(key, value.val); break;
        case 'gte': query = query.gte(key, value.val); break;
        case 'lte': query = query.lte(key, value.val); break;
        case 'in': query = query.in(key, value.val); break;
        case 'like': query = query.like(key, value.val); break;
        case 'ilike': query = query.ilike(key, value.val); break;
      }
    } else { query = query.eq(key, value); }
  }
  if (options.order) query = query.order(options.order.column, { ascending: options.order.ascending ?? false });
  if (options.limit) query = query.limit(options.limit);
  if (options.single) query = query.single();
  const result = await query;
  if (result.error && result.error.message && (result.error.message.includes('does not exist') || result.error.message.includes('not found') || result.error.message.includes('Could not find'))) {
    console.log(`Table "${table}" not found in Supabase, using in-memory fallback`);
    const memResult = memSelect(table, columns, filters, options);
    if (options.single) return { data: memResult, error: null };
    return { data: memResult || [], error: null };
  }
  return result;
}

async function dbInsert(table, data) {
  if (!useSupabase) {
    const row = memInsert(table, data);
    return { data: [row], error: null };
  }
  const result = await supabase.from(table).insert(data).select();
  if (result.error && result.error.message && (result.error.message.includes('does not exist') || result.error.message.includes('not found') || result.error.message.includes('Could not find'))) {
    console.log(`Table "${table}" not found in Supabase, using in-memory fallback`);
    const row = memInsert(table, data);
    return { data: [row], error: null };
  }
  return result;
}

async function dbUpdate(table, data, filters) {
  if (!useSupabase) {
    const rows = memUpdate(table, data, filters);
    return { data: rows, error: null };
  }
  let query = supabase.from(table).update(data);
  for (const [key, value] of Object.entries(filters)) { query = query.eq(key, value); }
  const result = await query;
  if (result.error && result.error.message && (result.error.message.includes('does not exist') || result.error.message.includes('not found') || result.error.message.includes('Could not find'))) {
    console.log(`Table "${table}" not found in Supabase, using in-memory fallback`);
    const rows = memUpdate(table, data, filters);
    return { data: rows, error: null };
  }
  return result;
}

async function dbUpsert(table, data) {
  if (!useSupabase) { return dbInsert(table, data); }
  return supabase.from(table).upsert(data).select();
}

async function dbDelete(table, filters) {
  if (!useSupabase) {
    mem[table] = (mem[table] || []).filter(row => !memFilter([row], filters).length);
    return { data: null, error: null };
  }
  let query = supabase.from(table).delete();
  for (const [key, value] of Object.entries(filters)) { query = query.eq(key, value); }
  return query;
}

module.exports = { initDatabase, saveDatabase, dbQuery, dbInsert, dbUpdate, dbUpsert, dbDelete, supabase: () => supabase, isSupabase: () => useSupabase };
