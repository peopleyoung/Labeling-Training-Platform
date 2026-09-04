import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { describeImageFile, extractArchiveImages, parseVideoFrameMetadata, videoExtractionFilter } from './mediaProcessor';

const execFileAsync = promisify(execFile);

describe('media processor video metadata', () => {
  it('builds validated filters for every supported extraction strategy', () => {
    expect(videoExtractionFilter({ type: 'fps', fps: 2 })).toBe('fps=2');
    expect(videoExtractionFilter({ type: 'interval_ms', intervalMs: 250 })).toBe('fps=4');
    expect(videoExtractionFilter({ type: 'keyframe' })).toBe('select=eq(pict_type\\,I)');
    expect(videoExtractionFilter({ type: 'frame_step', frameStep: 5 })).toBe('select=not(mod(n\\,5))');
    expect(videoExtractionFilter({ type: 'frame_step', frameStep: 5, startFrame: 10, endFrame: 30 })).toBe('select=not(mod(n\\,5))*between(n\\,10\\,30)');
    expect(() => videoExtractionFilter({ type: 'fps', fps: 0 })).toThrow('FPS must be greater than zero');
    expect(() => videoExtractionFilter({ type: 'interval_ms', intervalMs: 0 })).toThrow('Frame interval must be greater than zero');
    expect(() => videoExtractionFilter({ type: 'frame_step', frameStep: 0 })).toThrow('Frame step must be greater than zero');
  });

  it('retains encoded frame numbers and timestamps for I-frame extraction', () => {
    expect(parseVideoFrameMetadata(JSON.stringify({ frames: [
      { key_frame: 1, best_effort_timestamp_time: '0.000000' },
      { key_frame: 0, best_effort_timestamp_time: '0.040000' },
      { key_frame: 1, best_effort_timestamp_time: '0.080000' },
    ] }))).toEqual([
      { frameNumber: 1, timestampMs: 0, keyframe: true },
      { frameNumber: 2, timestampMs: 40, keyframe: false },
      { frameNumber: 3, timestampMs: 80, keyframe: true },
    ]);
  });

  it('keeps valid nested images and reports corrupt image entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-media-'));
    try {
      const input = join(root, 'input');
      await mkdir(join(input, 'nested'), { recursive: true });
      const png = new PNG({ width: 2, height: 3 });
      png.data.fill(255);
      await writeFile(join(input, 'nested', 'valid.png'), PNG.sync.write(png));
      await writeFile(join(input, 'nested', 'corrupt.png'), 'not an image');
      const archive = join(root, 'images.tar');
      await execFileAsync('tar', ['-cf', archive, '-C', input, '.']);

      const files = await extractArchiveImages(archive, join(root, 'output'));

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ relativePath: 'nested/valid.png', width: 2, height: 3, order: 1 });
      expect(files.errors).toHaveLength(1);
      expect(files.errors?.[0]).toContain('nested/corrupt.png');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('describes a directly processed image with its dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-media-direct-'));
    try {
      const filePath = join(root, 'direct.png');
      const png = new PNG({ width: 7, height: 5 });
      png.data.fill(255);
      await writeFile(filePath, PNG.sync.write(png));

      await expect(describeImageFile(filePath, 'direct.png', 1)).resolves.toMatchObject({ width: 7, height: 5, filename: 'direct.png', order: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
