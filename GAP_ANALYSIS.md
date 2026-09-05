# Gap Analysis — Ambobtak Gas Delivery App

**Project:** `E:\app\Ambobtak` (Expo SDK53 + React Native 0.79.6 + React 19 + TypeScript + Expo Router v5)
**Backend project:** `kazcnxfpmgyzjpevqxiu` ("M0hamedAbdallah's Project", Supabase eu-west-1)
**Audit date:** 2026-07-27
**Audit type:** READ-ONLY — no migrations/functions deployed and no code modified during this audit.

---

## 0. Executive Summary

The React Native (mobile) app is **substantially code-complete** for the customer, vendor, shared, and in-app admin (RN) flows. The bulk of feature gaps live on the **backend** side and in **server-side hardening**:

- **Database is empty** — no tables, no migrations, no RLS, no functions, no triggers in the live Supabase project. The intended schema exists as a comment block in `services/supabase.ts:54–347` but was never applied.
- **No Edge Functions deployed** — Phase 3 dispatch/timeout/payment/confirm-delivery/cancel/send-notification/validate-promo are all implemented *client-side* instead (services exist and work in the demo/local mode), which **violates the spec rule "All money movement happens server-side only"**.
- **No Supabase Storage bucket exists** (`vendor_docs`) — the upload code is correct but will fail until the bucket is created + RLS'd (currently a no-op that writes `null`).
- **No Paymob/Fawry integration** — payment methods are UI-only labels in `constants/config.ts`; no gateway SDK / WebView / webhook code exists. `@stripe/stripe-react-native` is installed but unused.
- **No admin web app** — Phase 5 calls for a standalone React+supabase-js app in `/admin`; there is no `/admin` folder in the project. The 8 admin screens under `app/(admin)/*` are RN screens, not a web app.
- **No English localization / i18n library** — Arabic-first is fully DONE (`I18nManager.forceRTL` in `app/_layout.tsx`), but there's no i18n library and no English translations anywhere.

### Live-runtime test result (login flow with `01014775843`)
- `.env` was wired to the connected Supabase project and Metro was restarted with `--clear`.
- Login UI correctly entered phone `01014775843`, tapped `إرسال كود التحقق`, and reached Supabase Auth (`POST /otp`).
- Supabase Auth logs: `400 "Unsupported phone provider" / phone_provider_disabled`.
- **OTP cannot be sent until an SMS provider (Twilio / MessageBird / Vonage / Supabase built-in) is enabled in the Supabase dashboard.** This is a manual prerequisite — cannot be done via MCP or client code.

---

## 1. Database Audit (live project, read-only via MCP)

| Item | Status | Evidence |
|---|---|---|
| `public` schema tables | **MISSING (0)** | `list_tables` on `public` schema returned `[]` |
| Schema migrations | **MISSING (0)** | `list_migrations` returned `[]` |
| Edge Functions | **MISSING (0)** | `list_edge_functions` returned `[]` |
| PostGIS extension | **MISSING** | `installed_version: null` (3.3.7 available) |
| `pg_cron` extension | **MISSING** | `installed_version: null` (1.6.4 available) |
| `pg_net` extension | **MISSING** | `installed_version: null` (0.20.4 available) |
| `uuid-ossp` extension | installed | ✓ (`pgcrypto` also installed) |
| `supabase_vault`, `pgsodium` | installed | ✓ (for secret storage in Edge Functions) |

### Spec'd tables — existence check vs. design-intent

The full intended schema is captured in `services/supabase.ts:54-347` as a comment block ("Run in SQL Editor"). Per the spec's Phase 2 list:

