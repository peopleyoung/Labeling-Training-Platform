export interface TrainingMetricInput {
  epoch: number;
  metrics: Record<string, number>;
}

const yoloMetricNames: Record<string, string> = {
  'train/box_loss': 'trainBoxLoss',
  'train/cls_loss': 'trainClassLoss',
  'train/dfl_loss': 'trainDflLoss',
  'metrics/precision(B)': 'precision',
  'metrics/recall(B)': 'recall',
  'metrics/mAP50(B)': 'mAP50',
  'metrics/mAP50-95(B)': 'mAP50_95',
  'metrics/precision(M)': 'precision',
  'metrics/recall(M)': 'recall',
  'metrics/mAP50(M)': 'mAP50',
  'metrics/mAP50-95(M)': 'mAP50_95',
  'metrics/precision(P)': 'precision',
  'metrics/recall(P)': 'recall',
  'metrics/mAP50(P)': 'mAP50',
  'metrics/mAP50-95(P)': 'mAP50_95',
  'val/box_loss': 'valBoxLoss',
  'val/cls_loss': 'valClassLoss',
  'val/dfl_loss': 'valDflLoss',
  'train/seg_loss': 'trainSegLoss',
  'train/pose_loss': 'trainPoseLoss',
  'train/kobj_loss': 'trainKeypointObjectLoss',
  'val/seg_loss': 'valSegLoss',
  'val/pose_loss': 'valPoseLoss',
  'val/kobj_loss': 'valKeypointObjectLoss',
  'lr/pg0': 'learningRate',
};

export function parseYoloResultsCsv(csv: string): TrainingMetricInput[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((value) => value.trim());
  return lines.slice(1).flatMap((line) => {
    const values = line.split(',').map((value) => value.trim());
    const epochIndex = headers.findIndex((header) => header === 'epoch');
    const epoch = Number(values[epochIndex]);
    if (!Number.isInteger(epoch) || epoch < 1) return [];
    const metrics: Record<string, number> = {};
    headers.forEach((header, index) => {
      const name = yoloMetricNames[header];
      const value = Number(values[index]);
      if (name && Number.isFinite(value)) metrics[name] = value;
    });
    return Object.keys(metrics).length ? [{ epoch, metrics }] : [];
  });
}

export interface RunnerEvent {
  event: string;
  stage?: string;
  epoch?: number;
  step?: number;
  progress?: number;
  device?: 'cpu' | 'gpu';
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  gpuPercent?: number;
  gpuMemoryUsedMb?: number;
  gpuMemoryTotalMb?: number;
  gpuPowerWatts?: number;
  [key: string]: unknown;
}

export function parseRunnerEvent(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const value = JSON.parse(trimmed) as RunnerEvent;
    return typeof value.event === 'string' ? value : null;
  } catch {
    return null;
  }
}

const structuredMetricKeys = ['loss', 'mIoU', 'oks', 'precision', 'recall', 'mAP50', 'mAP50_95', 'learningRate'] as const;

export function metricsFromRunnerEvent(event: RunnerEvent): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of structuredMetricKeys) {
    const value = Number(event[key]);
    if (Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}
