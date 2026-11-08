import * as ImagePicker from 'expo-image-picker';

import type { PickedPhoto } from './types';

/**
 * Thin wrapper over the system photo picker.
 *
 * It exists for two reasons: it normalizes what `ImagePicker` returns into our
 * own `PickedPhoto` shape, and it gives the hook a single small module to stub
 * in tests instead of mocking a native module.
 *
 * What the picker actually gives back (SDK 58):
 *   { canceled: true,  assets: null }
 *   { canceled: false, assets: ImagePickerAsset[] }
 * and each asset has `uri`, `width`, `height`, and OPTIONAL `fileName`,
 * `fileSize`, `mimeType`. The optional ones really are often missing, which is
 * why the fallbacks below are not defensive padding.
 *
 * https://docs.expo.dev/versions/v58.0.0/sdk/imagepicker/
 */
export async function pickPhoto(): Promise<PickedPhoto | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    // SDK 58 takes an array of media-type strings. The old
    // `ImagePicker.MediaTypeOptions.Images` enum is deprecated - if you see it
    // in a tutorial, the tutorial predates SDK 51.
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    // Re-encode at 80% quality. This is the single most effective thing you can
    // do to stay under the upload limit, and it happens on the device, before
    // any bytes move.
    quality: 0.8,
    exif: false,
  });

  // No permission prompt is needed to READ from the library on iOS or Android
  // for this call; the system picker runs out-of-process and hands back only
  // what the user chose.
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  return {
    uri: asset.uri,
    filename: asset.fileName ?? 'photo.jpg',
    mimeType: asset.mimeType ?? null,
    width: asset.width,
    height: asset.height,
  };
}
