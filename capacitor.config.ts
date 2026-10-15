import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.harrybin.ledhat',
  appName: 'LED Hat',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Scanning for caps…',
        cancel: 'Cancel',
        availableDevices: 'Nearby caps',
        noDeviceFound: 'No cap found',
      },
    },
  },
};

export default config;
