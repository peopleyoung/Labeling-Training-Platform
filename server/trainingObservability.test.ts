import { describe, expect, it } from 'vitest';
import { metricsFromRunnerEvent, parseRunnerEvent, parseYoloResultsCsv } from './trainingObservability';

describe('training observability parsing', () => {
  it('maps Ultralytics CSV columns to stable metric keys', () => {
    const points = parseYoloResultsCsv([
      'epoch,train/box_loss,train/cls_loss,metrics/precision(B),metrics/recall(B),metrics/mAP50(B),metrics/mAP50-95(B),lr/pg0',
      '1,2.5,4.1,0.2,0.3,0.25,0.1,0.001',
      '2,2.1,3.8,0.4,0.5,0.45,0.2,0.0008',
    ].join('\n'));
    expect(points).toEqual([
      { epoch: 1, metrics: { trainBoxLoss: 2.5, trainClassLoss: 4.1, precision: 0.2, recall: 0.3, mAP50: 0.25, mAP50_95: 0.1, learningRate: 0.001 } },
      { epoch: 2, metrics: { trainBoxLoss: 2.1, trainClassLoss: 3.8, precision: 0.4, recall: 0.5, mAP50: 0.45, mAP50_95: 0.2, learningRate: 0.0008 } },
    ]);
  });

  it('maps segmentation and pose metrics from Ultralytics CSV output', () => {
    const points = parseYoloResultsCsv([
      'epoch,train/seg_loss,train/pose_loss,metrics/mAP50(M),metrics/mAP50(P),metrics/mAP50-95(M),metrics/mAP50-95(P)',
      '1,1.2,0.8,0.31,0.42,0.2,0.3',
    ].join('\n'));
    expect(points).toEqual([{ epoch: 1, metrics: { trainSegLoss: 1.2, trainPoseLoss: 0.8, mAP50: 0.42, mAP50_95: 0.3 } }]);
  });

  it('decodes structured progress and ignores framework output', () => {
    const event = parseRunnerEvent('{"event":"progress","epoch":2,"loss":0.42,"mIoU":0.6}');
    expect(event).toMatchObject({ event: 'progress', epoch: 2 });
    expect(metricsFromRunnerEvent(event!)).toEqual({ loss: 0.42, mIoU: 0.6 });
    expect(parseRunnerEvent('Epoch 2/20')).toBeNull();
  });
});
