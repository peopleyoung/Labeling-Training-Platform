import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export interface StorageRemovalSummary {
  releasedBytes: number;
  removedFiles: number;
  removedDirectories: number;
}

export interface ManagedStorageReferences {
  datasets: ReadonlySet<string>;
  exports: ReadonlySet<string>;
  training: ReadonlySet<string>;
  conversions: ReadonlySet<string>;
  models: ReadonlySet<string>;
  activeTraining: ReadonlySet<string>;
}

const directCategories = new Set(['datasets', 'exports', 'training', 'conversions', 'models']);
const legacyDirectoryPattern = /^(?:dataset|export|train|convert|model)-[a-zA-Z0-9-]+$/;

function assertManagedRelativeDirectory(relativeDirectory: string) {
  const normalized = path.posix.normalize(relativeDirectory.replaceAll('\\', '/'));
  const parts = normalized.split('/');
  const validDirect = parts.length === 2 && directCategories.has(parts[0]) && Boolean(parts[1]) && parts[1] !== '.' && parts[1] !== '..';
  const validRuntime = parts.length === 3 && parts[0] === 'runtime' && parts[1] === 'training' && Boolean(parts[2]) && parts[2] !== '.' && parts[2] !== '..';
  const validLegacy = parts.length === 1 && legacyDirectoryPattern.test(parts[0]);
  if (normalized !== relativeDirectory.replaceAll('\\', '/') || (!validDirect && !validRuntime && !validLegacy)) {
    throw new Error(`Refusing to remove unmanaged artifact directory: ${relativeDirectory}`);
  }
  return normalized;
}

async function measurePath(target: string): Promise<{ bytes: number; files: number; directories: number }> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, files: 0, directories: 0 };
    throw error;
  }
  if (!info.isDirectory()) return { bytes: info.size, files: 1, directories: 0 };
  const entries = await readdir(target, { withFileTypes: true });
  const totals = { bytes: 0, files: 0, directories: 1 };
  for (const entry of entries) {
    const measured = await measurePath(path.join(target, entry.name));
    totals.bytes += measured.bytes;
    totals.files += measured.files;
    totals.directories += measured.directories;
  }
  return totals;
}

export async function removeManagedArtifactDirectories(artifactRoot: string, relativeDirectories: readonly string[]): Promise<StorageRemovalSummary> {
  const uniqueDirectories = [...new Set(relativeDirectories.map(assertManagedRelativeDirectory))];
  const summary: StorageRemovalSummary = { releasedBytes: 0, removedFiles: 0, removedDirectories: 0 };
  for (const relativeDirectory of uniqueDirectories) {
    const target = path.resolve(artifactRoot, relativeDirectory);
    const relativeToRoot = path.relative(path.resolve(artifactRoot), target);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) throw new Error(`Artifact path escaped the storage root: ${relativeDirectory}`);
    const measured = await measurePath(target);
    await rm(target, { recursive: true, force: true });
    summary.releasedBytes += measured.bytes;
    summary.removedFiles += measured.files;
    summary.removedDirectories += measured.directories;
  }
  return summary;
}

async function directoryNames(target: string) {
  try {
    return (await readdir(target, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function findOrphanManagedArtifactDirectories(artifactRoot: string, references: ManagedStorageReferences): Promise<string[]> {
  const candidates: string[] = [];
  for (const category of directCategories) {
    const referenced = references[category as keyof Pick<ManagedStorageReferences, 'datasets' | 'exports' | 'training' | 'conversions' | 'models'>];
    for (const id of await directoryNames(path.join(artifactRoot, category))) {
      if (!referenced.has(id)) candidates.push(`${category}/${id}`);
    }
  }
  for (const id of await directoryNames(path.join(artifactRoot, 'runtime', 'training'))) {
    if (!references.activeTraining.has(id)) candidates.push(`runtime/training/${id}`);
  }
  for (const directory of await directoryNames(artifactRoot)) {
    if (!directCategories.has(directory) && directory !== 'runtime' && legacyDirectoryPattern.test(directory)) candidates.push(directory);
  }
  return candidates.sort();
}

export async function removeManagedArtifactFiles(artifactRoot: string, objectKeys: readonly string[]): Promise<StorageRemovalSummary> {
  const root = path.resolve(artifactRoot);
  const summary: StorageRemovalSummary = { releasedBytes: 0, removedFiles: 0, removedDirectories: 0 };
  for (const objectKey of [...new Set(objectKeys)]) {
    const normalized = path.posix.normalize(objectKey.replaceAll('\\', '/'));
    const parts = normalized.split('/');
    if (normalized !== objectKey.replaceAll('\\', '/') || parts.length < 3 || !directCategories.has(parts[0])) throw new Error(`Refusing to remove unmanaged artifact file: ${objectKey}`);
    const target = path.resolve(root, normalized);
    const relativeToRoot = path.relative(root, target);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) throw new Error(`Artifact path escaped the storage root: ${objectKey}`);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isDirectory()) throw new Error(`Refusing to remove a directory through the artifact file cleanup: ${objectKey}`);
    await rm(target, { force: true });
    summary.releasedBytes += info.size;
    summary.removedFiles += 1;
  }
  return summary;
}

export async function measureManagedArtifactDirectories(artifactRoot: string, relativeDirectories: readonly string[]) {
  const details = [];
  for (const relativeDirectory of [...new Set(relativeDirectories.map(assertManagedRelativeDirectory))]) {
    const measured = await measurePath(path.resolve(artifactRoot, relativeDirectory));
    details.push({ relativeDirectory, ...measured });
  }
  return details;
}
