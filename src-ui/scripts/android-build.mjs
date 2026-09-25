import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const win = process.platform === 'win32';
const release = process.argv[2] === 'release';
const env = { ...process.env };
const signingFile = env.SINOS_ANDROID_SIGNING_CONFIG || join(homedir(), '.coffee-cli/android/signing.json');
if (release && existsSync(signingFile)) {
  const signing = JSON.parse(readFileSync(signingFile, 'utf8'));
  for (const key of ['SINOS_ANDROID_KEYSTORE', 'SINOS_ANDROID_STORE_PASSWORD', 'SINOS_ANDROID_KEY_ALIAS', 'SINOS_ANDROID_KEY_PASSWORD']) env[key] ||= signing[key];
}
// Use installed development tools without changing the user's global environment.
if (!env.JAVA_HOME) {
  const jdks = join(homedir(), '.jdks');
  const candidates = [win && 'C:/Program Files/Android/Android Studio/jbr',
    ...existsSync(jdks) ? readdirSync(jdks).map(name => join(jdks, name)) : []].filter(Boolean);
  // Android Studio can ship a newer runtime than this Gradle version supports.
  // Prefer the documented JDK 21 even when it is installed separately.
  env.JAVA_HOME = candidates.find(path => {
    const metadata = join(path, 'release');
    return existsSync(join(path, 'bin', win ? 'javac.exe' : 'javac')) &&
      existsSync(metadata) && /^JAVA_VERSION="21(?:[."+-])/m.test(readFileSync(metadata, 'utf8'));
  });
  if (!env.JAVA_HOME) throw new Error('No compatible JDK found. Install JDK 21 and set JAVA_HOME before building Android.');
}
if (!env.ANDROID_HOME && win) {
  const sdk = join(env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Android/Sdk');
  if (existsSync(sdk)) env.ANDROID_HOME = sdk;
}
if (release && !['SINOS_ANDROID_KEYSTORE', 'SINOS_ANDROID_STORE_PASSWORD', 'SINOS_ANDROID_KEY_ALIAS', 'SINOS_ANDROID_KEY_PASSWORD'].every(key => env[key])) {
  throw new Error('Release signing is required. See android/README.md for SINOS_ANDROID_* variables. Use npm run android:apk for a local test APK.');
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: win });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(win ? 'npm.cmd' : 'npm', ['run', 'build:android'], root);
run(win ? 'gradlew.bat' : './gradlew', [release ? 'assembleRelease' : 'assembleDebug', 'lintDebug', '--console=plain'], join(root, 'android'));
const version = JSON.parse(readFileSync(join(root, '../tauri.conf.json'), 'utf8')).version;
const destination = resolve(root, '../target/android'); mkdirSync(destination, { recursive: true });
const kind = release ? 'release' : 'debug';
const apk = join(destination, `Sinos-${version}-android-${kind}.apk`);
copyFileSync(join(root, `android/app/build/outputs/apk/${kind}/app-${kind}.apk`), apk);
console.log(`\nAPK: ${apk}`);
