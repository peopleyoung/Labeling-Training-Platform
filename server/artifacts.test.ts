import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactObjectKey, artifactTaskDirectory } from './artifacts';

describe('worker artifact paths', () => {
  it('keeps the registered object key aligned with the physical file path', () => {
    const root = '/data/artifacts';
    const directory = artifactTaskDirectory(root, 'exports', 'export-123');
    const filePath = resolve(directory, 'dataset-coco.json');
    const objectKey = artifactObjectKey(root, filePath);

    expect(directory).toBe('/data/artifacts/exports/export-123');
    expect(objectKey).toBe('exports/export-123/dataset-coco.json');
    expect(resolve(root, objectKey)).toBe(filePath);
  });

  it('rejects files outside the configured artifact root', () => {
    expect(() => artifactObjectKey('/data/artifacts', '/tmp/outside.pt')).toThrow(/inside/);
  });
});