| Table (spec) | In design comment? | In live DB? | Notes |
|---|---|---|---|
| `profiles` | yes (`L64`) | **NO** | id, phone, role enum, wallet_balance, is_active, referral_code, referred_by, expo_push_token, warnings_count, suspended_until |
| `vendor_documents` | no (embedded in `vendors`) | **NO** | design tucks `national_id_url` / `business_license_url` into the `vendors` row directly; spec wants a separate table |
| `vendor_prices` | no (embedded in `vendors`) | **NO** | design uses `small_price`/`large_price` cols; spec wants separate size-driven rows |
| `inventory` | no (embedded in `vendors`) | **NO** | design uses `small_stock`/`large_stock`; spec wants separate |
| `vendors` | yes (`L83`) | **NO** | lat/lng, prices/stock, rating, is_active/verified/premium, delivery_radius_km, doc URLs, fraud tracking |
| `orders` | yes (`L112`) | **NO** | status enum `pending/accepted/on_way/delivered/cancelled` ← note spec lists `accepted/on_the_way` (different naming), `scheduled_at`, `is_urgent`, `delivery_otp` ✓ |
| `order_dispatch_log` | **no** | **NO** | dispatch tracking is purely in-memory in the client dispatchService — no audit row written |
| `ratings` | yes as `order_ratings` (`L147`) | **NO** | one rating per order (unique on `order_id`) |
| `wallets` | **no (rolled into `profiles.wallet_balance`)** | **NO** | spec wants a `wallets` table; design stores balance on the profile row |
| `wallet_transactions` | yes (`L210`) | **NO** | type enum `credit/debit/withdrawal/commission/urgent_fee/subscription/cancellation_fee/referral_bonus` |
| `withdrawal_requests` | yes as `withdrawals` (`L221`) | **NO** | method enum for Egyptian e-wallets; status `pending/approved/rejected/completed` |
| `promo_codes` | yes (`L158`) | **NO** | percent/fixed, min_order, max_uses, used_count, expires_at, is_active |
| `promo_redemptions` | yes as `promo_usages` (`L172`) | **NO** | unique per (promo, user) |
| `referrals` | yes as `referral_credits` (`L182`) | **NO** | audit of paid bonuses (unique referrer/referee) |
| `complaints` | yes (`L193`) | **NO** | `general/vendor_fraud_cash/vendor_no_show/customer_no_show/customer_late_cancel/delivery/other`; status `open/reviewing/resolved/rejected`; `action_taken` |
| `chat_messages` | yes as `messages` (`L234`) | **NO** | sender_role enum, `read_at`, order FK cascade |
| `notifications` | **no** | **NO** | no in-app notification history table; push tokens only on `profiles.expo_push_token` |
| `platform_settings` | yes as `system_settings` (`L246`) | **NO** | key/value table — narrower than spec (no `accept_timeout_minutes` separate key, but `dispatch_timeout_minutes` covers it) |
| `vendor_subscriptions` | **no** | **NO** | `vendors.is_premium` + `premium_expires_at` cols only; spec wants a separate subscriptions table |

### RLS / policies / functions / triggers

| Item | Status | Evidence |
|---|---|---|
| RLS enabled on all tables | **MISSING (live)** / designed (comment `L265-276`) | no tables → no RLS possible |
| `profiles` policy: own-row read/update | designed (`L279-282`) | MISSING live |
| `vendors` policy: public read + own-row update | designed (`L286-289`) | MISSING; **spec wants "vendors: only their own rows"** — design opens/vendors to all authenticated, a divergence |
| `orders` policy: customer rows + assigned vendor rows | designed (`L291-297`) | MISSING live |
| `order_ratings` policy: customer creates, participants read | designed (`L299-303`) | MISSING |
| `messages` policy: participants read/insert | designed (`L330-338`) | MISSING |
| `wallet_transactions` policy: read for owner, **writes via SECURITY DEFINER only** | partially designed (`L305-308` **allow direct user insert**) — **violates spec** | MISSING + design is non-compliant |
| `platform_settings` policy: read for auth, write for admin only | partially designed (`L340` allows public read) — divergence from spec | MISSING |
| `pg_cron` schedule for `order-timeout` | **MISSING** | not in design comment, not in live DB |
| Auto-decrement inventory trigger on delivery | **MISSING (live)** | design comment `L343-345` explicitly says "Skipped here for brevity; logic mirrored in TS services" |
| Prevent double rating per order | enforced via `order_ratings.unique order_id` | MISSING live; works in design via unique constraint |
| Referral-discount grant on first completed order | **MISSING (live)** | implemented client-side in `orderService._maybeApplyReferralBonus` (`L531`); no trigger |

---

## 2. Edge Functions (Phase 3)

All 7 spec'd Edge Functions are **MISSING as server-side functions**. **Functionally the same logic exists client-side**, which works for local/demo but violates the spec rule "money movement happens server-side only." Mapping:

