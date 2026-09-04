import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';

export type QueueTaskKind = 'export' | 'training' | 'conversion' | 'processing';
export type ExecutionTarget = 'cpu' | 'gpu';

export class QueueTaskActiveError extends Error {
  constructor() {
    super('队列任务仍在执行');
    this.name = 'QueueTaskActiveError';
  }
}

export function queueNameFor(kind: QueueTaskKind, executionTarget: ExecutionTarget = 'gpu') {
  if (kind === 'export') return 'forge-export';
  if (kind === 'processing') return 'forge-cpu';
  return executionTarget === 'cpu' ? 'forge-cpu' : 'forge-gpu';
}

export function queueJobId(kind: QueueTaskKind, taskId: string) {
  return `${kind}-${taskId}`;
}

export interface RemoveQueueTaskOptions {
  waitForActiveMs?: number;
}

export interface TaskQueue {
  enqueue(kind: QueueTaskKind, taskId: string, executionTarget?: ExecutionTarget): Promise<void>;
  remove(kind: QueueTaskKind, taskId: string, executionTarget?: ExecutionTarget, options?: RemoveQueueTaskOptions): Promise<void>;
  close(): Promise<void>;
}

export class MemoryTaskQueue implements TaskQueue {
  readonly tasks: Array<{ kind: QueueTaskKind; taskId: string; executionTarget: ExecutionTarget }> = [];
  async enqueue(kind: QueueTaskKind, taskId: string, executionTarget: ExecutionTarget = 'gpu') { this.tasks.push({ kind, taskId, executionTarget }); }
  async remove(kind: QueueTaskKind, taskId: string, executionTarget: ExecutionTarget = 'gpu', _options?: RemoveQueueTaskOptions) {
    const index = this.tasks.findIndex((task) => task.kind === kind && task.taskId === taskId && task.executionTarget === executionTarget);
    if (index >= 0) this.tasks.splice(index, 1);
  }
  async close() {}
}

export class BullTaskQueue implements TaskQueue {
  private readonly connection: IORedis;
  private readonly queues = new Map<string, Queue>();

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  async enqueue(kind: QueueTaskKind, taskId: string, executionTarget: ExecutionTarget = 'gpu') {
    const queueName = queueNameFor(kind, executionTarget);
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      this.queues.set(queueName, queue);
    }
    await queue.add(kind, { taskId }, { jobId: queueJobId(kind, taskId), removeOnComplete: 100, removeOnFail: 200 });
  }

  async remove(kind: QueueTaskKind, taskId: string, executionTarget: ExecutionTarget = 'gpu', options?: RemoveQueueTaskOptions) {
    const queueName = queueNameFor(kind, executionTarget);
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      this.queues.set(queueName, queue);
    }
    const job = await queue.getJob(queueJobId(kind, taskId));
    if (!job) return;
    const deadline = Date.now() + Math.max(0, options?.waitForActiveMs ?? 0);
    while (await job.getState() === 'active') {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueueTaskActiveError();
      await delay(Math.min(100, remaining));
    }
    await job.remove();
  }

  async close() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }
}

export function createTaskQueue(redisUrl?: string): TaskQueue {
  return redisUrl ? new BullTaskQueue(redisUrl) : new MemoryTaskQueue();
}
