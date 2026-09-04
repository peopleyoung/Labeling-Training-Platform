import type { SourceAsset } from '../../shared/contracts';

export type SourceAssetUploadMetadata = Pick<SourceAsset, 'type' | 'mimeType'>;

const mimeMetadata: Record<string, SourceAssetUploadMetadata> = {
  'image/jpeg': { type: 'image', mimeType: 'image/jpeg' },
  'image/png': { type: 'image', mimeType: 'image/png' },
  'image/webp': { type: 'image', mimeType: 'image/webp' },
  'video/mp4': { type: 'video', mimeType: 'video/mp4' },
  'video/quicktime': { type: 'video', mimeType: 'video/quicktime' },
  'video/x-msvideo': { type: 'video', mimeType: 'video/x-msvideo' },
  'video/x-matroska': { type: 'video', mimeType: 'video/x-matroska' },
  'application/zip': { type: 'archive', mimeType: 'application/zip' },
  'application/x-zip-compressed': { type: 'archive', mimeType: 'application/zip' },
  'application/x-tar': { type: 'archive', mimeType: 'application/x-tar' },
};

const extensionMetadata: Record<string, SourceAssetUploadMetadata> = {
  '.jpg': { type: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { type: 'image', mimeType: 'image/jpeg' },
  '.png': { type: 'image', mimeType: 'image/png' },
  '.webp': { type: 'image', mimeType: 'image/webp' },
  '.mp4': { type: 'video', mimeType: 'video/mp4' },
  '.mov': { type: 'video', mimeType: 'video/quicktime' },
  '.avi': { type: 'video', mimeType: 'video/x-msvideo' },
  '.mkv': { type: 'video', mimeType: 'video/x-matroska' },
  '.zip': { type: 'archive', mimeType: 'application/zip' },
  '.tar': { type: 'archive', mimeType: 'application/x-tar' },
};

export function inferSourceAssetUpload(file: Pick<File, 'name' | 'type'>): SourceAssetUploadMetadata {
  const explicit = file.type.trim().toLowerCase();
  if (mimeMetadata[explicit]) return mimeMetadata[explicit];
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return extensionMetadata[extension] ?? { type: 'archive', mimeType: explicit || 'application/octet-stream' };
}