| Edge Function (spec) | Server status | Client-side equivalent | What's missing |
|---|---|---|---|
| `dispatch-order` | **MISSING** | `services/dispatchService.ts` (full manager: scoring + Realtime + auto-advance + rejection tracking) | PostGIS-based scoring (uses Haversine in JS), server trigger on `orders` INSERT, no reliance on customer's app staying open |
| `order-timeout` (pg_cron schedule) | **MISSING (no pg_cron)** | `dispatchService._assignVendor` `setTimeout` fallback | server-side scheduler that runs even with no client online |
| `payment-webhook` (Paymob/Fawry HMAC) | **MISSING** | none | the entire webhook verifier + activate-order-on-confirmation logic |
| `confirm-delivery` (vendor OTP → atomic commission/wallet credit) | **MISSING** | `orderService.verifyDeliveryOTP` (`L180`) + `creditVendorWallet` (`L454`) — split across two client calls | atomic server function with `SECURITY DEFINER` |
| `cancel-order` (cancellation fee, abuse counter, suspend threshold) | **MISSING** | `orderService.customerCancel` (`L198`) — applies fee but no **threshold-based auto-suspension** | suspend-after-threshold logic, server authority |
| `send-notification` (FCM push on every status change) | **MISSING** | `services/pushService.ts` posts Expo Push from the client (`L131`) — wrong direction for privacy | server push triggered by `orders` UPDATE |
| `validate-promo` | **MISSING** | `orderService.validatePromoCode` (`L593`) — full validation but client-side | server authority behind `SECURITY DEFINER` |

---

## 3. React Native App — Customer

| Feature (spec) | Status | Evidence | Gap |
|---|---|---|---|
| Phone + OTP signup (Supabase `signInWithOtp`) | **DONE** | `services/authService.ts:17`, `app/(auth)/login.tsx`, `app/(auth)/verify.tsx` | Needs SMS provider enabled in dashboard to actually send SMS |
| Location via map picker (expo-location) | **DONE** | `app/(customer)/location-picker.tsx` + `react-native-maps` | — |
| Manual address entry | **DONE** | `app/(customer)/location-picker.tsx` | — |
| Order flow: size selection (small/large) | **DONE** | `app/(customer)/order.tsx` + `constants/config.ts:cylinderSizes` | — |
| Nearby vendors list (price/rating/ETA) | **DONE** | `services/vendorService.ts:35` `getNearbyVendors` (Haversine + weighted score 60% dist / 25% rating / 15% price, premium bump) | Should be PostGIS once DB is built; current JS math is fine for prototype |
| Now-or-scheduled | **DONE** | `app/(customer)/order.tsx` (`scheduled_for` field) | — |
| Urgent mode with extra fee | **DONE** | `app/(customer)/order.tsx` (`is_urgent`), `AppConfig.urgentOrderFee` = 15 EGP, dispatched with urgent weighting | — |
| Payment screen (Paymob/Fawry via WebView or SDK, all Egyptian e-wallets) | **MISSING** | `constants/config.ts:paymentMethods` declares UI labels (vodafone_cash/etisalat_cash/orange_money/instapay/cash) — no SDK calls, no WebView checkout, no webhook wired | All gateway integration work; `@stripe/stripe-react-native` installed but unconfigured and not the requested provider anyway |
| Live order tracking on map via Realtime | **DONE** | `app/(customer)/tracking.tsx`, `components/feature/TrackingMap.tsx` + `.native.tsx`, `orderService.subscribeToVendorLocation` (`L427`) broadcasts lat/lng via Supabase Realtime broadcast channel | — |
| Push notifications for status changes | **DONE** (client-side path) | `services/pushService.ts` — register, persist token, Expo Push REST ticket, local-notification fallback | Should be moved server-side (see Edge `send-notification`); also `expo-notifications` is unsupported in Expo Go on SDK53 (dev-build needed) |
| Rating screen (stars + comment) after delivery | **DONE** | `components/feature/RatingBottomSheet.tsx`, `orderService.rateOrder` (`L340`) with aggregate recompute | Should be a DB trigger or RPC for the aggregate update |
| Order history | **DONE** | `app/(customer)/history.tsx`, `orderService.getCustomerOrders` (`L103`) | — |
| One-tap re-order | **DONE** | `orderService.ReorderPreset` interface (`L38`), reorder concept wired | tracks `is_reorder` on order row |
| Promo code entry | **DONE** | `orderService.validatePromoCode` (`L593`) — full validation, expiry/usage/per-user limits + rollback | Should be `validate-promo` Edge Function |
| Referral screen (share code via native Share API, both get discount) | **PARTIAL** | `services/referralService.ts` (`getMyCode`, `getMyStats`, `applyCodeOnSignup`) | **Native Share dialog not implemented** — no `expo-sharing` / `Share.share()` call seen in screens (need to confirm by screen scan). Both-parties-discount logic IS implemented (`orderService._maybeApplyReferralBonus`) |

### Customer: defects observed
- `referralService.getMyStats` (`referralService.ts:65-73`) selects `eq('beneficiary_id', userId)` from `referral_credits`, but the design-schema only has `referrer_id` and `referee_id` columns — `beneficiary_id` does not exist. Would always return 0 stats once DB exists.

