import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { fetchPhotoBlob, photoImageSource } from '@/lib/photo-vault/client';
import type { Photo } from '@/lib/photo-vault/types';

type ImageSource = { uri: string; headers?: Record<string, string> };

/**
 * Renders one photo out of the PRIVATE R2 bucket.
 *
 * There is no public URL for these bytes. Every read goes through the Worker
 * and has to carry an access token, which is the whole reason this component
 * is more than an `<Image source={{ uri }} />`:
 *
 *   native  expo-image accepts `headers` on its source and sends them with the
 *           request, so the token travels with the image fetch.
 *   web     an <img> tag cannot send an Authorization header at all. So we
 *           fetch the bytes ourselves, wrap them in a blob: URL, and hand that
 *           to the image. The URL is revoked on unmount so the blob is not
 *           leaked.
 *
 * This asymmetry is not an expo-image limitation - it is how browsers work.
 *
 * Both branches are asynchronous now, because obtaining a token may require
 * refreshing it first. On native that means the source is null for one frame
 * while the (usually already-cached) token is resolved.
 */
function usePhotoUri(photo: Photo): ImageSource | null {
  const [source, setSource] = useState<ImageSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    const controller = new AbortController();

    void (async () => {
      try {
        if (Platform.OS === 'web') {
          const blob = await fetchPhotoBlob(photo, controller.signal);
          if (cancelled) return;
          createdUrl = URL.createObjectURL(blob);
          setSource({ uri: createdUrl });
        } else {
          const next = await photoImageSource(photo);
          if (cancelled) return;
          setSource(next);
        }
      } catch {
        // Leaves the tile in its placeholder state; the list-level error
        // banner already tells the user if the API is unreachable, and one
        // failed thumbnail should not blank out the gallery.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [photo]);

  return source;
}

type PhotoTileProps = {
  photo: Photo;
  size: number;
  isDeleting: boolean;
  onDelete: () => void;
};

export function PhotoTile({ photo, size, isDeleting, onDelete }: PhotoTileProps) {
  const source = usePhotoUri(photo);

  return (
    <ThemedView type="backgroundElement" style={[styles.tile, { width: size, height: size }]}>
      {source ? (
        <Image
          source={source}
          style={styles.image}
          contentFit="cover"
          // expo-image caches by URL, so scrolling back does not re-download.
          // Combined with the Worker's ETag this makes repeat views nearly free.
          cachePolicy="memory-disk"
          transition={150}
          accessibilityLabel={photo.filename}
        />
      ) : null}

      <Pressable
        onPress={onDelete}
        disabled={isDeleting}
        hitSlop={Spacing.two}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${photo.filename}`}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
        <ThemedText type="smallBold" style={styles.deleteLabel}>
          {isDeleting ? '…' : '×'}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  deleteButton: {
    position: 'absolute',
    top: Spacing.one,
    right: Spacing.one,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    // Deliberately not a theme colour: this sits on top of an arbitrary photo,
    // so it needs its own contrast regardless of light or dark mode.
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  deleteLabel: {
    color: '#ffffff',
    lineHeight: 18,
  },
  pressed: {
    opacity: 0.6,
  },
});
