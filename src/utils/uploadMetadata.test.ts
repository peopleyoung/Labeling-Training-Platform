import { describe, expect, it } from 'vitest';
import { inferSourceAssetUpload } from './uploadMetadata';

describe('inferSourceAssetUpload', () => {
  it('uses the image extension when the browser omits MIME metadata', () => {
    expect(inferSourceAssetUpload({ name: 'frame.JPG', type: '' })).toEqual({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('uses the video extension when the browser reports a generic MIME', () => {
    expect(inferSourceAssetUpload({ name: 'inspection.mp4', type: 'application/octet-stream' })).toEqual({ type: 'video', mimeType: 'video/mp4' });
  });

  it('provides archive fallbacks and keeps unknown files safe', () => {
    expect(inferSourceAssetUpload({ name: 'samples.zip', type: '' })).toEqual({ type: 'archive', mimeType: 'application/zip' });
    expect(inferSourceAssetUpload({ name: 'payload.bin', type: '' })).toEqual({ type: 'archive', mimeType: 'application/octet-stream' });
  });
});
