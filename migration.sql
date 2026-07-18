-- Run this in Supabase SQL Editor to add vip_level to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0;
