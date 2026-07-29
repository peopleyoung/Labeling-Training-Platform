import { describe, expect, it } from 'vitest';
import { MemoryTaskQueue, queueJobId, queueNameFor } from './queue';

describe('task queue identifiers', () => {
  it('routes CPU exports separately from GPU tasks', () => {
    expect(queueNameFor('export')).toBe('forge-export');
    expect(queueNameFor('training', 'cpu')).toBe('forge-cpu');
    expect(queueNameFor('conversion', 'cpu')).toBe('forge-cpu');
    expect(queueNameFor('training')).toBe('forge-gpu');
    expect(queueNameFor('conversion')).toBe('forge-gpu');
  });

  it('creates BullMQ-compatible custom job ids without colons', () => {
    expect(queueJobId('export', 'export-123')).toBe('export-export-123');
    expect(queueJobId('export', 'export-123')).not.toContain(':');
  });

  it('removes a queued task from the matching execution target', async () => {
    const queue = new MemoryTaskQueue();
    await queue.enqueue('training', 'train-123', 'cpu');
    await queue.enqueue('training', 'train-456', 'gpu');

    await queue.remove('training', 'train-123', 'cpu');

    expect(queue.tasks).toEqual([{ kind: 'training', taskId: 'train-456', executionTarget: 'gpu' }]);
  });
});
