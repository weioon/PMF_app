# MyPFM — Personal Financial Management System (EN / 简体中文)

**MyPFM** is an offline-first, privacy-focused Malaysian Personal Financial Management application featuring strict integer-cent double-entry accounting, a modern consumer-friendly mobile UI, real-time Guardrail alerts, SPayLater / BNPL amortization, ASNB & Digital Bank yield tracking, and native Android push notification auto-tracking.

Every financial record stays **100% on your device** (IndexedDB + `localStorage`) with zero mandatory cloud dependency, and instant runtime switching between **English (`en`)** and **Simplified Mandarin (`zh-CN`)**.

---

## Table of Contents

1. [System Architecture & Repository Structure](#system-architecture--repository-structure)
2. [Functional Specification](#functional-specification)
3. [Running Automated QA Tests](#running-automated-qa-tests)
4. [Mobile Deployment Guide (Android APK & PWA)](#mobile-deployment-guide-android-apk--pwa)
   - [Option A: Build & Deploy Android APK via USB (ADB)](#option-a-build--deploy-android-apk-via-usb-adb--recommended)
   - [Enabling Auto-Tracking on Sideloaded Android APKs (Android 13+)](#enabling-auto-tracking-on-sideloaded-android-apks-android-13)
   - [Option B: Mobile Browser / Offline PWA via Local Server](#option-b-mobile-browser--offline-pwa-via-local-server)

---

## System Architecture & Repository Structure

```text
PMF_app/
├── README.md
└── PFM project/
    ├── AGENTS.md                           # Domain invariants & project specification
    ├── Pfm.sln                             # .NET 8/9 Clean Architecture solution (optional API backend)
    ├── start_mobile_server.ps1             # Local HTTP static server for LAN mobile browser / PWA testing
    ├── src/
    │   ├── Pfm.Domain / Application / Infrastructure / Api/
    │   └── pfm-client/                     # Standalone PWA + Capacitor Android Application (v2.1.0)
    │       ├── package.json
    │       ├── capacitor.config.ts         # Standalone Capacitor config (appId: com.mypfm.app, https://localhost)
    │       ├── MyPFM-standalone.apk        # Latest compiled standalone Android APK
    │       ├── scripts/
    │       │   └── build-standalone.js     # Offline bundle builder + Capacitor sync + Gradle APK + ADB -r deploy
    │       ├── tests/
    │       │   └── qa-7point-audit.spec.js # 22-test 7-Point Financial & QA Audit Suite
    │       ├── src/
    │       │   ├── index.html              # Mobile-first consumer UI, modals, bottom dock, inline I18N
    │       │   ├── pfm-engine.js           # Integer-cent double-entry ledger, yield, installments & parser engine
    │       │   ├── pfm-catalog.js          # Malaysian Financial Institutions Smart Catalog
    │       │   ├── local-db.js             # Local persistence layer (IndexedDB / localStorage)
    │       │   ├── sw.js & manifest.json   # Offline Service Worker & PWA manifest
    │       │   └── assets/i18n/            # Full en.json & zh-CN.json translation dictionaries
    │       └── android/                    # Native Capacitor Android Project
    │           └── app/src/main/
    │               ├── AndroidManifest.xml
    │               └── java/com/mypfm/app/
    │                   ├── MainActivity.java                   # AndroidNotificationBridge JS interface
    │                   └── PfmNotificationListenerService.java # Background push notification queue
    └── tests/Pfm.UnitTests/                # .NET Domain unit tests
```

---

## Functional Specification

### 1. Consumer Home Dashboard & Hero Balance
- **Hero Wealth Card**: Displays **Safe-to-Spend (`UnrestrictedSpendableBalance`)** front-and-center—automatically subtracting operational floors (`MinBalanceLimit`) and locked Goal Savings (`VirtualEnvelopes`) from your liquid cash—alongside total liquid cash, savings envelopes, and Net Worth.
- **1-Tap Quick Actions**: Direct buttons under the Hero Card to open **Spend**, **Income**, **Transfer**, or **Add Account**.
- **Upcoming Bills Banner**: Alerts you right on the Home screen whenever active recurring expense bills remain unposted for the current month.
- **Privacy Mask (`👁️` / `🙈`)**: Instant one-tap masking/unmasking of all monetary balances across the UI.
- **KPI Summary & Visual Analytics**: Tracks Net Worth, Safe-to-Spend, Goal Savings, Monthly Expenses + Installment Slice, and Income-vs-Expense Runway charts.

### 2. Dynamic 4-Pillar Account Management & Malaysian Smart Catalog
Users have full freedom to create, edit, or delete unlimited accounts under 4 immutable financial pillars—starting completely clean with zero forced dummy data (and automatically purging legacy v2.0 demo seed accounts if present):

| Pillar | Purpose | Examples |
|---|---|---|
| `ASSET_LIQUID` | Everyday spending, digital banks & wallets | Maybank, CIMB, GXBank, Ryt Bank, Touch 'n Go eWallet, TnG NFC Card, Cash |
| `ASSET_INVESTMENT` | Yield-bearing & long-term wealth | ASNB Fixed-Price, ASNB Variable, Fixed Deposit, ETFs, EPF |
| `LIABILITY` | Debts, BNPL & revolving credit | Shopee SPayLater, Credit Cards, Car Loan, Mortgage |
| `INCOME_SOURCE` | Recurring inflows & salary tracking | Monthly Salary (with EPF), Freelance, Dividend Payouts |

- **Smart Catalog (`pfm-catalog.js`)**: Pre-configured Malaysian institutions with editable APY rates, default operational floors (e.g., RM 10.00 for TnG NFC Card), and known Android package mappings.

### 3. Strict Double-Entry Ledger, Numpad Quick Entry & Pre-Submission Confirmation
- **Atomic Transactions (`pfm-engine.js`)**: All arithmetic executes in integer cents inside `atomic()` rollbacks:
  - `EXPENSE`: Deducts from source account and increments category spend (and optional envelope / LHDN tax relief / AA receivable).
  - `INCOME`: Credits destination account.
  - `TRANSFER`: Atomically moves principal between accounts without inflating monthly expenses; any optional `TransferFee` logs separately as a fee expense.
  - `INSTALLMENT_PURCHASE`: Amortizes purchases across monthly billing schedules.
- **Fast Consumer Numpad**: Includes **1-tap preset chips** (`RM 10`, `RM 20`, `RM 50`, `RM 100`) and a collapsible **More options** drawer (`Envelope`, `LHDN Tax Relief`, `Split Bill / AA`) so daily logging takes seconds.
- **Pre-Submission Confirmation Modal**: Every Expense, Income, Transfer, Repayment, or Installment submission pauses cleanly on a confirmation summary showing transaction type, highlighted amount + fees, source/destination **Current Balance → Balance After**, category, timestamp, and notes—letting you tap **Back to Edit** or **Confirm & Save**.

### 4. Full Itemized Transaction History Ledger (Activity)
- **Dedicated Activity View & Account Drill-Down**: Accessible directly from the bottom dock (`Activity`) or by tapping **History** on any individual Bank, Wallet, Investment, or Liability card.
- **Daily Grouping**: Groups entries under localized date headers showing Daily Total Inflow (`+RM`) and Daily Total Outflow (`-RM`), with category icons, account flow (`Bank A → Bank B`), and `Auto-Detected` badges where applicable.
- **Multi-Filter Bar**: Filter by Month/Year or Date Range, Transaction Type, Account, Category, and Keyword Search.
- **Inspect, Edit & Delete with Atomic Reversal**: Tapping any historical record allows full editing (amount, date, account, category, notes, or reclassifying Expense ↔ Transfer) or deletion, reversing exact ledger `effects` and recomputing ASNB monthly minimum snapshots automatically.

### 5. Installment & Liability Engine (SPayLater / EPP / Loans)
- **Penny-Accurate Amortization**: Splits principals across `N` months so remainder cents balance exactly to the total principal.
- **Full Edit & Delete Support**:
  - Edit or delete any existing `InstallmentPlan` (description, total principal, tenure, due day, or linked auto-debit account).
  - Edit any individual monthly `InstallmentSchedule` bill row (`amountDue`, `dueDate`, `notes`, `PENDING` / `PAID` status).
  - Automatically recalculates parent liability `currentBalance` and current-month due summaries on every edit or delete.
- **Batch Repayment & DSR %**: Pay multiple due bills in one flow while blocking duplicate payments, and monitor **Debt Service Ratio (`DSR %`)**.

### 6. Universal Investment Yield & ASNB Minimum Monthly Balance Engine
- **`ASNB_MIN_MONTHLY` / `LOWEST_MONTHLY_BALANCE`**: Continuously tracks the lowest balance between Day 1 and the last day of the calendar month (`MonthlyDividend = (LowestMonthlyBalance * AnnualRate / 100) / 12`), automatically re-deriving historical minimums when ledger edits/deletes occur.
- **`DAILY_COMPOUND`**: Lazy catch-up accrual for digital banks (`EndOfDayBalance * AnnualRate / 100 / 365`) without double-counting multiple opens on the same day.
- **`DYNAMIC_TIERED_RATE` & `FIXED_MATURITY`**: Blended multi-tier calculations and Fixed Deposit maturity tracking.

### 7. Virtual Envelopes, Recurring Bills, Calendar & Guardrail Advisor
- **Virtual Envelopes (Sinking Funds)**: Earmark funds (e.g., Road Tax, Insurance, Travel) inside physical bank accounts so they are shielded from Safe-to-Spend.
- **Recurring Bills & 30-Day Cashflow Calendar**: Manage subscriptions/bills with 1-tap monthly posting and view a day-by-day 30-day forward cashflow projection incorporating auto-debits, recurring bills, unpaid SPayLater slices, and salary paydays.
- **Component-Level Guardrail Alerts**:
  - **Rule A (Operational Floor)**: Immediate alert if an account drops below `MinBalanceLimit` (e.g., TnG NFC < RM 10.00).
  - **Rule B (Auto-Debit Look-Ahead)**: Warns before upcoming auto-debits or linked installments arrive short of `MinBalanceLimit + UpcomingObligations`, querying surplus liquid accounts to suggest the exact top-up transfer amount.
  - **Rule C (Month-End Idle Cash Sweeper)**: Between the 25th and end of month, highlights surplus cash in 0%-interest accounts eligible to sweep into ASNB before the 1st.
- **LHDN Tax Relief & Split-Bill (AA)**: Tracks annual claim caps (Lifestyle, Sports, Medical) and friend receivables separately from personal spend budgets.

### 8. Native Android Push Notification Auto-Tracking
- **Background Listener (`PfmNotificationListenerService.java`)**: Captures Malaysian banking & e-wallet notifications even when MyPFM is closed, queuing payloads locally in Android `SharedPreferences` (`MyPfmNotificationQueue`) and flushing into the WebView via `AndroidNotificationBridge` (`MainActivity.java`) on notification arrival or `onResume()`.
- **Pre-Mapped Financial Packages**: Recognizes notifications from Touch 'n Go eWallet (`my.com.tngdigital.ewallet`), Maybank MAE/M2U (`com.maybank2u.life`), CIMB OCTO (`com.cimbmalaysia`, `my.com.cimb.octo`), GXBank (`my.com.gxbank.app`), Ryt Bank (`com.rytbank.app`, `my.com.ytl.rytbank`), Shopee/SPayLater (`com.shopee.my`), AEON Bank, Boost Bank, Boost, Public Bank, Hong Leong, RHB, AmBank, Bank Islam, ASNB, Grab, BigPay, plus any notification containing `RM`/`MYR`.
- **Smart Parsing & Anti-Spam Rules**:
  - Extracts `RM` / `MYR` amount and merchant/recipient.
  - **Smart NFC Reload Detection**: Automatically records TnG eWallet NFC card reloads as an atomic `TRANSFER` (`TnG eWallet → TnG NFC Card`) instead of an expense.
  - Ignores promos/cashback/voucher spam, deduplicates identical alerts inside a 2-minute window, skips collisions with manual entries within 5 minutes, and supports custom mapping + self-learning merchant categorization.
- **In-App Simulator**: Test simulated Touch 'n Go eWallet and Maybank notifications anytime inside **Settings**.

### 9. Bilingual UI (`en` & `zh-CN`) + Local Backup/Restore
- Instant top-bar toggle between **EN** and **中文** covering all views, modals, alerts, guardrails, and category/account catalogs.
- Export/Import complete JSON snapshots cleanly with empty-overwrite protection (`REFUSED_EMPTY_OVERWRITE`).

---

## Running Automated QA Tests

All financial domain invariants, balance reversals, installment penny-rounding, ASNB yield math, notification deduplication, zero-state DOM checks, and `en`/`zh-CN` dictionary parity are verified by the automated 22-test audit suite:

```powershell
cd "PFM project\src\pfm-client"
npm test
```

Expected result: `AUDIT COMPLETE: 22 PASSED, 0 FAILED`.

---

## Mobile Deployment Guide (Android APK & PWA)

> [!IMPORTANT]
> Because `capacitor.config.ts` intentionally omits `server.url` and keeps a fixed `appId` (`com.mypfm.app`) with `androidScheme: 'https'`, the Android APK runs **100% standalone offline** (even with your PC shut down), and future updates via `adb install -r` **preserve all IndexedDB & `localStorage` user data**.

### Option A: Build & Deploy Android APK via USB (ADB) — Recommended

#### 1. Prerequisites (Windows / macOS / Linux)
- **Node.js** (v18+ recommended) and **npm**
- **Java JDK 21** (on Windows, `build-standalone.js` auto-detects `C:\Program Files\OpenLogic\jdk-21.0.4.7-hotspot` or uses `JAVA_HOME`)
- **Android SDK & Platform Tools (`adb`)** (on Windows, auto-detected from `%LOCALAPPDATA%\Android\Sdk` or `ANDROID_HOME`)

#### 2. Prepare Your Android Phone
1. Open **Settings → About phone** and tap **Build number** 7 times until *"You are now a developer!"* appears.
2. Go to **Settings → System → Developer options** and enable **USB debugging**.
3. Connect your phone to your computer with a data USB cable and choose **File Transfer / PTP** mode.
4. Unlock your phone screen and tap **Allow** (check *Always allow from this computer*) on the *"Allow USB debugging?"* dialog.
5. Confirm your phone is authorized:
   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices
   ```
   Your device serial should show `device` (not `unauthorized` or `offline`).

#### 3. Install Dependencies (First Time Only)
```powershell
cd "PFM project\src\pfm-client"
npm install
```

#### 4. One-Command Build & In-Place Deploy
Run the automated deployment script (sets `JAVA_HOME` if needed on Windows):

```powershell
cd "PFM project\src\pfm-client"
$env:JAVA_HOME = "C:\Program Files\OpenLogic\jdk-21.0.4.7-hotspot"
node scripts/build-standalone.js --android
```
*(Or equivalently `npm run android:deploy` if `JAVA_HOME` is already set in your system environment.)*

What this does automatically:
1. Bundles standalone offline assets (`index.html`, `pfm-engine.js`, `pfm-catalog.js`, `local-db.js`, `sw.js`, `manifest.json`, `assets/`) into `dist/pfm-client/browser` and stamps a fresh Service Worker version.
2. Syncs assets into `android/` via `npx cap sync android`.
3. Compiles `android/app/build/outputs/apk/debug/app-debug.apk` (also copied to `PFM project/src/pfm-client/MyPFM-standalone.apk`) via Gradle.
4. Installs or updates the app in-place via `adb install -r` so your existing accounts and ledger history remain untouched.

#### 5. Quick Install Only (Using Prebuilt `MyPFM-standalone.apk`) or Android Studio
- If you already have `MyPFM-standalone.apk` and just want to install it onto a connected phone without rebuilding:
  ```powershell
  cd "PFM project\src\pfm-client"
  & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r MyPFM-standalone.apk
  ```
- Or open the native project inside Android Studio:
  ```powershell
  npm run android:open
  ```

---

### Enabling Auto-Tracking on Sideloaded Android APKs (Android 13+)

To let MyPFM automatically detect bank & e-wallet push notifications:
1. Open **MyPFM → Settings (⚙️ / Backup & Auto-Tracking)** and tap **"Enable Notification Auto-Tracking"**.
2. Android opens **Notification access** settings. Locate **MyPFM** (`MyPFM Auto-Tracking Notification Listener`) and toggle it **On**.
3. **Android 13 / 14 / 15 Note ("Restricted Setting" toggle greyed out)**:
   Because the APK is sideloaded directly via ADB/APK rather than Google Play Store, Android restricts notification listener permission until you explicitly allow it once:
   - Go to **Android Settings → Apps → See all apps → MyPFM**.
   - Tap the **three-dot menu (`⋮`)** in the top-right corner → tap **Allow restricted settings** (confirm with PIN/biometrics).
   - Return to **Notification access** and toggle **MyPFM** **On**.
4. You can verify parsing immediately using **"Simulate Payment Notification"** inside Settings without waiting for a real purchase.

---

### Option B: Mobile Browser / Offline PWA via Local Server

If you want to run MyPFM on iOS Safari or an Android browser without installing an APK:
1. Ensure your PC and phone are on the same Wi-Fi network.
2. Run the bundled LAN server script from PowerShell:
   ```powershell
   & ".\PFM project\start_mobile_server.ps1"
   ```
   *(Serves `PFM project/src/pfm-client/src` on port `8080`.)*
3. On your phone browser, open `http://<YOUR-PC-IP>:8080`.
4. Add to Home Screen (**Share → Add to Home Screen** on iOS, or **Menu → Install app** on Chrome/Android) for full-screen standalone PWA usage.
5. Alternatively, build the static web bundle (`npm run build` inside `PFM project/src/pfm-client`) and deploy `dist/pfm-client/browser` to any HTTPS static host (a `vercel.json` configuration is included).

