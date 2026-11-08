import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolving the API base URL.
 *
 * This looks like trivial string handling and is not: getting it wrong is
 * invisible in every test that mocks the client, and then the app shows a
 * configuration error on a real device. It has now done exactly that twice —
 * once on web and once on an Android emulator — so each source of the host
 * gets a test.
 */

const mockConstants = { expoConfig: null as { hostUri?: string } | null };
const mockNativeModules = {
  SourceCode: undefined as { getConstants?: () => { scriptURL?: string } } | undefined,
};
const mockPlatform = { OS: 'ios' as 'ios' | 'android' | 'web' };

vi.mock('expo-constants', () => ({ default: mockConstants }));
vi.mock('react-native', () => ({
  get NativeModules() {
    return mockNativeModules;
  },
  get Platform() {
    return mockPlatform;
  },
}));

const { getConfig, resetConfigCache } = await import('./config');

function withScriptUrl(scriptURL: string | undefined) {
  mockNativeModules.SourceCode = { getConstants: () => ({ scriptURL }) };
}

beforeEach(() => {
  resetConfigCache();
  mockConstants.expoConfig = null;
  mockNativeModules.SourceCode = undefined;
  mockPlatform.OS = 'ios';
  delete process.env.EXPO_PUBLIC_PHOTO_VAULT_API_URL;
  vi.unstubAllGlobals();
  vi.stubGlobal('__DEV__', true);
});

describe('an explicit URL wins', () => {
  it('uses EXPO_PUBLIC_PHOTO_VAULT_API_URL even when a dev host is available', () => {
    process.env.EXPO_PUBLIC_PHOTO_VAULT_API_URL = 'https://api.example.com';
    mockConstants.expoConfig = { hostUri: '192.168.1.5:8081' };

    expect(getConfig().baseUrl).toBe('https://api.example.com');
  });

  it('strips trailing slashes, so paths do not end up doubled', () => {
    process.env.EXPO_PUBLIC_PHOTO_VAULT_API_URL = 'https://api.example.com///';
    expect(getConfig().baseUrl).toBe('https://api.example.com');
  });
});

describe('deriving the host in development', () => {
  it('uses hostUri when the manifest provides one (Expo Go, dev client)', () => {
    mockConstants.expoConfig = { hostUri: '192.168.1.5:8081' };
    expect(getConfig().baseUrl).toBe('http://192.168.1.5:8787');
  });

  it("falls back to Metro's script URL in a bare debug build", () => {
    // What `npx expo run:android` actually produces: no manifest at all, so
    // every Expo field is null, but the bundle still came from somewhere.
    mockPlatform.OS = 'android';
    withScriptUrl(
      'http://10.0.2.2:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true',
    );

    // 10.0.2.2 is the host machine as seen from an Android emulator — the one
    // address the device has already proved it can reach.
    expect(getConfig().baseUrl).toBe('http://10.0.2.2:8787');
  });

  it('handles a bracketed IPv6 script URL', () => {
    withScriptUrl('http://[::1]:8081/index.bundle?platform=ios');
    expect(getConfig().baseUrl).toBe('http://[::1]:8787');
  });

  it('falls back to the page hostname on web', () => {
    mockPlatform.OS = 'web';
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });

    expect(getConfig().baseUrl).toBe('http://localhost:8787');
  });

  it('survives SourceCode being missing or throwing', () => {
    mockNativeModules.SourceCode = {
      getConstants: () => {
        throw new Error('not available');
      },
    };
    expect(() => getConfig()).toThrow('Set EXPO_PUBLIC_PHOTO_VAULT_API_URL');
  });
});

describe('production builds', () => {
  it('never guesses a dev host', () => {
    vi.stubGlobal('__DEV__', false);
    mockConstants.expoConfig = { hostUri: '192.168.1.5:8081' };
    withScriptUrl('http://192.168.1.5:8081/index.bundle');

    // Guessing here would hide a missing configuration behind a confusing
    // connection error on a user's device.
    expect(() => getConfig()).toThrow('Set EXPO_PUBLIC_PHOTO_VAULT_API_URL');
  });
});

describe('memoization', () => {
  it('resolves once per session', () => {
    mockConstants.expoConfig = { hostUri: '192.168.1.5:8081' };
    const first = getConfig();

    mockConstants.expoConfig = { hostUri: '10.0.0.1:8081' };
    expect(getConfig()).toBe(first);

    resetConfigCache();
    expect(getConfig().baseUrl).toBe('http://10.0.0.1:8787');
  });
});
