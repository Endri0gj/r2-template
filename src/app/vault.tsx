import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoTile } from '@/components/photo-vault/photo-tile';
import { SignInPanel } from '@/components/photo-vault/sign-in-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { usePhotoVault } from '@/hooks/use-photo-vault';
import { useTheme } from '@/hooks/use-theme';

/**
 * Photo Vault.
 *
 * All behaviour lives in `usePhotoVault`; this file only decides how the states
 * look. That split is why the gallery's logic is covered by tests that need no
 * device: see src/hooks/use-photo-vault.test.ts.
 *
 * The screen has three states, and the gate is at the top of the component:
 * checking stored credentials, signed out, or signed in. `Gallery` is a
 * separate component rather than a branch inside this one so that
 * `usePhotoVault` - which fetches on mount - is not mounted at all until there
 * is a session to fetch with. Branching inside one component would start the
 * gallery's request while the user was still looking at the sign-in form.
 */

const COLUMNS = 3;

function ActionButton({
  label,
  onPress,
  disabled,
  tone = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'quiet';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.buttonPressable,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <ThemedView
        type={tone === 'primary' ? 'backgroundSelected' : 'backgroundElement'}
        style={styles.button}>
        <ThemedText
          type="smallBold"
          themeColor={tone === 'quiet' ? 'textSecondary' : 'text'}>
          {label}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <ThemedView type="backgroundElement" style={styles.banner}>
      {children}
    </ThemedView>
  );
}

export default function VaultScreen() {
  const auth = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  if (auth.isChecking) {
    return (
      <ThemedView style={[styles.screen, styles.centeredScreen]}>
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <ThemedView style={styles.screen}>
        {/*
          Two wrappers, both earning their place on a phone:

          KeyboardAvoidingView lifts the form clear of the keyboard. iOS needs
          "padding"; on Android the system already resizes the window, so
          "height" (or nothing) is correct and "padding" double-counts.

          ScrollView makes the form reachable when the keyboard leaves less
          room than the content needs — a small phone in landscape, or large
          text sizes. `keyboardShouldPersistTaps="handled"` is what lets the
          Sign in button receive the first tap instead of that tap being
          swallowed to dismiss the keyboard.
        */}
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            contentContainerStyle={[
              styles.signInContent,
              {
                paddingTop: insets.top + Spacing.four,
                paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag">
            <SignInPanel />
          </ScrollView>
        </KeyboardAvoidingView>
      </ThemedView>
    );
  }

  return <Gallery />;
}

function Gallery() {
  const auth = useAuth();
  const vault = usePhotoVault();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // The grid is sized from the real content width rather than a fixed number,
  // so it is correct on a phone, a tablet and a wide browser window.
  const contentWidth = Math.min(width, MaxContentWidth) - Spacing.four * 2;
  const tileSize = Math.floor((contentWidth - Spacing.two * (COLUMNS - 1)) / COLUMNS);

  const pendingPhoto = vault.photos.find((photo) => photo.id === vault.pendingDeleteId);

  return (
    <ThemedView style={styles.screen}>
      <FlatList
        data={vault.photos}
        keyExtractor={(photo) => photo.id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.column}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingTop: Platform.OS === 'web' ? Spacing.six : insets.top + Spacing.three,
            paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={vault.isRefreshing}
            onRefresh={vault.refresh}
            tintColor={theme.textSecondary}
          />
        }
        ListHeaderComponent={
          <ThemedView style={styles.header}>
            <ThemedText type="subtitle">Photo Vault</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Images live in Cloudflare R2. This list comes from D1.
            </ThemedText>

            {/* --- who is signed in ----------------------------------- */}
            <ThemedView style={styles.accountRow}>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                numberOfLines={1}
                style={styles.accountEmail}>
                {auth.user?.email}
              </ThemedText>
              <ActionButton
                label="Sign out"
                tone="quiet"
                onPress={auth.signOut}
                disabled={auth.isSubmitting}
              />
            </ThemedView>

            {/* --- pick / upload -------------------------------------- */}
            <ThemedView style={styles.actionRow}>
              <ActionButton
                label={vault.selected ? 'Choose another' : 'Select photo'}
                onPress={vault.selectPhoto}
                disabled={vault.isUploading}
              />
              {vault.selected ? (
                <ActionButton
                  label={vault.isUploading ? 'Uploading…' : 'Upload'}
                  tone="primary"
                  onPress={vault.upload}
                  disabled={vault.isUploading}
                />
              ) : null}
            </ThemedView>

            {vault.selected ? (
              <Banner>
                <ThemedView style={styles.selectedRow}>
                  <Image
                    source={{ uri: vault.selected.uri }}
                    style={styles.selectedPreview}
                    contentFit="cover"
                  />
                  <ThemedView style={styles.selectedMeta}>
                    <ThemedText type="small" numberOfLines={1}>
                      {vault.selected.filename}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {vault.selected.width}×{vault.selected.height} · not uploaded yet
                    </ThemedText>
                  </ThemedView>
                  {/*
                    There is no percentage here on purpose. React Native's fetch
                    exposes no upload progress events, so any number shown would
                    be invented. A spinner is the honest indicator.
                  */}
                  {vault.isUploading ? (
                    <ActivityIndicator color={theme.textSecondary} />
                  ) : (
                    <ActionButton label="Clear" tone="quiet" onPress={vault.clearSelection} />
                  )}
                </ThemedView>
                {vault.isUploading ? (
                  <ActionButton label="Cancel upload" tone="quiet" onPress={vault.cancelUpload} />
                ) : null}
              </Banner>
            ) : null}

            {/* --- errors --------------------------------------------- */}
            {vault.error ? (
              <Banner>
                <ThemedText type="small">{vault.error}</ThemedText>
                <ThemedView style={styles.actionRow}>
                  <ActionButton label="Retry" onPress={vault.retry} />
                  <ActionButton label="Dismiss" tone="quiet" onPress={vault.dismissError} />
                </ThemedView>
              </Banner>
            ) : null}

            {/* --- delete confirmation -------------------------------- */}
            {pendingPhoto ? (
              <Banner>
                <ThemedText type="small">
                  Delete {pendingPhoto.filename}? This removes it from R2 and D1 and cannot be
                  undone.
                </ThemedText>
                <ThemedView style={styles.actionRow}>
                  <ActionButton label="Delete" tone="primary" onPress={vault.confirmDelete} />
                  <ActionButton label="Keep" tone="quiet" onPress={vault.cancelDelete} />
                </ThemedView>
              </Banner>
            ) : null}
          </ThemedView>
        }
        ListEmptyComponent={
          vault.status === 'loading' ? (
            <ThemedView style={styles.placeholder}>
              <ActivityIndicator color={theme.textSecondary} />
            </ThemedView>
          ) : vault.isEmpty ? (
            <ThemedView style={styles.placeholder}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
                No photos yet.{'\n'}Select one and upload it.
              </ThemedText>
            </ThemedView>
          ) : undefined
        }
        renderItem={({ item }) => (
          <PhotoTile
            photo={item}
            size={tileSize}
            isDeleting={vault.deletingId === item.id}
            onDelete={() => vault.requestDelete(item.id)}
          />
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  centeredScreen: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  accountEmail: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.four,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  header: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  actionRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  buttonPressable: {
    alignSelf: 'flex-start',
  },
  button: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  banner: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.two,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  selectedPreview: {
    width: 44,
    height: 44,
    borderRadius: Spacing.two,
  },
  selectedMeta: {
    flex: 1,
    gap: Spacing.half,
  },
  column: {
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  placeholder: {
    paddingVertical: Spacing.six,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    textAlign: 'center',
  },
});
