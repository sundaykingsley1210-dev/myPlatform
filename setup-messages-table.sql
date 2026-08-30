-- Run this SQL in your Supabase SQL Editor:
-- Go to https://supabase.com/dashboard → SQL Editor → New Query → Paste → Run

-- 1. Create exec_sql helper function (needed for future migrations)
CREATE OR REPLACE FUNCTION exec_sql(query TEXT)
RETURNS TEXT AS $$
BEGIN
  EXECUTE query;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Drop old messages table if it exists with wrong column types
DROP TABLE IF EXISTS messages;

-- 3. Create messages table (user_id TEXT because user IDs are UUIDs)
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT 'user',
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Enable Row Level Security
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 5. Create policy for service role access
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON messages
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 6. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
