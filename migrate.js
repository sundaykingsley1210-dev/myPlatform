const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function runSql(sql) {
  const url = new URL('/sql', SUPABASE_URL);
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY
    }}, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(JSON.stringify({ query: sql }));
    req.end();
  });
}

async function migrate() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('No Supabase credentials');
    return;
  }
  console.log('Connected to Supabase, running migration...');

  const migrations = [
    "CREATE OR REPLACE FUNCTION exec_sql(query TEXT) RETURNS TEXT AS $$ BEGIN EXECUTE query; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$ LANGUAGE plpgsql SECURITY DEFINER;",

    "ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS total_earned NUMERIC DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';",

    "CREATE TABLE IF NOT EXISTS reset_requests (id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT DEFAULT '', email TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW());",
  ];

  for (const sql of migrations) {
    try {
      const result = await runSql(sql);
      console.log(`OK: ${sql.substring(0, 60)}...`);
    } catch (e) {
      console.log(`SKIP: ${sql.substring(0, 60)}... - ${e.message}`);
    }
  }
  console.log('Migration complete');
}

module.exports = { migrate };
if (require.main === module) migrate();
