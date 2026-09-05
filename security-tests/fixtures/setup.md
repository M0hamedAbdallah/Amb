# Fixture accounts — setup & teardown

The suites authenticate as seven fixture users on the **live** project
(`kazcnxfpmgyzjpevqxiu`). All emails use the undeliverable domain
`sectest.dev`, all phones are the reserved `+2010 0990 00xx` range, and
every account shares the password in `security-tests/.env.local`
(`FIXTURE_PASSWORD`, default `SecTest!2026#Amb` — public-by-design, it guards
nothing but fixtures).

| Fixture | Email | Role | Notes |
|---|---|---|---|
| cust1 | `sec+cust1@sectest.dev` | customer | wallet_balance 100 — absorbs the 1-EGP withdrawal idempotency probe |
| cust2 | `sec+cust2@sectest.dev` | customer | cross-user (BOLA) counterpart |
| vendor | `sec+vendor@sectest.dev` | vendor | owns the `SecTest Vendor` row (active + verified, stock 100/100) |
| support | `sec+support@sectest.dev` | support | support-console role (0027) |
| admin | `sec+admin2@sectest.dev` | admin | admin-api authorized caller |
| locked | `sec+locked@sectest.dev` | customer | absorbs wrong-password hammering in suite 08 |
| off | `sec+off@sectest.dev` | customer | `is_active = false` — admin-api must 401 it |

## Setup (idempotent — safe to re-run)

Run via Supabase MCP `execute_sql` (or SQL Editor). Uses pgcrypto's
`crypt`/`gen_salt` so the bcrypt hash is computed server-side; the password
never travels as a hash we generated offline.

```sql
-- 1. auth.users (NOT EXISTS guards → re-runnable; no ON CONFLICT target —
--    this project's auth.users has no matching unique constraint exposed).
--    IMPORTANT: GoTrue scans the token columns into plain strings — they
--    must be '' (empty), NOT NULL, or every password login for the fixture
--    500s with "Database error querying schema" (verified the hard way).
insert into auth.users (instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at, invited_at,
  confirmation_token, confirmation_sent_at, recovery_token,
  recovery_sent_at, email_change_token_new, email_change, email_change_sent_at,
  last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', e.email,
  crypt('SecTest!2026#Amb', gen_salt('bf')), now(), null,
  '', null, '', null, null, '', null,
  null, '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('sec+cust1@sectest.dev'), ('sec+cust2@sectest.dev'),
  ('sec+vendor@sectest.dev'), ('sec+support@sectest.dev'),
  ('sec+admin2@sectest.dev'), ('sec+locked@sectest.dev'),
  ('sec+off@sectest.dev')
) as e(email)
where not exists (select 1 from auth.users u where u.email = e.email);

-- also set confirmed_at (nullable, but GoTrue checks it):
update auth.users set confirmed_at = coalesce(confirmed_at, now())
where email like 'sec+%@sectest.dev';

-- 2. auth.identities
insert into auth.identities (id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at)
select u.id, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email,
  'email_verified', true), 'email', u.id::text, null, now(), now()
from auth.users u
where u.email like 'sec+%@sectest.dev'
  and not exists (select 1 from auth.identities i where i.user_id = u.id);

-- 3. profiles (roles + phones match lib/env.mjs)
insert into profiles (id, phone, name, role, wallet_balance, is_active)
select u.id, v.phone, 'SecTest ' || v.tag, v.role, v.wallet, v.active
from (values
  ('sec+cust1@sectest.dev',  '+201009900001', 'cust1',   'customer', 100.00, true),
  ('sec+cust2@sectest.dev',  '+201009900002', 'cust2',   'customer',   0.00, true),
  ('sec+vendor@sectest.dev', '+201009900003', 'vendor',  'vendor',    250.00, true),
  ('sec+support@sectest.dev','+201009900004', 'support', 'support',     0.00, true),
  ('sec+admin2@sectest.dev', '+201009900005', 'admin',   'admin',       0.00, true),
  ('sec+locked@sectest.dev', '+201009900006', 'locked',  'customer',    0.00, true),
  ('sec+off@sectest.dev',    '+201009900007', 'off',     'customer',    0.00, false)
) as v(email, phone, tag, role, wallet, active)
join auth.users u on u.email = v.email
where not exists (select 1 from profiles p where p.id = u.id);

-- 4. vendors row for the vendor fixture
insert into vendors (user_id, business_name, address, lat, lng,
  small_price, large_price, small_stock, large_stock,
  is_active, is_verified, delivery_radius_km, avg_delivery_mins)
select p.id, 'SecTest Vendor (auto-probe)', 'Cairo', 30.0500, 31.2400,
  30.00, 65.00, 100, 100, true, true, 10, 30
from profiles p join auth.users u on u.id = p.id
where u.email = 'sec+vendor@sectest.dev'
  and not exists (select 1 from vendors v where v.user_id = p.id);
```

## Teardown (removes every trace, cascades to profiles/vendors/orders)

```sql
delete from auth.users where email like 'sec+%@sectest.dev';
-- dependent rows (profiles, vendors) cascade via FK on delete cascade.
-- orders created by fixtures are removed by the orders→profiles FK.
```

Leftovers the suites cannot delete themselves (client writes revoked by
design): pending `withdrawals` rows and their `wallet_transactions` ledger
from the 1-EGP idempotency probe. To reset cust1/vendor wallets between runs:

```sql
delete from withdrawals  where user_id in (select id from auth.users where email like 'sec+%@sectest.dev');
update profiles p set wallet_balance = case u.email
  when 'sec+cust1@sectest.dev'  then 100.00
  when 'sec+vendor@sectest.dev' then 250.00
  else wallet_balance end
from auth.users u where u.id = p.id and u.email like 'sec+%@sectest.dev';
```
