import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="vault">
        <NativeTabs.Trigger.Label>Vault</NativeTabs.Trigger.Label>
        {/*
          The other two tabs ship their own PNGs. This one uses the platform's
          built-in icon sets instead: `sf` is an SF Symbol on iOS, `md` a
          Material Symbol on Android. No new asset files, and each platform
          gets its own native-looking glyph.
        */}
        <NativeTabs.Trigger.Icon sf="photo.on.rectangle" md="photo_library" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
