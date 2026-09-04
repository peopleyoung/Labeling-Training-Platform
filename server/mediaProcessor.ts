import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import { safeArchiveRelativePath } from './mediaProcessing';

export interface ProcessedMediaFile { filePath: string; relativePath: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; width?: number; height?: number; frameNumber?: number; timestampMs?: number; order: number; }
export type ProcessedMediaFiles = ProcessedMediaFile[] & { errors?: string[]; skipped?: string[] };
export interface VideoFrameMetadata { frameNumber: number; timestampMs?: number; keyframe: boolean; }
export interface VideoExtractionOptions { type: 'fps' | 'interval_ms' | 'frame_step' | 'keyframe'; fps?: number; intervalMs?: number; frameStep?: number; startFrame?: number; endFrame?: number; imageQuality?: number; }
const imageExtensions = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);

function run(command: string, args: string[], maxOutput = 20 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let length = 0;
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > maxOutput) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(Buffer.concat(errors).toString().trim() || `${command} exited with ${code}`)));
  });
}

export function parseVideoFrameMetadata(payload: string): VideoFrameMetadata[] {
  const parsed = JSON.parse(payload) as { frames?: Array<{ key_frame?: number; best_effort_timestamp_time?: string; pkt_dts_time?: string }> };
  return (parsed.frames ?? []).map((frame, index) => {
    const seconds = Number(frame.best_effort_timestamp_time ?? frame.pkt_dts_time);
    return { frameNumber: index + 1, timestampMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined, keyframe: frame.key_frame === 1 };
  });
}

function frameBoundsFilter(strategy: VideoExtractionOptions) {
  if (strategy.startFrame !== undefined && strategy.endFrame !== undefined) return `between(n\\,${strategy.startFrame}\\,${strategy.endFrame})`;
  if (strategy.startFrame !== undefined) return `gte(n\\,${strategy.startFrame})`;
  if (strategy.endFrame !== undefined) return `lte(n\\,${strategy.endFrame})`;
  return null;
}

export function videoExtractionFilter(strategy: VideoExtractionOptions) {
  const bounds = frameBoundsFilter(strategy);
  if (strategy.type === 'fps') {
    if (!Number.isFinite(strategy.fps) || Number(strategy.fps) <= 0) throw new Error('FPS must be greater than zero');
    return bounds ? `select=${bounds},fps=${strategy.fps}` : `fps=${strategy.fps}`;
  }
  if (strategy.type === 'interval_ms') {
    if (!Number.isFinite(strategy.intervalMs) || Number(strategy.intervalMs) <= 0) throw new Error('Frame interval must be greater than zero');
    return bounds ? `select=${bounds},fps=${1000 / Number(strategy.intervalMs)}` : `fps=${1000 / Number(strategy.intervalMs)}`;
  }
  if (strategy.type === 'frame_step') {
    if (!Number.isInteger(strategy.frameStep) || Number(strategy.frameStep) <= 0) throw new Error('Frame step must be greater than zero');
    const selector = `not(mod(n\\,${strategy.frameStep}))`;
    return `select=${bounds ? `${selector}*${bounds}` : selector}`;
  }
  const selector = 'eq(pict_type\\,I)';
  return `select=${bounds ? `${selector}*${bounds}` : selector}`;
}

export async function describeImageFile(filePath: string, relativePath: string, order: number, extra: Partial<ProcessedMediaFile> = {}): Promise<ProcessedMediaFile> {
  const buffer = await readFile(filePath);
  const dimensions = imageSize(buffer);
  const extension = path.extname(relativePath).toLowerCase();
  return { filePath, relativePath, filename: path.basename(relativePath), mimeType: imageExtensions.get(extension) ?? 'image/jpeg', sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), width: dimensions.width, height: dimensions.height, order, ...extra };
}