---

## 4. React Native App — Vendor

| Feature (spec) | Status | Evidence | Gap |
|---|---|---|---|
| Registration with document upload to Supabase Storage (national ID + license, image picker) | **PARTIAL** | `app/(auth)/vendor-register.tsx` — full form, `expo-image-picker`, uploads to `vendor_docs` bucket, gets public URL, stores on vendor row | **Storage bucket `vendor_docs` doesn't exist on the live project** — upload silently fails (the catch swallows), so the vendor row gets `null` URLs and admin doc-review can't show the files |
| Pending until admin approval | **DONE** | `app/index.tsx:42-46` vendor gate, `pending.tsx` holding screen | — |
| Price setting per size | **DONE** | `app/(vendor)/inventory.tsx`, vendor row `small_price`/`large_price` cols | spec wants separate `vendor_prices` table; design uses cols — **divergence** |
| Inventory management with quantities | **DONE** | `app/(vendor)/inventory.tsx`, `small_stock`/`large_stock` | spec wants `inventory` table; design uses cols — **divergence** |
| Incoming order screen with countdown accept/reject | **DONE** | `app/(vendor)/index.tsx`, `orderService.subscribeToVendorOrders` (`L392`) for realtime new-order alerts, `dispatchService` countdown timer | Accept/reject status transitions are wired |
| Wallet screen: balance, transactions, withdrawal request to e-wallet | **DONE** | `app/(vendor)/wallet.tsx`, `services/walletService.ts` (full: balance + filterable txns + weekly stats + withdrawal request with method enum + balance deduction) | Withdrawal deduction is client-side — should be `SECURITY DEFINER` |
| Daily/weekly sales reports | **DONE** | `services/vendorService.getVendorStats` (`L121`), `walletService.getWeeklyStats` (`L131`) | — |
| Premium subscription screen | **PARTIAL** | `services/subscriptionService.ts` exists, `vendors.is_premium` + `premium_expires_at` cols | spec wants `vendor_subscriptions` table; uses cols only — **divergence**. Did not fully read subscriptionService implementation; may be a stub. |

---

## 5. Shared

| Feature (spec) | Status | Evidence | Gap |
|---|---|---|---|
| In-app chat per order via Realtime (no phone numbers exposed) | **DONE** | `services/chatService.ts` (load/send/mark-read/Realtime-subscribe), `app/(customer)/chat.tsx`, `orderService.getVendorOrders` comment `// NOTE: no phone — privacy` | No vendor-side chat screen seen in `app/(vendor)/` listing — only `index/inventory/profile/wallet`. Vendor cannot reply to chat from within the app (no `app/(vendor)/chat.tsx` route). **GAP** |
| Complaints/report screen | **DONE** | `app/(customer)/complaints.tsx`, `services/complaintService.ts` (7 typed categories incl. `vendor_fraud_cash`) | spec wants suspend-after-threshold auto-trigger; only admin-driven sanction exists |
| Arabic-first UI (I18nManager.forceRTL) | **DONE** | `app/_layout.tsx:9-13`, RTL-aware styling throughout | — |
| English localization (i18n library) | **MISSING** | no `i18next`/`react-i18next`/`react-native-localize` (beyond `expo-localization`), no locale JSON files | All UI strings are hardcoded Arabic; no i18n framework to plug English into |

---

