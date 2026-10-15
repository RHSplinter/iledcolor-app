import { Capacitor } from '@capacitor/core';

/** True inside the Android/iOS app shell; false in the browser PWA. */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();
export const platformName = (): string => Capacitor.getPlatform();
