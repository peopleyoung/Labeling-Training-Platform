import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOrphanManagedArtifactDirectories, removeManagedArtifactDirectories, removeManagedArtifactFiles } from './artifactCleanup';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed artifact cleanup', () => {
  it('finds and removes only unreferenced managed directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-artifact-cleanup-'));
    temporaryRoots.push(root);
    const files = [
      ['datasets', 'dataset-keep', 'image.png'],
      ['datasets', 'dataset-orphan', 'image.png'],
      ['training', 'train-orphan', 'best.pt'],
      ['runtime', 'training', 'train-terminal', 'work.bin'],
      ['runtime', 'training', 'train-active', 'work.bin'],
    ];
    for (const parts of files) {
      const target = join(root, ...parts);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'artifact bytes');
    }

    const candidates = await findOrphanManagedArtifactDirectories(root, {
      datasets: new Set(['dataset-keep']),
      exports: new Set(),
      training: new Set(),
      conversions: new Set(),
      models: new Set(),
      activeTraining: new Set(['train-active']),
    });
    expect(candidates).toEqual(['datasets/dataset-orphan', 'runtime/training/train-terminal', 'training/train-orphan']);

    const result = await removeManagedArtifactDirectories(root, candidates);
    expect(result).toMatchObject({ removedFiles: 3, removedDirectories: 3 });
    expect(result.releasedBytes).toBeGreaterThan(0);
    await expect(stat(join(root, 'datasets', 'dataset-orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'training', 'train-orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(root, 'datasets', 'dataset-keep', 'image.png'))).isFile()).toBe(true);
    expect((await stat(join(root, 'runtime', 'training', 'train-active', 'work.bin'))).isFile()).toBe(true);
  });

  it('rejects paths outside managed storage and removes registered orphan files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-artifact-file-cleanup-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'exports', 'export-orphan'), { recursive: true });
    await writeFile(join(root, 'exports', 'export-orphan', 'dataset.zip'), 'zip bytes');

    await expect(removeManagedArtifactDirectories(root, ['../outside'])).rejects.toThrow('unmanaged artifact directory');
    await expect(removeManagedArtifactFiles(root, ['../outside.bin'])).rejects.toThrow('unmanaged artifact file');
    const result = await removeManagedArtifactFiles(root, ['exports/export-orphan/dataset.zip']);
    expect(result).toMatchObject({ removedFiles: 1, removedDirectories: 0 });
    await expect(stat(join(root, 'exports', 'export-orphan', 'dataset.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
