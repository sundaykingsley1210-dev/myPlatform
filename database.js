const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
let useSupabase = false;

function initDatabase() {
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    useSupabase = true;
    console.log('Connected to Supabase cloud database');
  } else {
    console.log('WARNING: No Supabase credentials. Using in-memory database.');
  }
  return Promise.resolve();
}

function saveDatabase() {}

async function dbQuery(table, columns = '*', filters = {}, options = {}) {
  if (!useSupabase) return { data: null, error: { message: 'No database connected' } };

  let query = supabase.from(table).select(columns);

  for (const [key, value] of Object.entries(filters)) {
    if (value === null) {
      query = query.is(key, null);
    } else if (typeof value === 'object' && value.op) {
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
    } else {
      query = query.eq(key, value);
    }
  }

  if (options.order) {
    query = query.order(options.order.column, { ascending: options.order.ascending ?? false });
  }
  if (options.limit) query = query.limit(options.limit);
  if (options.single) query = query.single();

  return query;
}

async function dbInsert(table, data) {
  if (!useSupabase) return { data: null, error: { message: 'No database connected' } };
  return supabase.from(table).insert(data).select();
}

async function dbUpdate(table, data, filters) {
  if (!useSupabase) return { data: null, error: { message: 'No database connected' } };
  let query = supabase.from(table).update(data);
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value);
  }
  return query;
}

async function dbUpsert(table, data) {
  if (!useSupabase) return { data: null, error: { message: 'No database connected' } };
  return supabase.from(table).upsert(data).select();
}

async function dbDelete(table, filters) {
  if (!useSupabase) return { data: null, error: { message: 'No database connected' } };
  let query = supabase.from(table).delete();
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value);
  }
  return query;
}

module.exports = { initDatabase, saveDatabase, dbQuery, dbInsert, dbUpdate, dbUpsert, dbDelete, supabase: () => supabase, isSupabase: () => useSupabase };
