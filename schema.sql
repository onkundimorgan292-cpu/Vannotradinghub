-- 1. Client Wallets (1 row per registered client)
create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  available_usd numeric(14,2) not null default 0,
  bot_capital_usd numeric(14,2) not null default 0,
  net_profit_usd numeric(14,2) not null default 0,
  trades_count integer not null default 0,
  bot_active boolean not null default true,
  risk_mode text not null default 'Balanced',
  updated_at timestamptz not null default now()
);

-- 2. Deposits & Withdrawals (Till 1957147 STK & Ledger)
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tx_type text not null check (tx_type in ('DEPOSIT', 'WITHDRAWAL')),
  method text not null,
  reference text not null unique,
  amount_usd numeric(14,2) not null,
  status text not null default 'PENDING',
  created_at timestamptz not null default now()
);

-- 3. Executed AI Bot Trades
create table if not exists public.bot_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pair text not null,
  side text not null check (side in ('BUY', 'SELL')),
  entry_price numeric(18,6) not null,
  pnl_usd numeric(14,2) not null,
  risk_mode text not null,
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.wallets enable row level security;
alter table public.transactions enable row level security;
alter table public.bot_trades enable row level security;

create policy "Users view own wallet" on public.wallets for select using (auth.uid() = user_id);
create policy "Users update own wallet" on public.wallets for update using (auth.uid() = user_id);
create policy "Users insert own wallet" on public.wallets for insert with check (auth.uid() = user_id);

create policy "Users view own tx" on public.transactions for select using (auth.uid() = user_id);
create policy "Users insert own tx" on public.transactions for insert with check (auth.uid() = user_id);

create policy "Users view own trades" on public.bot_trades for select using (auth.uid() = user_id);
create policy "Users insert own trades" on public.bot_trades for insert with check (auth.uid() = user_id);
