/**
 * MyPFM — Malaysian Financial Institution Knowledge Base (Smart Catalog)
 * ---------------------------------------------------------------------
 * Pre-configured metadata used when the user taps "+ Add Account" and picks
 * from the Smart Catalog, and by the notification auto-discovery engine.
 *
 * Nothing in this catalog is ever added to the user's data automatically
 * unless the user picks it (or explicitly enables auto-create in Settings).
 *
 * Default interest / dividend rates are editable placeholders, not fixed quotes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PfmCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const GROUPS = [
    { key: 'COMMERCIAL_BANK', en: 'Commercial Banks', zh: '商业银行' },
    { key: 'DIGITAL_BANK', en: 'Digital / High-Yield Banks', zh: '数字银行 / 高息银行' },
    { key: 'EWALLET', en: 'e-Wallets & Transit', zh: '电子钱包与交通卡' },
    { key: 'INVESTMENT', en: 'Investments', zh: '投资理财' },
    { key: 'LIABILITY', en: 'Liabilities & BNPL', zh: '负债与先买后付' }
  ];

  const bank = (code, nameEn, nameZh, pkgs, verified) => ({
    code, group: 'COMMERCIAL_BANK', pillar: 'ASSET_LIQUID',
    subTypeEn: 'Commercial Banks', subTypeZh: '商业银行',
    nameEn, nameZh, interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
    defaultFloor: 0, isZeroInterestLiquid: true,
    androidPackages: pkgs, pkgVerified: verified, notificationKeywords: []
  });

  const digital = (code, nameEn, nameZh, rate, pkgs, keywords) => ({
    code, group: 'DIGITAL_BANK', pillar: 'ASSET_LIQUID',
    subTypeEn: 'Digital Banks', subTypeZh: '数字银行',
    nameEn, nameZh, interestMethod: 'DAILY_COMPOUND', defaultRate: rate, autoAccrue: true,
    defaultFloor: 0, isZeroInterestLiquid: false,
    androidPackages: pkgs, pkgVerified: false, notificationKeywords: keywords || []
  });

  const ITEMS = [
    // --- Commercial banks (0% daily interest, liquid) ---
    bank('MAYBANK', 'Maybank (MAE / M2U)', 'Maybank 马来亚银行 (MAE / M2U)', ['com.maybank2u.life', 'com.maybank2u.m2umobile'], false),
    bank('CIMB', 'CIMB (OCTO MY)', 'CIMB 联昌银行 (OCTO MY)', ['com.cimbmalaysia', 'com.cimb.cimbocto'], false),
    bank('PUBLIC_BANK', 'Public Bank (PB engage)', '大众银行 Public Bank (PB engage)', ['my.com.publicbank.pbengage', 'com.publicbank.pbengage'], false),
    bank('HONG_LEONG', 'Hong Leong Bank (HLB Connect)', '丰隆银行 Hong Leong (HLB Connect)', ['my.com.hongleongconnect.mobileconnect'], false),
    bank('RHB', 'RHB Bank', '兴业银行 RHB', ['com.rhbgroup.rhbmobilebanking'], false),
    bank('AMBANK', 'AmBank (AmOnline)', '大马银行 AmBank (AmOnline)', ['com.ambank.ambankonline', 'my.com.ambank.amonline'], false),
    bank('BANK_ISLAM', 'Bank Islam (GO by Bank Islam)', '伊斯兰银行 Bank Islam (GO)', ['com.bankislam.go', 'my.com.bankislam.go'], false),
    bank('BSN', 'BSN (MyBSN)', '国民储蓄银行 BSN (MyBSN)', ['com.bsn.mybsn', 'my.com.bsn.mybsn'], false),

    // --- Digital / high-yield banks (DAILY_COMPOUND interest engine) ---
    digital('GXBANK', 'GXBank', 'GXBank 数字银行', 3.00, ['my.com.gxbank.app', 'com.gxbank.app'], ['gxbank', 'gx bank']),
    digital('RYT_BANK', 'Ryt Bank (YTL / Sea)', 'Ryt Bank 数字银行 (YTL / Sea)', 4.00, ['com.rytbank.app', 'my.com.rytbank'], ['ryt bank', 'rytbank']),
    digital('AEON_BANK', 'AEON Bank', 'AEON Bank 数字银行', 3.00, ['my.com.aeonbank.app', 'com.aeonbank.app'], ['aeon bank']),
    digital('BOOST_BANK', 'Boost Bank', 'Boost Bank 数字银行', 3.00, ['my.com.boostbank.app', 'com.boostbank.app'], ['boost bank']),

    // --- e-Wallets & transit ---
    {
      code: 'TNG_EWALLET', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'e-Wallets', subTypeZh: '电子钱包',
      nameEn: "Touch 'n Go eWallet", nameZh: "Touch 'n Go 电子钱包", interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['my.com.tngdigital.ewallet'], pkgVerified: true,
      notificationKeywords: ['ewallet', "touch 'n go", 'tng']
    },
    {
      code: 'TNG_NFC', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: "Touch 'n Go NFC Card", subTypeZh: "Touch 'n Go NFC 实体卡",
      nameEn: "Touch 'n Go NFC Card", nameZh: "Touch 'n Go NFC 实体卡", interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 10, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: true, notificationKeywords: ['nfc', 'card balance']
    },
    {
      code: 'GRABPAY', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'e-Wallets', subTypeZh: '电子钱包',
      nameEn: 'GrabPay Wallet', nameZh: 'GrabPay 钱包', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.grabtaxi.passenger'], pkgVerified: true,
      notificationKeywords: ['grabpay', 'wallet']
    },
    {
      code: 'BOOST_EWALLET', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'e-Wallets', subTypeZh: '电子钱包',
      nameEn: 'Boost eWallet', nameZh: 'Boost 电子钱包', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['my.com.myboost'], pkgVerified: false,
      notificationKeywords: ['boost']
    },
    {
      code: 'SHOPEEPAY', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'e-Wallets', subTypeZh: '电子钱包',
      nameEn: 'ShopeePay', nameZh: 'ShopeePay 钱包', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.shopee.my'], pkgVerified: true,
      notificationKeywords: ['shopeepay']
    },
    {
      code: 'WISE', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'Multi-Currency Wallet', subTypeZh: '多币种钱包',
      nameEn: 'Wise (MYR / Global)', nameZh: 'Wise 多币种钱包', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.transferwise.android'], pkgVerified: false,
      notificationKeywords: ['wise', 'transferwise']
    },
    {
      code: 'BIGPAY', group: 'EWALLET', pillar: 'ASSET_LIQUID', subTypeEn: 'Travel e-Wallet', subTypeZh: '旅游电子钱包',
      nameEn: 'BigPay', nameZh: 'BigPay 电子钱包', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.bigpayme.app'], pkgVerified: false,
      notificationKeywords: ['bigpay']
    },

    // --- Investments & Money Market ---
    {
      code: 'ASNB_ASB', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'ASNB Fixed-Price Funds', subTypeZh: 'ASNB 固定价格基金',
      nameEn: 'ASNB ASB (Fixed-Price)', nameZh: 'ASNB ASB 固定价格基金', interestMethod: 'LOWEST_MONTHLY_BALANCE', defaultRate: 5.00, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.pnb.myasnb', 'my.com.asnb.myasnb'], pkgVerified: false,
      notificationKeywords: ['asb']
    },
    {
      code: 'ASNB_ASM', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'ASNB Fixed-Price Funds', subTypeZh: 'ASNB 固定价格基金',
      nameEn: 'ASNB ASM (Fixed-Price)', nameZh: 'ASNB ASM 固定价格基金', interestMethod: 'LOWEST_MONTHLY_BALANCE', defaultRate: 4.50, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.pnb.myasnb', 'my.com.asnb.myasnb'], pkgVerified: false,
      notificationKeywords: ['asm', 'amanah saham malaysia']
    },
    {
      code: 'ASNB_VARIABLE', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'ASNB Variable-Price Funds', subTypeZh: 'ASNB 浮动价格基金',
      nameEn: 'ASNB Variable-Price Fund', nameZh: 'ASNB 浮动价格基金', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: false, notificationKeywords: []
    },
    {
      code: 'EPF', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Retirement (EPF / KWSP)', subTypeZh: '公积金 (EPF / KWSP)',
      nameEn: 'EPF (KWSP)', nameZh: '雇员公积金 EPF (KWSP)', interestMethod: 'NONE', defaultRate: 5.50, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['my.gov.kwsp.iakaun', 'com.kwsp.iakaun'], pkgVerified: false,
      notificationKeywords: ['kwsp', 'epf']
    },
    {
      code: 'VERSA', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Money Market / Cash Management', subTypeZh: '货币市场 / 现金管理',
      nameEn: 'Versa Cash', nameZh: 'Versa 现金管理', interestMethod: 'DAILY_COMPOUND', defaultRate: 3.50, autoAccrue: true,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['my.versa.app', 'com.versa.app'], pkgVerified: false,
      notificationKeywords: ['versa']
    },
    {
      code: 'KDI_SAVE', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Money Market / Cash Management', subTypeZh: '货币市场 / 现金管理',
      nameEn: 'KDI Save (Kenanga)', nameZh: 'KDI Save 现金管理', interestMethod: 'DAILY_COMPOUND', defaultRate: 3.50, autoAccrue: true,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.kenanga.kdi', 'my.com.kenanga.kdi'], pkgVerified: false,
      notificationKeywords: ['kdi', 'kdi save']
    },
    {
      code: 'STASHAWAY', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Robo-Advisors', subTypeZh: '智能投顾',
      nameEn: 'StashAway', nameZh: 'StashAway 智能投顾', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['co.stashaway.app', 'com.stashaway.app'], pkgVerified: false,
      notificationKeywords: ['stashaway']
    },
    {
      code: 'FSMONE', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Investment Platform / Unit Trust', subTypeZh: '投资平台 / 基金股票',
      nameEn: 'FSMOne Malaysia', nameZh: 'FSMOne 投资平台', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.ifast.fsmone', 'my.com.fsmone'], pkgVerified: false,
      notificationKeywords: ['fsmone']
    },
    {
      code: 'FIXED_DEPOSIT', group: 'INVESTMENT', pillar: 'ASSET_INVESTMENT', subTypeEn: 'Fixed Deposits', subTypeZh: '定期存款',
      nameEn: 'Fixed Deposit (Bank FD)', nameZh: '定期存款 (Bank FD)', interestMethod: 'FIXED_MATURITY', defaultRate: 3.50, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: true, notificationKeywords: ['fd', 'fixed deposit']
    },

    // --- Liabilities & BNPL ---
    {
      code: 'SPAYLATER', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'SPayLater / BNPL', subTypeZh: 'SPayLater / 先买后付',
      nameEn: 'SPayLater (Shopee)', nameZh: 'SPayLater 分期付款 (Shopee)', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.shopee.my'], pkgVerified: true,
      notificationKeywords: ['spaylater', 'paylater']
    },
    {
      code: 'GRAB_PAYLATER', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'BNPL', subTypeZh: '先买后付',
      nameEn: 'Grab PayLater', nameZh: 'Grab PayLater 先买后付', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.grabtaxi.passenger'], pkgVerified: true,
      notificationKeywords: ['paylater']
    },
    {
      code: 'ATOME', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'BNPL', subTypeZh: '先买后付',
      nameEn: 'Atome', nameZh: 'Atome 先买后付', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: ['com.atome.paylater', 'id.co.atome'], pkgVerified: false,
      notificationKeywords: ['atome']
    },
    {
      code: 'CREDIT_CARD', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'Credit Cards', subTypeZh: '信用卡',
      nameEn: 'Credit Card (Bank)', nameZh: '银行信用卡 (Credit Card)', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: true, notificationKeywords: ['card']
    },
    {
      code: 'CAR_LOAN', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'Car Loans (Hire Purchase)', subTypeZh: '汽车贷款 (分期付款)',
      nameEn: 'Car Loan (Hire Purchase)', nameZh: '汽车贷款 (Hire Purchase)', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: true, notificationKeywords: []
    },
    {
      code: 'PERSONAL_LOAN', group: 'LIABILITY', pillar: 'LIABILITY', subTypeEn: 'Personal Loans', subTypeZh: '个人贷款',
      nameEn: 'Personal Loan', nameZh: '个人贷款', interestMethod: 'NONE', defaultRate: 0, autoAccrue: false,
      defaultFloor: 0, isZeroInterestLiquid: false, androidPackages: [], pkgVerified: true, notificationKeywords: []
    }
  ];

  function findByCode(code) {
    return ITEMS.find((i) => i.code === code) || null;
  }

  /** All catalog items whose Android package list contains `pkg`. */
  function findByPackage(pkg) {
    if (!pkg) return [];
    return ITEMS.filter((i) => (i.androidPackages || []).includes(pkg));
  }

  /**
   * Smart Autocomplete search matching nameEn, nameZh, code, or keywords.
   */
  function searchCatalog(query) {
    if (!query) return ITEMS.slice();
    const q = String(query).toLowerCase().trim();
    return ITEMS.filter((item) => {
      if (item.code.toLowerCase().includes(q)) return true;
      if (item.nameEn.toLowerCase().includes(q)) return true;
      if (item.nameZh.toLowerCase().includes(q)) return true;
      if (item.subTypeEn.toLowerCase().includes(q)) return true;
      if (item.subTypeZh.toLowerCase().includes(q)) return true;
      if ((item.notificationKeywords || []).some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  /**
   * Picks the best catalog match for a notification. When several institutions
   * share one app (e.g. ShopeePay & SPayLater both live in `com.shopee.my`),
   * the notification text keywords decide.
   */
  function matchNotification(pkg, text) {
    const candidates = findByPackage(pkg);
    if (candidates.length <= 1) return candidates[0] || null;
    const lower = String(text || '').toLowerCase();
    let best = null;
    let bestScore = -1;
    candidates.forEach((c) => {
      const score = (c.notificationKeywords || []).reduce((s, k) => s + (lower.includes(k) ? k.length : 0), 0);
      if (score > bestScore) { best = c; bestScore = score; }
    });
    return best;
  }

  /** Every package the native listener should watch (deduplicated). */
  function allPackages() {
    const set = new Set();
    ITEMS.forEach((i) => (i.androidPackages || []).forEach((p) => set.add(p)));
    return Array.from(set);
  }

  return { GROUPS, ITEMS, findByCode, findByPackage, searchCatalog, matchNotification, allPackages };
});
