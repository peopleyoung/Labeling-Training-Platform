import { isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkerArtifactCategory = 'exports' | 'training' | 'conversions';

export function artifactTaskDirectory(root: string, category: WorkerArtifactCategory, taskId: string) {
  return resolve(root, category, taskId);
}

export function artifactObjectKey(root: string, filePath: string) {
  const relativePath = relative(resolve(root), resolve(filePath));
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Artifact file must be located inside the configured artifact root');
  }
  return relativePath.split(sep).join('/');
}
