import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClient, ApiClientError, apiEnabled } from '../services/apiClient';
import { effectiveUserRoles } from '../../shared/contracts';
import { inferSourceAssetUpload } from '../utils/uploadMetadata';
import type { AnnotationDocument, AnnotationImageAttributes, AnnotationJob, AnnotationRecord, AnnotationReviewDecisionInput, AnnotationReviewSummary, AnnotationSegment, AnnotationStatistics, AnnotationTask, AuthUser, ConversionFormat, ConversionTask, Dataset, DatasetDeletionPreview, DatasetImage, DatasetLabel, DatasetProcessingConfig, ExportTask, ImageCaption, ModelVersion, ProcessingRun, ResourceDeletionResult, RuntimeCapabilities, SourceAsset, SystemSettings, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability, UploadSession, WorkspaceActivity } from '../types';

interface ToastMessage { id: number; title: string; message: string; tone: 'success' | 'info' | 'error'; }
interface Session { accessToken: string; user: AuthUser; }

interface AppContextValue {
  datasets: Dataset[];
  jobs: TrainingJob[];
  models: ModelVersion[];
  conversions: ConversionTask[];
  exports: ExportTask[];
  activities: WorkspaceActivity[];
  annotationStatistics: AnnotationStatistics | null;
  toasts: ToastMessage[];
  session: Session | null;
  apiEnabled: boolean;
  gpuEnabled: boolean;
  cpuTrainingEnabled: boolean;
  cpuOnnxEnabled: boolean;
  cpuConversionFormats: ConversionFormat[];
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  createTrainingJob: (draft: TrainingDraft, datasetName: string) => Promise<string>;
  retryTrainingJob: (jobId: string) => Promise<string>;
  cancelTrainingJob: (jobId: string) => Promise<void>;
  deleteTrainingJob: (jobId: string) => Promise<void>;
  trainingEvents: (jobId: string) => Promise<TrainingEvent[]>;
  trainingObservability: (jobId: string) => Promise<TrainingObservability>;
  createConversion: (input: { modelName: string; modelVersion: string; format: ConversionFormat; precision: string; target: string; options: Record<string, string | boolean> }) => Promise<string>;
  cancelConversion: (conversionId: string) => Promise<void>;
  deleteConversion: (conversionId: string) => Promise<void>;
  uploadModel: (input: { name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; file: File }) => Promise<ModelVersion>;
  updateModelStage: (modelId: string, stage: ModelVersion['stage']) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  createDataset: (input: { name: string; description: string; version: string; classes: string[]; labels?: DatasetLabel[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig: DatasetProcessingConfig }) => Promise<Dataset>;
  uploadDatasetImages: (datasetId: string, files: File[], split?: DatasetImage['split']) => Promise<DatasetImage[]>;
  uploadDatasetAssets: (datasetId: string, files: File[], onProgress?: (completed: number, total: number) => void) => Promise<SourceAsset[]>;
  datasetAssets: (datasetId: string) => Promise<SourceAsset[]>;
  downloadSourceAsset: (asset: SourceAsset) => Promise<void>;
  uploadSessions: (datasetId: string) => Promise<UploadSession[]>;
  cancelUploadSession: (sessionId: string) => Promise<void>;
  processingRuns: (datasetId: string) => Promise<ProcessingRun[]>;
  startDatasetProcessing: (datasetId: string, input: DatasetProcessingConfig) => Promise<ProcessingRun>;
  annotationTask: (datasetId: string) => Promise<AnnotationTask | null>;
  pauseAnnotationTask: (datasetId: string, reason: string) => Promise<AnnotationTask>;
  resumeAnnotationTask: (datasetId: string) => Promise<AnnotationTask>;
  openAnnotationTask: (datasetId: string) => Promise<AnnotationTask>;
  annotationJobs: (datasetId: string) => Promise<AnnotationJob[]>;
  annotationSegments: (datasetId: string) => Promise<AnnotationSegment[]>;
  claimNextAnnotationJob: (datasetId: string) => Promise<AnnotationJob>;
  claimAnnotationReviewJob: (jobId: string) => Promise<AnnotationJob>;
  claimNextAnnotationReviewJob: (datasetId: string) => Promise<AnnotationJob>;
  submitAnnotationJob: (jobId: string) => Promise<AnnotationJob>;
  reviewAnnotationJob: (jobId: string, input: { decision: 'approve' | 'reject'; comment?: string }) => Promise<AnnotationJob>;
  reviewAnnotationJobs: (datasetId: string, input: { jobIds: string[]; decision: 'approve' | 'reject'; comment?: string }) => Promise<{ items: AnnotationJob[]; requested: number }>;
  reopenAnnotationJob: (jobId: string, reason: string) => Promise<AnnotationJob>;
  saveReviewedAnnotation: (jobId: string, imageId: string, input: Pick<AnnotationDocument, 'revision' | 'annotations' | 'captions' | 'imageAttributes'>) => Promise<AnnotationDocument>;
  updateAnnotationJob: (jobId: string, input: { status?: AnnotationJob['status']; assigneeId?: string | null; reviewComment?: string }) => Promise<AnnotationJob>;
  releaseAnnotationJob: (jobId: string, reason: string) => Promise<AnnotationJob>;
  reassignAnnotationJob: (jobId: string, assigneeId: string, reason: string) => Promise<AnnotationJob>;
  datasetImages: (datasetId: string) => Promise<DatasetImage[]>;
  datasetImagePreview: (datasetId: string, imageId: string) => Promise<string>;
  updateDatasetClasses: (datasetId: string, classes: string[]) => Promise<Dataset>;
  updateDatasetLabels: (datasetId: string, labels: DatasetLabel[]) => Promise<Dataset>;
  deleteDataset: (datasetId: string) => Promise<void>;
  datasetDeletionPreview: (datasetId: string) => Promise<DatasetDeletionPreview>;
  createDatasetExport: (datasetId: string, input: { format: ExportTask['format']; versionName: string; includeImages: boolean }) => Promise<string>;
  loadDatasetExports: (datasetId: string) => Promise<ExportTask[]>;
  downloadArtifact: (artifactId: string) => Promise<void>;
  loadAnnotationDocument: (datasetId: string, imageId: string) => Promise<AnnotationDocument>;
  saveAnnotationDocument: (input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationRecord[]; captions?: ImageCaption[]; imageAttributes?: AnnotationImageAttributes }) => Promise<AnnotationDocument>;
  loadAnnotationReview: (datasetId: string) => Promise<AnnotationReviewSummary>;
  submitAnnotationReview: (datasetId: string) => Promise<AnnotationReviewSummary>;
  decideAnnotationReview: (datasetId: string, input: AnnotationReviewDecisionInput) => Promise<AnnotationReviewSummary>;
  notify: (title: string, message: string, tone?: ToastMessage['tone']) => void;
  dismissToast: (id: number) => void;
  users: AuthUser[];
  settings: SystemSettings | null;
  refreshAdminData: () => Promise<void>;
  refreshDatasets: () => Promise<void>;
  createUser: (input: { username: string; displayName: string; password: string; roles: string[] }) => Promise<AuthUser>;
  updateUser: (userId: string, input: { displayName?: string; roles?: string[]; enabled?: boolean; password?: string }) => Promise<AuthUser>;
  deleteUser: (userId: string) => Promise<void>;
  updateSettings: (input: Partial<SystemSettings>) => Promise<SystemSettings>;
}

