import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { createThumbnail, extractVideoFrames } from './mediaProcessor';

const execFileAsync = promisify(execFile);
let ffmpegAvailable = false;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
});

describe('FFmpeg media processing integration', () => {
  it('extracts FPS, interval, and encoded I-frames with persisted metadata', async (context) => {
    if (!ffmpegAvailable) context.skip();
    const root = await mkdtemp(join(tmpdir(), 'forge-ffmpeg-'));
    try {
      const source = join(root, 'source.mp4');
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', source,
      ]);

      const fpsFrames = await extractVideoFrames(source, join(root, 'fps'), { type: 'fps', fps: 2 });
      const intervalFrames = await extractVideoFrames(source, join(root, 'interval'), { type: 'interval_ms', intervalMs: 500 });
      const keyframes = await extractVideoFrames(source, join(root, 'keyframes'), { type: 'keyframe' });

      expect(fpsFrames).toHaveLength(4);
      expect(fpsFrames.map((frame) => frame.timestampMs)).toEqual([0, 500, 1000, 1500]);
      expect(intervalFrames).toHaveLength(4);
      expect(intervalFrames.map((frame) => frame.timestampMs)).toEqual([0, 500, 1000, 1500]);
      expect(keyframes.length).toBeGreaterThanOrEqual(2);
      expect(keyframes[0]).toMatchObject({ frameNumber: 1, timestampMs: 0, width: 160, height: 120 });
      expect(keyframes[1].frameNumber).toBeGreaterThan(keyframes[0].frameNumber ?? 0);

      const thumbnail = join(root, 'thumbnail.jpg');
      await createThumbnail(fpsFrames[0].filePath, thumbnail);
      await access(thumbnail);
      expect((await stat(thumbnail)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
