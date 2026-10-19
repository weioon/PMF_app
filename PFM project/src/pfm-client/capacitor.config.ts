import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Standalone Android Capacitor Configuration (`@capacitor/android`)
 * -----------------------------------------------------------------
 * Crucial Requirements Enforced:
 * 1. `server.url` is intentionally OMITTED so the APK never depends on a PC
 *    localhost dev server and works 100% standalone when PC / VS Code is off.
 * 2. Fixed `appId` (`com.mypfm.app`) and `androidScheme: 'https'` ensure the
 *    Android WebView origin (`https://localhost`) never changes across APK
 *    updates (`adb install -r`), preserving all IndexedDB & localStorage data.
 */
const config: CapacitorConfig = {
  appId: 'com.mypfm.app',
  appName: 'MyPFM',
  webDir: 'dist/pfm-client/browser',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
    cleartext: false
  },
  android: {
    allowMixedContent: false
  }
};

export default config;

