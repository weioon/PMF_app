/**
 * Standalone Production Build & Android Deployment Script
 * -------------------------------------------------------
 * Usage:
 *   node scripts/build-standalone.js            -> Builds standalone PWA/Web bundle into dist/pfm-client/browser
 *   node scripts/build-standalone.js --android  -> Builds web bundle, syncs Capacitor Android, and installs/updates APK via ADB (-r preserves local data)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'dist', 'pfm-client', 'browser');

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else if (exists) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log('==============================================================');
console.log(' [1/3] Building 100% Standalone Offline Bundle (PWA + Android)');
console.log('==============================================================');

fs.mkdirSync(outDir, { recursive: true });

// Copy standalone app files (index.html, local-db.js, sw.js, manifest.json, assets/)
const filesToCopy = ['index.html', 'local-db.js', 'sw.js', 'manifest.json', 'assets'];
filesToCopy.forEach((item) => {
  const srcPath = path.join(srcDir, item);
  const dstPath = path.join(outDir, item);
  if (fs.existsSync(srcPath)) {
    copyRecursiveSync(srcPath, dstPath);
  }
});

// Stamp build version in sw.js so PWA SwUpdate detects every new code push automatically
const swDistPath = path.join(outDir, 'sw.js');
if (fs.existsSync(swDistPath)) {
  const buildStamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  let swContent = fs.readFileSync(swDistPath, 'utf8');
  swContent = swContent.replace(
    /const CACHE_NAME = '[^']+';/,
    `const CACHE_NAME = 'mypfm-standalone-v2-${buildStamp}';`
  );
  fs.writeFileSync(swDistPath, swContent, 'utf8');
  console.log(` -> Stamped Service Worker cache version: mypfm-standalone-v2-${buildStamp}`);
}

console.log(` -> Standalone web bundle ready at: ${outDir}`);

const isAndroidDeploy = process.argv.includes('--android');
if (isAndroidDeploy) {
  console.log('\n==============================================================');
  console.log(' [2/3] Syncing Web Bundle into Capacitor Android Native Project');
  console.log('==============================================================');
  try {
    const androidDir = path.join(rootDir, 'android');
    if (!fs.existsSync(androidDir)) {
      console.log(' -> Initializing Capacitor Android platform (`npx cap add android`)...');
      execSync('npx cap add android', { cwd: rootDir, stdio: 'inherit' });
    }
    execSync('npx cap sync android', { cwd: rootDir, stdio: 'inherit' });

    console.log('\n==============================================================');
    console.log(' [3/3] Building & Updating APK on Connected Android Phone');
    console.log('       (Preserving 100% of IndexedDB & localStorage Data)');
    console.log('==============================================================');
    const localAppData = process.env.LOCALAPPDATA || '';
    const defaultSdkPath = path.join(localAppData, 'Android', 'Sdk');
    if (!process.env.ANDROID_HOME && fs.existsSync(defaultSdkPath)) {
      process.env.ANDROID_HOME = defaultSdkPath;
      process.env.ANDROID_SDK_ROOT = defaultSdkPath;
    }

    const jdk21Path = 'C:\\Program Files\\OpenLogic\\jdk-21.0.4.7-hotspot';
    if (fs.existsSync(jdk21Path)) {
      process.env.JAVA_HOME = jdk21Path;
    }

    const isWin = process.platform === 'win32';
    const gradlewCmd = isWin ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug';
    execSync(gradlewCmd, { cwd: androidDir, stdio: 'inherit', env: process.env });

    const apkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const rootApkCopy = path.join(rootDir, 'MyPFM-standalone.apk');
    if (fs.existsSync(apkPath)) {
      fs.copyFileSync(apkPath, rootApkCopy);
      console.log(`\n -> Standalone APK compiled successfully at:\n    1) ${apkPath}\n    2) ${rootApkCopy}`);
      const sdkAdb = path.join(defaultSdkPath, 'platform-tools', isWin ? 'adb.exe' : 'adb');
      const adbBin = fs.existsSync(sdkAdb) ? `"${sdkAdb}"` : 'adb';
      console.log(` -> Installing APK in-place via '${adbBin} install -r "${apkPath}"'...`);
      execSync(`${adbBin} install -r "${apkPath}"`, { cwd: rootDir, stdio: 'inherit' });
      console.log(' -> SUCCESS! App updated on your Android phone without wiping any data.');
    } else {
      console.log(` -> APK built. Or run 'npx cap open android' to deploy from Android Studio.`);
    }
  } catch (err) {
    console.warn('\n [Note] APK build or ADB install encountered an issue:', err.message || err);
    console.warn('        Ensure your phone shows up in `adb devices` (USB mode: File Transfer / PTP, and tap "Allow" on the USB debugging popup).');
  }
}