const AppContext = createContext<AppContextValue | null>(null);
const sessionStorageKey = 'forge-ai-session';
const annotationKey = (datasetId: string, imageId: string) => `${datasetId}:${imageId}`;

function releasedStorageMessage(result: ResourceDeletionResult) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = result.releasedBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `已释放 ${unit === 0 ? value : value.toFixed(1)} ${units[unit]} 磁盘空间`;
}

function emptyAnnotationDocument(datasetId: string, imageId: string): AnnotationDocument {
  return { datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: new Date(0).toISOString(), updatedBy: '', reviewStatus: 'draft' };
}

function readSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(sessionStorageKey);
    return raw ? JSON.parse(raw) as Session : null;
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [conversions, setConversions] = useState<ConversionTask[]>([]);
  const [exports, setExports] = useState<ExportTask[]>([]);
  const [activities, setActivities] = useState<WorkspaceActivity[]>([]);
  const [annotationStatistics, setAnnotationStatistics] = useState<AnnotationStatistics | null>(null);
  const [annotationDocuments, setAnnotationDocuments] = useState<Record<string, AnnotationDocument>>({});
  const annotationDocumentsRef = useRef(annotationDocuments);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [cpuTrainingEnabled, setCpuTrainingEnabled] = useState(!apiEnabled);
  const [cpuOnnxEnabled, setCpuOnnxEnabled] = useState(!apiEnabled);
  const [cpuConversionFormats, setCpuConversionFormats] = useState<ConversionFormat[]>(apiEnabled ? [] : ['ONNX', 'TorchScript', 'OpenVINO']);
  const [session, setSession] = useState<Session | null>(() => apiEnabled ? readSession() : null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const client = useMemo(() => new ApiClient(() => sessionRef.current?.accessToken ?? null), []);

  const storeAnnotationDocument = useCallback((document: AnnotationDocument) => {
    const next = { ...annotationDocumentsRef.current, [annotationKey(document.datasetId, document.imageId)]: document };
    annotationDocumentsRef.current = next;
    setAnnotationDocuments(next);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback((title: string, message: string, tone: ToastMessage['tone'] = 'success') => {
    const id = Date.now();
    setToasts((current) => [...current, { id, title, message, tone }]);
    window.setTimeout(() => dismissToast(id), 4200);
  }, [dismissToast]);

  const logout = useCallback(() => {
    window.localStorage.removeItem(sessionStorageKey);
    setActivities([]);
    setSession(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await client.login(username, password);
    const nextSession = { accessToken: result.accessToken, user: result.user };
    window.localStorage.setItem(sessionStorageKey, JSON.stringify(nextSession));
    setSession(nextSession);
  }, [client]);
  const refreshAdminData = useCallback(async () => { const [userResult, settingResult] = await Promise.all([client.users(), client.settings()]); setUsers(userResult.items); setSettings(settingResult); }, [client]);
  const refreshDatasets = useCallback(async () => {
    if (!apiEnabled) return;
    const refreshed = await client.datasets();
    setDatasets(refreshed.items);
  }, [client]);
  const createUser = useCallback(async (input: { username: string; displayName: string; password: string; roles: string[] }) => { const user = await client.createUser(input); setUsers((current) => [...current, user]); return user; }, [client]);
  const updateUser = useCallback(async (userId: string, input: { displayName?: string; roles?: string[]; enabled?: boolean; password?: string }) => { const user = await client.updateUser(userId, input); setUsers((current) => current.map((item) => item.id === user.id ? user : item)); return user; }, [client]);
  const deleteUser = useCallback(async (userId: string) => { await client.deleteUser(userId); setUsers((current) => current.filter((item) => item.id !== userId)); }, [client]);
  const updateSettings = useCallback(async (input: Partial<SystemSettings>) => { const next = await client.updateSettings(input); setSettings(next); return next; }, [client]);

  useEffect(() => {
    if (!apiEnabled) return;
    client.capabilities().then((capabilities: RuntimeCapabilities) => {
      setGpuEnabled(capabilities.gpuEnabled);
      setCpuTrainingEnabled(capabilities.cpuTrainingEnabled);
      setCpuOnnxEnabled(capabilities.cpuOnnxEnabled);
      setCpuConversionFormats(capabilities.cpuConversionFormats);
    }).catch(() => {
      setGpuEnabled(false);
      setCpuTrainingEnabled(false);
      setCpuOnnxEnabled(false);
      setCpuConversionFormats([]);
    });
  }, [client]);

  useEffect(() => {
    if (!apiEnabled || !session) return;
    const roles = effectiveUserRoles(session.user);
    const operational = roles.includes('admin') || roles.includes('reviewer');
    const load = operational
      ? Promise.all([client.datasets(), client.trainingJobs(), client.models(), client.conversions(), client.activities(), client.annotationStatistics()]).then(([dataset, training, model, conversion, activity, statistics]) => {
        setDatasets(dataset.items);
        setJobs(training.items);
        setModels(model.items);
        setConversions(conversion.items);
        setActivities(activity.items);
        setAnnotationStatistics(statistics);
      })
      : Promise.all([client.datasets(), client.annotationStatistics()]).then(([dataset, statistics]) => {
        setDatasets(dataset.items);
        setJobs([]);
        setModels([]);
        setConversions([]);
        setActivities([]);
        setAnnotationStatistics(statistics);
      });
    load.catch((error: unknown) => {
      if (error instanceof ApiClientError && error.code === 'UNAUTHORIZED') logout();
      else notify('数据同步失败', error instanceof Error ? error.message : '无法连接到平台服务', 'error');
    });
  }, [client, logout, notify, session]);

  useEffect(() => {
    if (!apiEnabled || !session) return;
    const operational = effectiveUserRoles(session.user).some((role) => role === 'admin' || role === 'reviewer');
    const refresh = () => {
      if (!operational) return;
      void Promise.all([client.trainingJobs(), client.models(), client.conversions(), client.activities(), client.annotationStatistics()]).then(([training, model, conversion, activity, statistics]) => {
        setJobs(training.items);
        setModels(model.items);
        setConversions(conversion.items);
        setActivities(activity.items);
        setAnnotationStatistics(statistics);
      }).catch(() => undefined);
      const datasetIds = [...new Set(exports.map((task) => task.datasetId))];
      if (datasetIds.length) void Promise.all(datasetIds.map((datasetId) => client.datasetExports(datasetId))).then((results) => setExports(results.flatMap((result) => result.items))).catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [client, exports, session]);

  const createTrainingJob = useCallback(async (draft: TrainingDraft, datasetName: string) => {
    if (!gpuEnabled && !cpuTrainingEnabled) throw new ApiClientError('TRAINING_WORKER_UNAVAILABLE', '当前部署未启用可用的训练 Worker');
    if (apiEnabled) {
      const job = await client.createTrainingJob(draft);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      notify('训练任务已创建', `${job.name} 已进入资源队列`);
      return job.id;
    }
    const id = `train-${Date.now()}`;
    const metric = draft.type === 'segmentation' ? ['mIoU', '--'] : draft.type === 'keypoint' ? ['OKS', '--'] : draft.type === 'sdxl' ? ['Loss', '--'] : ['mAP@50', '--'];
    const job: TrainingJob = { id, name: draft.name, type: draft.type, model: draft.model, dataset: datasetName, status: 'queued', progress: 0, epoch: `0 / ${draft.epochs}`, metricName: metric[0], metricValue: metric[1], gpu: draft.gpu, createdAt: '刚刚', eta: '正在分配资源', config: structuredClone(draft) };
    setJobs((current) => [job, ...current]);
    notify('训练任务已创建', `${draft.name} 已进入资源队列`);
    return id;
  }, [client, cpuTrainingEnabled, gpuEnabled, notify]);

  const retryTrainingJob = useCallback(async (jobId: string) => {
    if (apiEnabled) {
      const job = await client.retryTrainingJob(jobId);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      notify('训练任务已重新提交', `${job.name} 已进入资源队列`);
      return job.id;
    }
    const sourceJob = jobs.find((item) => item.id === jobId);
    if (!sourceJob || sourceJob.status !== 'failed') throw new ApiClientError('TRAINING_RETRY_NOT_ALLOWED', '只有失败的训练任务可以重新训练');
    if (!sourceJob.config) throw new ApiClientError('TRAINING_CONFIG_UNAVAILABLE', '该历史任务没有保存完整训练配置，请新建训练任务');
    const name = sourceJob.name.endsWith('（重试）') ? sourceJob.name : `${sourceJob.name.slice(0, 116)}（重试）`;
    return createTrainingJob({ ...sourceJob.config, name }, sourceJob.dataset);
  }, [client, createTrainingJob, jobs, notify]);

  const cancelTrainingJob = useCallback(async (jobId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const job = await client.cancelTrainingJob(jobId);
    setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    notify('训练任务已取消', `${job.name} 已停止并释放队列资源`);
  }, [client, notify]);

  const deleteTrainingJob = useCallback(async (jobId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const derivedModels = models.filter((model) => model.sourceJob === jobId);
    const derivedModelKeys = new Set(derivedModels.map((model) => `${model.name}\u0000${model.version}`));
    const result = await client.deleteTrainingJob(jobId);
    setJobs((current) => current.filter((item) => item.id !== jobId));
    setModels((current) => current.filter((model) => model.sourceJob !== jobId));
    setConversions((current) => current.filter((task) => !derivedModelKeys.has(`${task.modelName}\u0000${task.modelVersion}`)));
    notify('训练任务及产物已删除', releasedStorageMessage(result));
  }, [client, models, notify]);

  const trainingEvents = useCallback(async (jobId: string) => apiEnabled ? (await client.trainingEvents(jobId)).items : [], [client]);
  const trainingObservability = useCallback(async (jobId: string) => apiEnabled ? client.trainingObservability(jobId) : { metrics: [], resources: [] }, [client]);

  const createDataset = useCallback(async (input: { name: string; description: string; version: string; classes: string[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig: DatasetProcessingConfig }) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const dataset = await client.createDataset(input);
    setDatasets((current) => [dataset, ...current]);
    notify('数据集已创建', `${dataset.name} 已创建，请继续上传图像`);
    return dataset;
  }, [client, notify]);

  const uploadDatasetImages = useCallback(async (datasetId: string, files: File[], split: DatasetImage['split'] = 'train') => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const uploaded: DatasetImage[] = [];
    for (const file of files) uploaded.push(await client.uploadDatasetImage(datasetId, file, split));
    const refreshed = await client.datasets();
    setDatasets(refreshed.items);
    notify('图像上传完成', `已上传 ${uploaded.length} 张图像`);
    return uploaded;
  }, [client, notify]);

  const uploadDatasetAssets = useCallback(async (datasetId: string, files: File[], onProgress?: (completed: number, total: number) => void) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    for (const file of files) {
      const { type, mimeType } = inferSourceAssetUpload(file);
      if (type === 'image') {
        await client.uploadDatasetImage(datasetId, file);
        completedBytes += file.size;
        onProgress?.(completedBytes, totalBytes);
        continue;
      }
      const existingSession = (await client.uploadSessions(datasetId)).items.find((item) => item.filename === file.name && item.sizeBytes === file.size && ['created', 'uploading', 'upload_failed'].includes(item.status));
      const session = existingSession ?? await client.createUploadSession(datasetId, { filename: file.name, mimeType, sizeBytes: file.size, type });
      const partSize = session.partSize;
      const completedParts = new Set(session.completedParts);
      for (const part of completedParts) completedBytes += Math.min(partSize, Math.max(0, file.size - (part - 1) * partSize));
      onProgress?.(completedBytes, totalBytes);
      for (let part = 1; part <= session.totalParts; part += 1) {
        if (completedParts.has(part)) continue;
        const chunk = file.slice((part - 1) * partSize, Math.min(file.size, part * partSize));
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await client.uploadPart(session.id, part, chunk);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError) throw lastError;
        completedBytes += chunk.size;
        onProgress?.(completedBytes, totalBytes);
      }
      await client.completeUpload(session.id);
    }
    const refreshed = await client.datasets();
    setDatasets(refreshed.items);
    notify('资源上传完成', `已上传 ${files.length} 个资源`);
    return (await client.datasetAssets(datasetId)).items;
  }, [client, notify]);

  const datasetAssets = useCallback(async (datasetId: string) => {
    if (!apiEnabled) return [];
    return (await client.datasetAssets(datasetId)).items;
  }, [client]);

  const uploadSessions = useCallback(async (datasetId: string) => apiEnabled ? (await client.uploadSessions(datasetId)).items : [], [client]);

  const cancelUploadSession = useCallback(async (sessionId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    await client.cancelUpload(sessionId);
    notify('上传会话已取消', '临时分片已清理');
  }, [client, notify]);

  const processingRuns = useCallback(async (datasetId: string) => apiEnabled ? (await client.processingRuns(datasetId)).items : [], [client]);

  const startDatasetProcessing = useCallback(async (datasetId: string, input: DatasetProcessingConfig) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const run = await client.startProcessing(datasetId, input);
    notify('媒体处理已开始', '资源已进入处理队列，可稍后查看处理状态');
    return run;
  }, [client, notify]);

  const annotationTask = useCallback(async (datasetId: string) => client.annotationTask(datasetId), [client]);
  const pauseAnnotationTask = useCallback(async (datasetId: string, reason: string) => client.pauseAnnotationTask(datasetId, reason), [client]);
  const resumeAnnotationTask = useCallback(async (datasetId: string) => client.resumeAnnotationTask(datasetId), [client]);
  const openAnnotationTask = useCallback(async (datasetId: string) => client.openAnnotationTask(datasetId), [client]);

  const annotationJobs = useCallback(async (datasetId: string) => apiEnabled ? (await client.annotationJobs(datasetId)).items : [], [client]);
  const annotationSegments = useCallback(async (datasetId: string) => apiEnabled ? (await client.annotationSegments(datasetId)).items : [], [client]);
  const claimNextAnnotationJob = useCallback(async (datasetId: string) => client.claimNextAnnotationJob(datasetId), [client]);
  const claimAnnotationReviewJob = useCallback(async (jobId: string) => client.claimAnnotationReviewJob(jobId), [client]);
  const claimNextAnnotationReviewJob = useCallback(async (datasetId: string) => client.claimNextAnnotationReviewJob(datasetId), [client]);
  const submitAnnotationJob = useCallback(async (jobId: string) => {
    const job = await client.submitAnnotationJob(jobId);
    await refreshDatasets().catch(() => undefined);
    return job;
  }, [client, refreshDatasets]);
  const reviewAnnotationJob = useCallback(async (jobId: string, input: { decision: 'approve' | 'reject'; comment?: string }) => {
    const job = await client.reviewAnnotationJob(jobId, input);
    await refreshDatasets().catch(() => undefined);
    return job;
  }, [client, refreshDatasets]);
  const reviewAnnotationJobs = useCallback(async (datasetId: string, input: { jobIds: string[]; decision: 'approve' | 'reject'; comment?: string }) => client.reviewAnnotationJobs(datasetId, input), [client]);
  const reopenAnnotationJob = useCallback(async (jobId: string, reason: string) => client.reopenAnnotationJob(jobId, reason), [client]);
  const saveReviewedAnnotation = useCallback(async (jobId: string, imageId: string, input: Pick<AnnotationDocument, 'revision' | 'annotations' | 'captions' | 'imageAttributes'>) => client.saveReviewedAnnotation(jobId, imageId, input), [client]);
  const updateAnnotationJob = useCallback(async (jobId: string, input: { status?: AnnotationJob['status']; assigneeId?: string | null; reviewComment?: string }) => client.updateAnnotationJob(jobId, input), [client]);

  const datasetImages = useCallback(async (datasetId: string) => {
    if (!apiEnabled) return [];
    return (await client.datasetImages(datasetId)).items;
  }, [client]);

  const datasetImagePreview = useCallback(async (datasetId: string, imageId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    return URL.createObjectURL(await client.datasetImageContent(datasetId, imageId));
  }, [client]);

  const updateDatasetClasses = useCallback(async (datasetId: string, classes: string[]) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const dataset = await client.updateDatasetClasses(datasetId, classes);
    setDatasets((current) => current.map((item) => item.id === dataset.id ? dataset : item));
    return dataset;
  }, [client]);

  const updateDatasetLabels = useCallback(async (datasetId: string, labels: DatasetLabel[]) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const dataset = await client.updateDatasetLabels(datasetId, labels);
    setDatasets((current) => current.map((item) => item.id === dataset.id ? dataset : item));
    return dataset;
  }, [client]);

  const deleteDataset = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const result = await client.deleteDataset(datasetId);
    setDatasets((current) => current.filter((item) => item.id !== datasetId));
    setExports((current) => current.filter((item) => item.datasetId !== datasetId));
    notify('数据集及产物已删除', releasedStorageMessage(result));
  }, [client, notify]);

  const releaseAnnotationJob = useCallback(async (jobId: string, reason: string) => client.releaseAnnotationJob(jobId, reason), [client]);
  const reassignAnnotationJob = useCallback(async (jobId: string, assigneeId: string, reason: string) => client.reassignAnnotationJob(jobId, assigneeId, reason), [client]);

  const datasetDeletionPreview = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    return client.datasetDeletionPreview(datasetId);
  }, [client]);

  const createDatasetExport = useCallback(async (datasetId: string, input: { format: ExportTask['format']; versionName: string; includeImages: boolean }) => {
    const dataset = datasets.find((item) => item.id === datasetId);
    if (apiEnabled) {
      const task = await client.createDatasetExport(datasetId, input);
      setExports((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      notify('导出任务已创建', `${dataset?.name ?? '数据集'} 已进入 ${task.format} 导出队列`);
      return task.id;
    }
    const id = `export-${Date.now()}`;
    notify('导出任务已创建', `${dataset?.name ?? '数据集'} 将生成 ${input.format} 导出包`);
    return id;
  }, [client, datasets, notify]);

  const loadDatasetExports = useCallback(async (datasetId: string) => {
    if (!apiEnabled) return [];
    const tasks = (await client.datasetExports(datasetId)).items;
    setExports((current) => [...tasks, ...current.filter((task) => task.datasetId !== datasetId)]);
    return tasks;
  }, [client]);

  const downloadArtifact = useCallback(async (artifactId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const [artifact, blob] = await Promise.all([client.artifact(artifactId), client.downloadArtifact(artifactId)]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('产物下载已开始', artifact.filename);
  }, [client, notify]);

  const downloadSourceAsset = useCallback(async (asset: SourceAsset) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const blob = await client.downloadSourceAsset(asset.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = asset.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('原始资源下载已开始', asset.filename);
  }, [client, notify]);

  const loadAnnotationDocument = useCallback(async (datasetId: string, imageId: string) => {
    if (apiEnabled) {
      const document = await client.annotations(datasetId, imageId);
      storeAnnotationDocument(document);
      return document;
    }
    return structuredClone(annotationDocumentsRef.current[annotationKey(datasetId, imageId)] ?? emptyAnnotationDocument(datasetId, imageId));
  }, [client, storeAnnotationDocument]);

  const saveAnnotationDocument = useCallback(async (input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationRecord[]; captions?: ImageCaption[]; imageAttributes?: AnnotationImageAttributes }) => {
    if (apiEnabled) {
      const document = await client.saveAnnotations(input.datasetId, input.imageId, { revision: input.revision, annotations: input.annotations, captions: input.captions, imageAttributes: input.imageAttributes });
      storeAnnotationDocument(document);
      void client.datasets().then((refreshed) => setDatasets(refreshed.items)).catch(() => undefined);
      return document;
    }
    const key = annotationKey(input.datasetId, input.imageId);
    const current = annotationDocumentsRef.current[key] ?? emptyAnnotationDocument(input.datasetId, input.imageId);
    if (current.revision !== input.revision) throw new ApiClientError('ANNOTATION_REVISION_CONFLICT', '标注已被其他用户更新，请重新加载后再保存');
    if (current.reviewStatus === 'submitted' || current.reviewStatus === 'approved') throw new ApiClientError('ANNOTATION_REVIEW_LOCKED', '标注已进入审核完成流程，当前不能修改');
    const document: AnnotationDocument = { ...current, revision: current.revision + 1, annotations: structuredClone(input.annotations), captions: structuredClone(input.captions ?? current.captions), imageAttributes: structuredClone(input.imageAttributes ?? current.imageAttributes), updatedAt: new Date().toISOString(), updatedBy: session?.user.id ?? 'demo-annotator', reviewStatus: 'draft', submittedAt: undefined, submittedBy: undefined, reviewedAt: undefined, reviewedBy: undefined, reviewComment: undefined };
    storeAnnotationDocument(document);
    return document;
  }, [client, session, storeAnnotationDocument]);

  const loadAnnotationReview = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    return client.annotationReview(datasetId);
  }, [client]);

  const submitAnnotationReview = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const summary = await client.submitAnnotationReview(datasetId);
    await refreshDatasets();
    return summary;
  }, [client, refreshDatasets]);

  const decideAnnotationReview = useCallback(async (datasetId: string, input: AnnotationReviewDecisionInput) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const summary = await client.decideAnnotationReview(datasetId, input);
    await refreshDatasets();
    return summary;
  }, [client, refreshDatasets]);

  const createConversion = useCallback(async (input: { modelName: string; modelVersion: string; format: ConversionFormat; precision: string; target: string; options: Record<string, string | boolean> }) => {
    if (!gpuEnabled && !cpuConversionFormats.includes(input.format)) throw new ApiClientError('CPU_CONVERSION_UNAVAILABLE', '当前 CPU Worker 不支持该转换格式');
    if (apiEnabled) {
      const task = await client.createConversion(input);
      setConversions((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      notify('转换任务已提交', `${input.format} 产物正在等待构建`);
      return task.id;
    }
    const id = `convert-${Date.now()}`;
    const task: ConversionTask = { id, ...input, status: 'queued', progress: 0, size: '计算中', createdAt: '刚刚' };
    setConversions((current) => [task, ...current]);
    notify('转换任务已提交', `${input.format} 产物正在等待构建`);
    return id;
  }, [client, cpuConversionFormats, gpuEnabled, notify]);

  const cancelConversion = useCallback(async (conversionId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const task = await client.cancelConversion(conversionId);
    setConversions((current) => current.map((item) => item.id === task.id ? task : item));
    notify('转换任务已取消', `${task.modelName} ${task.format} 已停止`);
  }, [client, notify]);

  const deleteConversion = useCallback(async (conversionId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const result = await client.deleteConversion(conversionId);
    setConversions((current) => current.filter((task) => task.id !== conversionId));
    notify('转换任务及产物已删除', releasedStorageMessage(result));
  }, [client, notify]);

  const uploadModel = useCallback(async (input: { name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; file: File }) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const model = await client.uploadModel(input);
    setModels((current) => [model, ...current.filter((item) => item.id !== model.id)]);
    notify('模型上传完成', `${model.name} ${model.version} 已登记`);
    return model;
  }, [client, notify]);

  const updateModelStage = useCallback(async (modelId: string, stage: ModelVersion['stage']) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const model = await client.updateModelStage(modelId, stage);
    setModels((current) => current.map((item) => item.id === model.id ? model : item));
    notify('模型阶段已更新', `${model.name} 已设为${stage}`);
  }, [client, notify]);

  const deleteModel = useCallback(async (modelId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    const deletedModel = models.find((model) => model.id === modelId);
    const result = await client.deleteModel(modelId);
    setModels((current) => current.filter((item) => item.id !== modelId));
    if (deletedModel) setConversions((current) => current.filter((task) => task.modelName !== deletedModel.name || task.modelVersion !== deletedModel.version));
    notify('模型及转换产物已删除', releasedStorageMessage(result));
  }, [client, models, notify]);

  const value = useMemo(() => ({ datasets, jobs, models, conversions, exports, activities, annotationStatistics, toasts, session, apiEnabled, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, cpuConversionFormats, login, logout, createTrainingJob, retryTrainingJob, cancelTrainingJob, deleteTrainingJob, trainingEvents, trainingObservability, createConversion, cancelConversion, deleteConversion, uploadModel, updateModelStage, deleteModel, createDataset, uploadDatasetImages, uploadDatasetAssets, datasetAssets, downloadSourceAsset, uploadSessions, cancelUploadSession, processingRuns, startDatasetProcessing, annotationTask, pauseAnnotationTask, resumeAnnotationTask, openAnnotationTask, annotationJobs, annotationSegments, claimNextAnnotationJob, claimAnnotationReviewJob, claimNextAnnotationReviewJob, submitAnnotationJob, reviewAnnotationJob, reviewAnnotationJobs, reopenAnnotationJob, saveReviewedAnnotation, updateAnnotationJob, releaseAnnotationJob, reassignAnnotationJob, datasetImages, datasetImagePreview, updateDatasetClasses, updateDatasetLabels, deleteDataset, datasetDeletionPreview, createDatasetExport, loadDatasetExports, downloadArtifact, loadAnnotationDocument, saveAnnotationDocument, loadAnnotationReview, submitAnnotationReview, decideAnnotationReview, notify, dismissToast, users, settings, refreshAdminData, refreshDatasets, createUser, updateUser, deleteUser, updateSettings }), [datasets, jobs, models, conversions, exports, activities, annotationStatistics, toasts, session, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, cpuConversionFormats, login, logout, createTrainingJob, retryTrainingJob, cancelTrainingJob, deleteTrainingJob, trainingEvents, trainingObservability, createConversion, cancelConversion, deleteConversion, uploadModel, updateModelStage, deleteModel, createDataset, uploadDatasetImages, uploadDatasetAssets, datasetAssets, downloadSourceAsset, uploadSessions, cancelUploadSession, processingRuns, startDatasetProcessing, annotationTask, pauseAnnotationTask, resumeAnnotationTask, openAnnotationTask, annotationJobs, annotationSegments, claimNextAnnotationJob, claimAnnotationReviewJob, claimNextAnnotationReviewJob, submitAnnotationJob, reviewAnnotationJob, reviewAnnotationJobs, reopenAnnotationJob, saveReviewedAnnotation, updateAnnotationJob, releaseAnnotationJob, reassignAnnotationJob, datasetImages, datasetImagePreview, updateDatasetClasses, updateDatasetLabels, deleteDataset, datasetDeletionPreview, createDatasetExport, loadDatasetExports, downloadArtifact, loadAnnotationDocument, saveAnnotationDocument, loadAnnotationReview, submitAnnotationReview, decideAnnotationReview, notify, dismissToast, users, settings, refreshAdminData, refreshDatasets, createUser, updateUser, deleteUser, updateSettings]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
