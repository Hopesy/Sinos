import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sinos.mobile',
  appName: 'Sinos',
  webDir: 'dist-android',
  loggingBehavior: 'none',
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: { allowMixedContent: false, backgroundColor: '#101211' },
};
export default config;
