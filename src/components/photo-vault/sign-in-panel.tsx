import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';

/**
 * Sign in or create an account.
 *
 * Rendered by src/app/vault.tsx when there is no session, rather than being a
 * route of its own. The Vault tab is the only authenticated part of the app, so
 * a redirect would add a navigation state to reason about for no gain.
 *
 * The autofill and keyboard props are not polish: without
 * `textContentType`/`autoComplete`, iOS and Android will not offer the password
 * manager, and a user who cannot autofill will choose a weaker password. And
 * without `autoCapitalize="none"` on the email field, a phone keyboard will
 * capitalise the first letter - which the server lowercases anyway, but which
 * looks broken while you type it.
 */

/** Must match MIN_PASSWORD_LENGTH in server/src/credentials.ts. */
const MIN_PASSWORD_LENGTH = 12;

export function SignInPanel() {
  const auth = useAuth();
  const theme = useTheme();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  const isSignUp = mode === 'signup';
  // A local check so the obvious mistake is caught without a round trip. The
  // server validates independently; this is only to avoid a pointless request.
  const canSubmit =
    email.trim() !== '' && password.length >= (isSignUp ? MIN_PASSWORD_LENGTH : 1);

  async function submit() {
    if (!canSubmit || auth.isSubmitting) return;
    if (isSignUp) {
      await auth.signUp(email, password, inviteCode.trim() || undefined);
    } else {
      await auth.signIn(email, password);
    }
    // The password is cleared either way: on success it is no longer needed,
    // and on failure leaving it in a controlled component's state keeps it in
    // the JS heap for as long as the screen is mounted.
    setPassword('');
  }

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.backgroundSelected },
  ];

  return (
    <ThemedView style={styles.panel}>
      <ThemedText type="subtitle">{isSignUp ? 'Create an account' : 'Sign in'}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Your photos are private to your account. The Worker checks who you are on
        every request, including each image it serves.
      </ThemedText>

      <ThemedView type="backgroundElement" style={styles.form}>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={theme.textSecondary}
          style={inputStyle}
          inputMode="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          accessibilityLabel="Email"
          editable={!auth.isSubmitting}
        />

        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={isSignUp ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Password'}
          placeholderTextColor={theme.textSecondary}
          style={inputStyle}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          // `new-password` is what tells a password manager to OFFER to
          // generate one, rather than to look for a saved entry.
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          textContentType={isSignUp ? 'newPassword' : 'password'}
          accessibilityLabel="Password"
          editable={!auth.isSubmitting}
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        {isSignUp ? (
          <>
            <TextInput
              value={inviteCode}
              onChangeText={setInviteCode}
              placeholder="Invite code (if this server requires one)"
              placeholderTextColor={theme.textSecondary}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Invite code"
              editable={!auth.isSubmitting}
            />
            <ThemedText type="small" themeColor="textSecondary">
              A deployed Worker runs with SIGNUP_MODE=invite, so a code is
              required there. Locally it is not.
            </ThemedText>
          </>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={!canSubmit || auth.isSubmitting}
          accessibilityRole="button"
          accessibilityLabel={isSignUp ? 'Create account' : 'Sign in'}
          style={({ pressed }) => [
            styles.submitPressable,
            pressed && styles.pressed,
            (!canSubmit || auth.isSubmitting) && styles.disabled,
          ]}>
          <ThemedView type="backgroundSelected" style={styles.submit}>
            {auth.isSubmitting ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <ThemedText type="smallBold">
                {isSignUp ? 'Create account' : 'Sign in'}
              </ThemedText>
            )}
          </ThemedView>
        </Pressable>
      </ThemedView>

      {auth.error ? (
        <ThemedView type="backgroundElement" style={styles.banner}>
          <ThemedText type="small">{auth.error}</ThemedText>
          <Pressable
            onPress={auth.dismissError}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error">
            <ThemedText type="small" themeColor="textSecondary">
              Dismiss
            </ThemedText>
          </Pressable>
        </ThemedView>
      ) : null}

      <Pressable
        onPress={() => {
          setMode(isSignUp ? 'signin' : 'signup');
          auth.dismissError();
        }}
        accessibilityRole="button"
        accessibilityLabel={isSignUp ? 'Switch to sign in' : 'Switch to create an account'}>
        <ThemedText type="link">
          {isSignUp ? 'I already have an account' : 'Create an account instead'}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: Spacing.three,
    padding: Spacing.four,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  form: {
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
  submitPressable: {
    alignSelf: 'flex-start',
  },
  submit: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.three,
    minWidth: 140,
    alignItems: 'center',
  },
  banner: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.two,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
});