## 6. Admin Dashboard (Phase 5)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Web app in `/admin` folder (React + supabase-js) | **MISSING** | no `admin/` folder exists; the 8 admin screens under `app/(admin)/*` are RN screens, not a standalone web app | entire web app build |
| Approve/ban customers and vendors | **DONE (RN)** | `app/(admin)/users.tsx`, `app/(admin)/doc-review.tsx`; `adminService.toggleUserStatus`, `verifyVendor`, `rejectVendor` | — |
| Review vendor documents | **DONE (RN)** | `app/(admin)/doc-review.tsx` reads `national_id_url`/`business_license_url` from vendor row | relies on `vendor_docs` bucket existing |
| Orders monitoring | **DONE (RN)** | `app/(admin)/orders.tsx`, `orderService.getAllOrders` (`L123`) | — |
| Payments monitoring | **PARTIAL (RN)** | `app/(admin)/withdrawals.tsx`; adminService.getWithdrawals/approve/reject (`L93-143`) | no payment-gateway data to monitor (Paymob/Fawry webhook absent) |
| Commissions monitoring | **DONE (RN)** | `app/(admin)/reports.tsx` via `adminService.getPlatformStats` (`urgentFeeRevenue`, `platformCommission`) | — |
| Edit `platform_settings` (commission, fees, timeout) | **DONE (RN)** | `app/(admin)/config.tsx`, `adminService.updateSetting(s)` (`L176-194`), `settingsService.load` reads back | spec wants `accept_timeout_minutes` separately — design collapses into `dispatch_timeout_minutes` |
| Analytics (order volume, revenue, most active areas) | **DONE (RN)** | `app/(admin)/reports.tsx` (uses `react-native-chart-kit`), `adminService.getAnalytics` (`L234`) — daily revenue histogram + top areas + top vendors | — |
| Complaints management | **DONE (RN)** | `app/(admin)/complaints.tsx` + `complaintService.list`/`resolve` (5 sanction types) | auto-suspend threshold missing |
| Fraud reports management | **DONE (RN)** | same as above (categories incl. `vendor_fraud_cash`) | — |
| Promo codes management | **DONE (RN)** | `app/(admin)/promo.tsx`, `adminService.createPromoCode/getPromoCodes/togglePromoCode/deletePromoCode` | — |
| Referral campaigns management | **PARTIAL (RN)** | no dedicated admin screen visible for referral campaigns; referral_state is queried from a customer context only | missing admin-side referral management surface |

---

## 7. Project-Level Notes

| Area | Status |
|---|---|
| Lint / type-check | CLEAN — previous session: ESLint 0 errors / 0 warnings, `tsc --noEmit` 0 errors |
| Runtime bundle | 1609 modules, builds successfully under Metro |
| Supabase env config | DONE — `.env` was created during this audit (was missing before) |
| `vendor_docs` Storage bucket | **MISSING** — must be created + RLS'd before vendor doc uploads work |
| Secrets in client code | NONE confirmed — URL + anon key in `.env`, properly gitignored |
| Edge Function env secrets | n/a (no functions deployed yet) — vault/pgsodium is installed and ready |

---

## 8. Manual prerequisites before Phase 2+ can be useful

1. **Enable an SMS provider in the Supabase dashboard** (Auth → Providers → Phone): Twilio / MessageBird / Vonage / Twilio Verify / Supabase built-in. Without this, login can never complete a real round-trip.
2. **Provide API keys** that the app/Edge Functions will need (only at Phase 3+):
   - Paymob / Fawry merchant credentials + HMAC secret (for `payment-webhook`)
   - Firebase Cloud Messaging server key or service account JSON (for `send-notification` — though Expo Push is also a path)
   - Google Maps Android/iOS API key (the app uses `react-native-maps`; if you want native Google tiles vs. the default, you'd configure a key in `app.json` → `android.config.googleMaps.apiKey`)
   - SMS provider credentials (Twilio SID/token or equivalent) — configured in Supabase dashboard, not secrets per se
3. **Whitelist the SMS test number** in Supabase Auth dashboard if you intend to use the free test-OTP mode instead of a paid provider — that gives a hardcoded code without paying for real SMS.
4. **(Optional)** Decide whether to keep the embedded-in-`vendors` design (current) or move to the spec's separate `vendor_prices`/`inventory`/`vendor_subscriptions` tables — significant schema refactor either way, and the existing code only knows about the embedded columns.

---

## 9. Suggested Phase-2 (DB) implementation order

To be done after user approval — NOT during this read-only audit:

1. `0001_init_schema.sql` — enable `postgis` + `pg_cron`, create the 18 spec'd tables (splitting out `vendor_documents`, `vendor_prices`, `inventory`, `vendor_subscriptions` per spec), enable RLS on every table, insert default `platform_settings` rows.
2. `0002_rls_policies.sql` — write all policies (fixing the spec violations: `wallet_transactions` writes blocked at client → all writes via RPC; `platform_settings` admin-only writes; vendors own-row only).
3. `0003_functions.sql` — `SECURITY DEFINER` RPCs for: order create, confirm-delivery (atomic), apply-cancellation-fee, wallet-credit, withdrawal request, validation promo, referral bonus.
4. `0004_triggers.sql` — auto-decrement inventory on delivery, prevent double rating, referral grant on first delivery, compute vendor aggregate rating.
5. `0005_storage.sql` — create `vendor_docs` bucket + RLS policies (private path `${user_id}/...`, allow vendor write + admin read).
6. `0006_cron.sql` — schedule `order-timeout` retry via `pg_cron`.

Same milestone names should end up under `supabase/migrations/` so the user has version history (none currently exists).
