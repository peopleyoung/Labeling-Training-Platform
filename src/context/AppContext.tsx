import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClient, ApiClientError, apiEnabled } from '../services/apiClient';
import type { AnnotationDocument, AnnotationImageAttributes, AnnotationRecord, AnnotationReviewDecisionInput, AnnotationReviewSummary, AuthUser, ConversionFormat, ConversionTask, Dataset, DatasetImage, ExportTask, ImageCaption, ModelVersion, RuntimeCapabilities, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability } from '../types';

interface ToastMessage { id: number; title: string; message: string; tone: 'success' | 'info' | 'error'; }
interface Session { accessToken: string; user: AuthUser; }

interface AppContextValue {
  datasets: Dataset[];
  jobs: TrainingJob[];
  models: ModelVersion[];
  conversions: ConversionTask[];
  exports: ExportTask[];
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
  uploadModel: (input: { name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; file: File }) => Promise<ModelVersion>;
  updateModelStage: (modelId: string, stage: ModelVersion['stage']) => Promise<void>;
  createDataset: (input: { name: string; description: string; version: string; classes: string[] }) => Promise<Dataset>;
  uploadDatasetImages: (datasetId: string, files: File[], split?: DatasetImage['split']) => Promise<DatasetImage[]>;
  datasetImages: (datasetId: string) => Promise<DatasetImage[]>;
  datasetImagePreview: (datasetId: string, imageId: string) => Promise<string>;
  updateDatasetClasses: (datasetId: string, classes: string[]) => Promise<Dataset>;
  deleteDataset: (datasetId: string) => Promise<void>;
  createDatasetExport: (datasetId: string, input: { format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean }) => Promise<string>;
  loadDatasetExports: (datasetId: string) => Promise<ExportTask[]>;
  downloadArtifact: (artifactId: string) => Promise<void>;
  loadAnnotationDocument: (datasetId: string, imageId: string) => Promise<AnnotationDocument>;
  saveAnnotationDocument: (input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationRecord[]; captions?: ImageCaption[]; imageAttributes?: AnnotationImageAttributes }) => Promise<AnnotationDocument>;
  loadAnnotationReview: (datasetId: string) => Promise<AnnotationReviewSummary>;
  submitAnnotationReview: (datasetId: string) => Promise<AnnotationReviewSummary>;
  decideAnnotationReview: (datasetId: string, input: AnnotationReviewDecisionInput) => Promise<AnnotationReviewSummary>;
  notify: (title: string, message: string, tone?: ToastMessage['tone']) => void;
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const sessionStorageKey = 'forge-ai-session';
const annotationKey = (datasetId: string, imageId: string) => `${datasetId}:${imageId}`;

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
  const [annotationDocuments, setAnnotationDocuments] = useState<Record<string, AnnotationDocument>>({});
  const annotationDocumentsRef = useRef(annotationDocuments);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [cpuTrainingEnabled, setCpuTrainingEnabled] = useState(!apiEnabled);
  const [cpuOnnxEnabled, setCpuOnnxEnabled] = useState(!apiEnabled);
  const [cpuConversionFormats, setCpuConversionFormats] = useState<ConversionFormat[]>(apiEnabled ? [] : ['ONNX', 'TorchScript', 'OpenVINO']);
  const [session, setSession] = useState<Session | null>(() => apiEnabled ? readSession() : null);
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
    setSession(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await client.login(username, password);
    const nextSession = { accessToken: result.accessToken, user: result.user };
    window.localStorage.setItem(sessionStorageKey, JSON.stringify(nextSession));
    setSession(nextSession);
  }, [client]);

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
    Promise.all([client.datasets(), client.trainingJobs(), client.models(), client.conversions()]).then(([dataset, training, model, conversion]) => {
      setDatasets(dataset.items);
      setJobs(training.items);
      setModels(model.items);
      setConversions(conversion.items);
    }).catch((error: unknown) => {
      if (error instanceof ApiClientError && error.code === 'UNAUTHORIZED') logout();
      else notify('数据同步失败', error instanceof Error ? error.message : '无法连接到平台服务', 'error');
    });
  }, [client, logout, notify, session]);

  useEffect(() => {
    if (!apiEnabled || !session) return;
    const refresh = () => {
      void Promise.all([client.trainingJobs(), client.models(), client.conversions()]).then(([training, model, conversion]) => {
        setJobs(training.items);
        setModels(model.items);
        setConversions(conversion.items);
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
    await client.deleteTrainingJob(jobId);
    setJobs((current) => current.filter((item) => item.id !== jobId));
    notify('训练任务已删除', '任务历史、日志、指标和资源采样已移除');
  }, [client, notify]);

  const trainingEvents = useCallback(async (jobId: string) => apiEnabled ? (await client.trainingEvents(jobId)).items : [], [client]);
  const trainingObservability = useCallback(async (jobId: string) => apiEnabled ? client.trainingObservability(jobId) : { metrics: [], resources: [] }, [client]);

  const createDataset = useCallback(async (input: { name: string; description: string; version: string; classes: string[] }) => {
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

  const deleteDataset = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    await client.deleteDataset(datasetId);
    setDatasets((current) => current.filter((item) => item.id !== datasetId));
    notify('数据集已删除', '数据集元数据已移除');
  }, [client, notify]);

  const createDatasetExport = useCallback(async (datasetId: string, input: { format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean }) => {
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
      const refreshed = await client.datasets();
      setDatasets(refreshed.items);
      return document;
    }
    const key = annotationKey(input.datasetId, input.imageId);
    const current = annotationDocumentsRef.current[key] ?? emptyAnnotationDocument(input.datasetId, input.imageId);
    if (current.revision !== input.revision) throw new ApiClientError('ANNOTATION_REVISION_CONFLICT', '标注已被其他用户更新，请重新加载后再保存');
    if (current.reviewStatus === 'submitted') throw new ApiClientError('ANNOTATION_REVIEW_LOCKED', '标注已提交审核，审核完成前不能修改');
    const document: AnnotationDocument = { ...current, revision: current.revision + 1, annotations: structuredClone(input.annotations), captions: structuredClone(input.captions ?? current.captions), imageAttributes: structuredClone(input.imageAttributes ?? current.imageAttributes), updatedAt: new Date().toISOString(), updatedBy: session?.user.id ?? 'demo-annotator', reviewStatus: 'draft', submittedAt: undefined, submittedBy: undefined, reviewedAt: undefined, reviewedBy: undefined, reviewComment: undefined };
    storeAnnotationDocument(document);
    return document;
  }, [client, session, storeAnnotationDocument]);

  const loadAnnotationReview = useCallback(async (datasetId: string) => {
    if (!apiEnabled) throw new ApiClientError('API_DISABLED', '当前环境未连接平台服务');
    return client.annotationReview(datasetId);
  }, [client]);

  const refreshDatasets = useCallback(async () => {
    if (!apiEnabled) return;
    const refreshed = await client.datasets();
    setDatasets(refreshed.items);
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

  const value = useMemo(() => ({ datasets, jobs, models, conversions, exports, toasts, session, apiEnabled, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, cpuConversionFormats, login, logout, createTrainingJob, retryTrainingJob, cancelTrainingJob, deleteTrainingJob, trainingEvents, trainingObservability, createConversion, cancelConversion, uploadModel, updateModelStage, createDataset, uploadDatasetImages, datasetImages, datasetImagePreview, updateDatasetClasses, deleteDataset, createDatasetExport, loadDatasetExports, downloadArtifact, loadAnnotationDocument, saveAnnotationDocument, loadAnnotationReview, submitAnnotationReview, decideAnnotationReview, notify, dismissToast }), [datasets, jobs, models, conversions, exports, toasts, session, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, cpuConversionFormats, login, logout, createTrainingJob, retryTrainingJob, cancelTrainingJob, deleteTrainingJob, trainingEvents, trainingObservability, createConversion, cancelConversion, uploadModel, updateModelStage, createDataset, uploadDatasetImages, datasetImages, datasetImagePreview, updateDatasetClasses, deleteDataset, createDatasetExport, loadDatasetExports, downloadArtifact, loadAnnotationDocument, saveAnnotationDocument, loadAnnotationReview, submitAnnotationReview, decideAnnotationReview, notify, dismissToast]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
