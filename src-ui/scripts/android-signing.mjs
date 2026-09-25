import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const directory = join(homedir(), '.coffee-cli/android');
const config = join(directory, 'signing.json'), keystore = join(directory, 'sinos-release.jks');
if (existsSync(config) || existsSync(keystore)) throw new Error('A signing identity already exists. Reuse it; never overwrite an app signing key.');
const jdks = join(homedir(), '.jdks'), win = process.platform === 'win32';
const candidates = [process.env.JAVA_HOME, win && 'C:/Program Files/Android/Android Studio/jbr',
  ...existsSync(jdks) ? readdirSync(jdks).map(name => join(jdks, name)) : []].filter(Boolean);
const java = candidates.find(path => existsSync(join(path, 'bin', win ? 'keytool.exe' : 'keytool')));
if (!java) throw new Error('Set JAVA_HOME to JDK 21 before creating the signing key.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (win) {
  const owner = spawnSync('whoami.exe', [], { encoding: 'utf8' }).stdout?.trim();
  if (!owner) throw new Error('Unable to determine the signing directory owner.');
  const permissions = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { stdio: 'pipe' });
  if (permissions.status !== 0) throw new Error('Unable to restrict the private signing directory permissions.');
}
const password = randomBytes(32).toString('base64url');
const result = spawnSync(join(java, 'bin', win ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-keystore', keystore,
  '-storetype', 'PKCS12', '-alias', 'sinos', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
  '-dname', 'CN=Sinos Android', '-storepass:env', 'SINOS_SIGNING_PASSWORD', '-keypass:env', 'SINOS_SIGNING_PASSWORD'],
  { env: { ...process.env, SINOS_SIGNING_PASSWORD: password }, stdio: 'pipe' });
if (result.status !== 0) throw new Error('Key generation failed. Check the JDK and directory permissions.');
writeFileSync(config, JSON.stringify({ SINOS_ANDROID_KEYSTORE: keystore, SINOS_ANDROID_STORE_PASSWORD: password,
  SINOS_ANDROID_KEY_ALIAS: 'sinos', SINOS_ANDROID_KEY_PASSWORD: password }, null, 2), { mode: 0o600, flag: 'wx' });
console.log(`Signing identity created in ${directory}. Back up this private directory for future app updates. No signing secrets belong in Git.`);