export async function extractArchiveImages(inputPath: string, outputDir: string, limits = { maxFiles: 100_000, maxBytes: 20 * 1024 * 1024 * 1024, maxDepth: 20 }): Promise<ProcessedMediaFiles> {
  const zip = path.extname(inputPath).toLowerCase() === '.zip';
  const listing = await run(zip ? 'unzip' : 'tar', zip ? ['-Z1', inputPath] : ['-tf', inputPath]);
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length > limits.maxFiles) throw new Error(`Archive contains more than ${limits.maxFiles} entries`);
  const normalized = entries.map((archiveEntry) => ({ archiveEntry, relativePath: safeArchiveRelativePath(archiveEntry) }));
  if (normalized.some(({ relativePath }) => relativePath === null)) throw new Error('Archive contains an unsafe path');
  const accepted = normalized.filter((entry): entry is { archiveEntry: string; relativePath: string } => Boolean(entry.relativePath)).filter(({ relativePath }) => imageExtensions.has(path.extname(relativePath).toLowerCase()));
  if (accepted.some(({ relativePath }) => relativePath.split('/').length > limits.maxDepth)) throw new Error('Archive path depth limit exceeded');
  let totalBytes = 0;
  const files: ProcessedMediaFile[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const [index, { archiveEntry, relativePath }] of accepted.entries()) {
    const outputPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const command = zip ? ['unzip', ['-p', inputPath, archiveEntry]] as const : ['tar', ['-xOf', inputPath, archiveEntry]] as const;
    const content = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(command[0], command[1]); const chunks: Buffer[] = []; const errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk)); child.stderr.on('data', (chunk: Buffer) => errors.push(chunk)); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(Buffer.concat(errors).toString())));
    });
    totalBytes += content.length;
    if (totalBytes > limits.maxBytes) throw new Error('Archive extracted size limit exceeded');
    await writeFile(outputPath, content);
    try {
      const described = await describeImageFile(outputPath, relativePath, index + 1);
      const identity = `${described.sha256}:${relativePath}`;
      if (seen.has(identity)) {
        await unlink(outputPath).catch(() => undefined);
        skipped.push(`${relativePath}: duplicate content and relative path skipped`);
      } else {
        seen.add(identity);
        files.push(described);
      }
    } catch (error) { errors.push(`${relativePath}: ${error instanceof Error ? error.message : 'invalid image'}`); }
  }
  Object.defineProperty(files, 'errors', { value: errors, enumerable: true });
  Object.defineProperty(files, 'skipped', { value: skipped, enumerable: true });
  return files;
}

export async function extractVideoFrames(inputPath: string, outputDir: string, strategy: VideoExtractionOptions) {
  await mkdir(outputDir, { recursive: true });
  const filter = videoExtractionFilter(strategy);
  const metadata = parseVideoFrameMetadata(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=key_frame,best_effort_timestamp_time,pkt_dts_time', '-of', 'json', inputPath]));
  const imageQuality = Math.min(100, Math.max(1, strategy.imageQuality ?? 95));
  const qscale = Math.min(31, Math.max(2, Math.round(31 - imageQuality * 0.29)));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vf', filter, ...(['keyframe', 'frame_step'].includes(strategy.type) ? ['-vsync', 'vfr'] : []), '-q:v', String(qscale), path.join(outputDir, '%09d.jpg')]);
  const names = (await readdir(outputDir)).filter((name) => name.endsWith('.jpg')).sort();
  const boundedMetadata = metadata.filter((frame) => {
    const zeroBasedFrame = frame.frameNumber - 1;
    return (strategy.startFrame === undefined || zeroBasedFrame >= strategy.startFrame) && (strategy.endFrame === undefined || zeroBasedFrame <= strategy.endFrame);
  });
  const selectedMetadata = strategy.type === 'keyframe'
    ? boundedMetadata.filter((frame) => frame.keyframe)
    : strategy.type === 'frame_step'
      ? boundedMetadata.filter((frame) => (frame.frameNumber - 1) % Number(strategy.frameStep) === 0)
      : undefined;
  return Promise.all(names.map((name, index) => {
    const probed = selectedMetadata?.[index];
    return describeImageFile(path.join(outputDir, name), name, index + 1, {
      frameNumber: probed?.frameNumber ?? index + 1,
      timestampMs: probed?.timestampMs ?? (strategy.type === 'fps' ? Math.round(index * 1000 / Number(strategy.fps)) : strategy.type === 'interval_ms' ? index * Number(strategy.intervalMs) : undefined),
    });
  }));
}

export async function createThumbnail(inputPath: string, outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vf', 'scale=320:-2', '-frames:v', '1', outputPath]);
  return stat(outputPath);
}
