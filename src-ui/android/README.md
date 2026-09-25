# Sinos Android

The Android app packages the existing mobile workspace with Capacitor 8. It uses
the same Cloudflare relay and end-to-end encryption as the browser client. No
additional public server is required. Android 7.0 (API 24) or later is supported.

## Use

1. Install the APK, then keep Sinos running on your computer.
2. On the computer, open **Settings → Mobile → Connect new device**.
3. In the app, tap **扫码连接电脑**, scan the QR, and confirm pairing.
   Pasting the original HTTPS pairing link is also supported.
4. Subsequent launches restore the saved pairing automatically. Re-pair only
   after revoking the device, clearing app data, or uninstalling.

The ongoing notification provides **暂停连接**. The app's **连接与显示** panel
can pause/resume without forgetting the computer, or explicitly remove pairing.
The computer must remain running and online. Android force-stop, Doze and vendor
battery restrictions can interrupt connectivity; reopening restores it without
another scan. This is not a promise of uninterrupted delivery under all OS states.

## Build an APK

Prerequisites: Node 22+, JDK 21, Android SDK platform/build tools 36. Android Studio
2025.2.1+ includes the appropriate tooling. The build script also discovers the
standard Windows SDK and Android Studio / `.jdks` JDK installations.

```sh
cd src-ui
npm ci
npm run android:apk
```

The script builds the UI, runs Capacitor sync, compiles the native app and runs
Android lint. Output: `target/android/Sinos-<version>-android-debug.apk` at the
repository root. `npm run android:open` opens the native project in Android Studio.
The version name/code are derived from `tauri.conf.json`; do not edit them separately.
GitHub's **Build Android app** workflow produces a downloadable test APK artifact.

For a production APK, set these environment variables to an existing private
signing key, then run `npm run android:release`:

- `SINOS_ANDROID_KEYSTORE`: absolute path to the `.jks` file
- `SINOS_ANDROID_STORE_PASSWORD`
- `SINOS_ANDROID_KEY_ALIAS`
- `SINOS_ANDROID_KEY_PASSWORD`

For a new app signing identity, run `npm run android:setup-signing` once. This
creates a private key and `signing.json` under `~/.coffee-cli/android/`, outside
Git. `npm run android:release` reads that file automatically; environment variables
take precedence. Back up this private directory securely. The setup command
refuses to replace an existing identity.

Output: `target/android/Sinos-<version>-android-release.apk`. Keep the signing key
and credentials backed up outside this repository: future updates must use the
same key. Debug and release signatures differ and cannot upgrade each other.
The workflow deliberately produces test artifacts rather than publishing unsigned
or randomly re-signed releases. Publishing to Google Play is a separate process.

## Verify lifecycle behavior

Run `npm test` in `src-ui`. On a disposable Android emulator, run
`./gradlew :app:connectedDebugAndroidTest` inside `src-ui/android` to verify the
KeyStore round trip and tamper rejection (these tests reset the app's pairing).

For end-to-end validation, set `RELAY_TEST_URL` to your deployed HTTPS relay and
run `npx tsx test/android-host.ts` in `relay`. Paste the generated invitation from
`target/android-test/invite.txt` into the app within 60 seconds. The fixture is
isolated from your projects and exposes a named, empty workspace. Check background
retention, force-stop/relaunch, airplane mode recovery, pause/resume and notification
controls. Type `quit` to revoke the disposable pairing. Counts in `metrics.json`
confirm that encrypted RPC requests reached the test host.

## Native behavior

- QR capture uses ZXing on-device and works without Google Play Services. Camera
  permission is requested only when scanning. Images are not uploaded.
- Pairing credentials are AES-GCM encrypted with an Android KeyStore key. App
  backup is disabled; plaintext keys are never written to localStorage or logs.
- OkHttp's WebSocket is owned by a `connectedDevice` foreground service, not by
  the WebView. The service handles heartbeat, network changes and capped retries.
- Application encryption remains in the existing pairing protocol. The native
  bridge only transports ciphertext and public connection control frames.
- Background frame buffering is bounded; reconnecting resets the encrypted
  channel and re-fetches desktop state instead of replaying user input.
- Only local packaged assets have native access. Cleartext relay URLs and QR
  links with conflicting origins are rejected. Pairing still requires confirmation.

Relevant upstream documentation: [Capacitor environment](https://capacitorjs.com/docs/getting-started/environment-setup),
[Android connected-device services](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device),
[ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded).
