import type { AnnotationDocument, AnnotationImageAttributes, AnnotationJob, AnnotationRecord, AnnotationReviewDecisionInput, AnnotationReviewSummary, AnnotationSegment, AnnotationStatistics, AnnotatorPerformance, AnnotatorPerformanceFilter, AnnotationTask, ApiErrorEnvelope, Artifact, AuthUser, ConversionTask, Dataset, DatasetDeletionPreview, DatasetImage, DatasetLabel, DatasetProcessingConfig, ExportTask, ImageCaption, LoginResponse, ModelVersion, ProcessingRun, ResourceDeletionResult, RuntimeCapabilities, SourceAsset, SystemSettings, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability, UploadSession, WorkspaceActivity } from '../../shared/contracts';
import { inferSourceAssetUpload } from '../utils/uploadMetadata';
import type { CatalogInput, DataCenterQuery, DataCenterResult, TaskCatalog, TaskCategory } from '../../shared/taskCatalog';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
export const apiEnabled = import.meta.env.VITE_API_ENABLED === 'true';

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class ApiClient {
  constructor(private readonly getToken: () => string | null) {}

  taskCatalog() { return this.request<TaskCatalog>('/task-categories'); }
  saveCatalog(kind: 'category' | 'task', id: string | null, input: Partial<CatalogInput>, categoryId?: string) {
    const path = kind === 'category' ? `/task-categories${id ? `/${encodeURIComponent(id)}` : ''}` : id ? `/task-types/${encodeURIComponent(id)}` : `/task-categories/${encodeURIComponent(categoryId ?? '')}/task-types`;
    return this.request<TaskCategory>(path, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(input) });
  }
  dataCenter(input: Partial<DataCenterQuery>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') query.set(key, String(value));
    return this.request<DataCenterResult>(`/data-center/tree?${query}`);
  }
  bindDataset(datasetId: string, taskTypeId: string, expectedTaskTypeId: string | null) {
    return this.request<Dataset>(`/datasets/${encodeURIComponent(datasetId)}/task-type`, { method: 'PATCH', body: JSON.stringify({ taskTypeId, expectedTaskTypeId, confirmed: true }) });
  }

  private async fetch(input: string, init?: RequestInit) {
    try {
      return await fetch(input, init);
    } catch {
      throw new ApiClientError('NETWORK_ERROR', '无法连接平台服务，请检查网络或联系管理员');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const token = this.getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await this.fetch(`${apiBaseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorEnvelope | null;
      throw new ApiClientError(body?.error.code ?? 'NETWORK_ERROR', body?.error.message ?? '请求失败，请检查服务连接', body?.error.fields);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async requestBlob(path: string): Promise<Blob> {
    const headers = new Headers({ accept: 'application/octet-stream' });
    const token = this.getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await this.fetch(`${apiBaseUrl}${path}`, { headers });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorEnvelope | null;
      throw new ApiClientError(body?.error.code ?? 'NETWORK_ERROR', body?.error.message ?? '请求失败，请检查服务连接', body?.error.fields);
    }
    return response.blob();
  }

  login(username: string, password: string) { return this.request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); }
  me() { return this.request<AuthUser>('/auth/me'); }
  users() { return this.request<{ items: AuthUser[] }>('/users'); }
  createUser(input: { username: string; displayName: string; password: string; roles: string[] }) { return this.request<AuthUser>('/users', { method: 'POST', body: JSON.stringify(input) }); }
  updateUser(userId: string, input: { displayName?: string; roles?: string[]; enabled?: boolean; password?: string }) { return this.request<AuthUser>(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(input) }); }
  deleteUser(userId: string) { return this.request<{ deleted: boolean; userId: string }>(`/users/${userId}`, { method: 'DELETE' }); }
  settings() { return this.request<SystemSettings>('/settings'); }
  updateSettings(input: Partial<SystemSettings>) { return this.request<SystemSettings>('/settings', { method: 'PATCH', body: JSON.stringify(input) }); }
  datasetAssets(datasetId: string) { return this.request<{ items: SourceAsset[] }>(`/datasets/${datasetId}/assets`); }
  downloadSourceAsset(assetId: string) { return this.requestBlob(`/source-assets/${assetId}/download`); }
  annotationTask(datasetId: string) { return this.request<AnnotationTask | null>(`/datasets/${datasetId}/annotation-task`); }
  pauseAnnotationTask(datasetId: string, reason: string) { return this.request<AnnotationTask>(`/datasets/${datasetId}/annotation-task/pause`, { method: 'POST', body: JSON.stringify({ reason }) }); }
  resumeAnnotationTask(datasetId: string) { return this.request<AnnotationTask>(`/datasets/${datasetId}/annotation-task/resume`, { method: 'POST' }); }
  openAnnotationTask(datasetId: string) { return this.request<AnnotationTask>(`/datasets/${datasetId}/annotation-task/open`, { method: 'POST' }); }
  processingRuns(datasetId: string) { return this.request<{ items: ProcessingRun[] }>(`/datasets/${datasetId}/processing-runs`); }
  startProcessing(datasetId: string, input: DatasetProcessingConfig) { return this.request<ProcessingRun>(`/datasets/${datasetId}/process`, { method: 'POST', body: JSON.stringify(input) }); }
  annotationJobs(datasetId: string) { return this.request<{ items: AnnotationJob[] }>(`/datasets/${datasetId}/jobs`); }
  annotationSegments(datasetId: string) { return this.request<{ items: AnnotationSegment[] }>(`/datasets/${datasetId}/segments`); }
  claimNextAnnotationJob(datasetId: string) { return this.request<AnnotationJob>(`/datasets/${datasetId}/jobs/claim-next`, { method: 'POST' }); }
  claimNextAnnotationReviewJob(datasetId: string) { return this.request<AnnotationJob>(`/datasets/${datasetId}/review-jobs/claim-next`, { method: 'POST' }); }
  claimAnnotationReviewJob(jobId: string) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/review-claim`, { method: 'POST' }); }
  reviewAnnotationJob(jobId: string, input: { decision: 'approve' | 'reject'; comment?: string }) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/review`, { method: 'POST', body: JSON.stringify(input) }); }
  reviewAnnotationJobs(datasetId: string, input: { jobIds: string[]; decision: 'approve' | 'reject'; comment?: string }) { return this.request<{ items: AnnotationJob[]; requested: number }>(`/datasets/${datasetId}/review-jobs/review`, { method: 'POST', body: JSON.stringify(input) }); }
  reopenAnnotationJob(jobId: string, reason: string) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }); }
  saveReviewedAnnotation(jobId: string, imageId: string, input: Pick<AnnotationDocument, 'revision' | 'annotations' | 'captions' | 'imageAttributes'>) { return this.request<AnnotationDocument>(`/annotation-jobs/${jobId}/images/${imageId}/annotations`, { method: 'PUT', body: JSON.stringify(input) }); }
  submitAnnotationJob(jobId: string) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/submit`, { method: 'POST' }); }
  updateAnnotationJob(jobId: string, input: { status?: AnnotationJob['status']; assigneeId?: string | null; reviewComment?: string }) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify(input) }); }
  releaseAnnotationJob(jobId: string, reason: string) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/release`, { method: 'POST', body: JSON.stringify({ reason }) }); }
  reassignAnnotationJob(jobId: string, assigneeId: string, reason: string) { return this.request<AnnotationJob>(`/annotation-jobs/${jobId}/reassign`, { method: 'POST', body: JSON.stringify({ assigneeId, reason }) }); }
  createUploadSession(datasetId: string, input: { filename: string; mimeType: string; sizeBytes: number; type: SourceAsset['type']; sha256?: string }) { return this.request<UploadSession & { asset: SourceAsset }>(`/datasets/${datasetId}/upload-sessions`, { method: 'POST', body: JSON.stringify(input) }); }
  uploadSessions(datasetId: string) { return this.request<{ items: UploadSession[] }>(`/datasets/${datasetId}/upload-sessions`); }
  uploadPart(sessionId: string, partNumber: number, body: Blob) { return this.request<{ partNumber: number; sizeBytes: number; completedParts: number[] }>(`/upload-sessions/${sessionId}/parts/${partNumber}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body }); }
  uploadSession(sessionId: string) { return this.request<UploadSession>(`/upload-sessions/${sessionId}`); }
  completeUpload(sessionId: string, sha256?: string) { return this.request<SourceAsset>(`/upload-sessions/${sessionId}/complete`, { method: 'POST', body: JSON.stringify(sha256 ? { sha256 } : {}) }); }
  cancelUpload(sessionId: string) { return this.request<void>(`/upload-sessions/${sessionId}`, { method: 'DELETE' }); }
  capabilities() { return this.request<RuntimeCapabilities>('/capabilities'); }
  activities() { return this.request<{ items: WorkspaceActivity[] }>('/activities'); }
  annotationStatistics(datasetId?: string) { return this.request<AnnotationStatistics>(`/annotation-statistics${datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : ''}`); }
  annotatorPerformance(filter: AnnotatorPerformanceFilter = {}) { const params = new URLSearchParams(); if (filter.startDate) params.set('startDate', filter.startDate); if (filter.endDate) params.set('endDate', filter.endDate); const query = params.toString(); return this.request<{ items: AnnotatorPerformance[] }>(`/annotation-statistics/annotators${query ? `?${query}` : ''}`); }
  datasets() { return this.request<{ items: Dataset[] }>('/datasets'); }
  createDataset(input: { taskTypeId: string; name: string; description: string; version: string; classes: string[]; labels?: DatasetLabel[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig?: DatasetProcessingConfig }) { return this.request<Dataset>('/datasets', { method: 'POST', body: JSON.stringify(input) }); }
  updateDatasetClasses(datasetId: string, classes: string[]) { return this.request<Dataset>(`/datasets/${datasetId}/classes`, { method: 'PATCH', body: JSON.stringify({ classes }) }); }
  updateDatasetLabels(datasetId: string, labels: DatasetLabel[]) { return this.request<Dataset>(`/datasets/${datasetId}/labels`, { method: 'PATCH', body: JSON.stringify({ labels }) }); }
  deleteDataset(datasetId: string) { return this.request<ResourceDeletionResult>(`/datasets/${datasetId}`, { method: 'DELETE', headers: { 'x-confirm-resource-id': datasetId } }); }
  datasetDeletionPreview(datasetId: string) { return this.request<DatasetDeletionPreview>(`/datasets/${datasetId}/deletion-preview`); }
  datasetImages(datasetId: string) { return this.request<{ items: DatasetImage[] }>(`/datasets/${datasetId}/images`); }
  async uploadDatasetImage(datasetId: string, file: File, split: DatasetImage['split'] = 'train') {
    const { mimeType } = inferSourceAssetUpload(file);
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      'x-file-mime-type': mimeType,
      'x-image-split': split,
    });
    const token = this.getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await this.fetch(`${apiBaseUrl}/datasets/${datasetId}/images`, { method: 'PUT', headers, body: file });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorEnvelope | null;
      throw new ApiClientError(body?.error.code ?? 'NETWORK_ERROR', body?.error.message ?? '上传失败，请检查服务连接', body?.error.fields);
    }
    return response.json() as Promise<DatasetImage>;
  }
  datasetImageContent(datasetId: string, imageId: string) { return this.requestBlob(`/datasets/${datasetId}/images/${imageId}/content`); }
  annotations(datasetId: string, imageId: string) { return this.request<AnnotationDocument>(`/datasets/${datasetId}/images/${imageId}/annotations`); }
  saveAnnotations(datasetId: string, imageId: string, input: { revision: number; annotations: AnnotationRecord[]; captions?: ImageCaption[]; imageAttributes?: AnnotationImageAttributes }) { return this.request<AnnotationDocument>(`/datasets/${datasetId}/images/${imageId}/annotations`, { method: 'PUT', body: JSON.stringify(input) }); }
  annotationReview(datasetId: string) { return this.request<AnnotationReviewSummary>(`/datasets/${datasetId}/reviews`); }
  submitAnnotationReview(datasetId: string) { return this.request<AnnotationReviewSummary>(`/datasets/${datasetId}/reviews/submit`, { method: 'POST' }); }
  decideAnnotationReview(datasetId: string, input: AnnotationReviewDecisionInput) { return this.request<AnnotationReviewSummary>(`/datasets/${datasetId}/reviews/decision`, { method: 'POST', body: JSON.stringify(input) }); }
  createDatasetExport(datasetId: string, input: { format: ExportTask['format']; versionName: string; includeImages: boolean }) { return this.request<ExportTask>(`/datasets/${datasetId}/exports`, { method: 'POST', body: JSON.stringify(input) }); }
  validateCvatImport(datasetId: string, payload: unknown, labelMapping?: Record<string, string>) { return this.request<{ valid: boolean; labels: string[]; unknownLabels: string[]; errors: Array<{ path: string; message: string }> }>(`/datasets/${datasetId}/imports/cvat/validate`, { method: 'POST', body: JSON.stringify({ payload, labelMapping }) }); }
  importCvat(datasetId: string, input: { payload?: unknown; xml?: string; labelMapping?: Record<string, string> }) { return this.request<{ imported: number; skipped: number; labels: string[] }>(`/datasets/${datasetId}/imports/cvat`, { method: 'POST', body: JSON.stringify(input) }); }
  datasetExports(datasetId: string) { return this.request<{ items: ExportTask[] }>(`/datasets/${datasetId}/exports`); }
  exportTask(exportId: string) { return this.request<ExportTask>(`/exports/${exportId}`); }
  artifact(artifactId: string) { return this.request<Artifact>(`/artifacts/${artifactId}`); }
  trainingJobs() { return this.request<{ items: TrainingJob[] }>('/training/jobs'); }
  createTrainingJob(draft: TrainingDraft) { return this.request<TrainingJob>('/training/jobs', { method: 'POST', body: JSON.stringify(draft) }); }
  retryTrainingJob(jobId: string) { return this.request<TrainingJob>(`/training/jobs/${jobId}/retry`, { method: 'POST' }); }
  cancelTrainingJob(jobId: string) { return this.request<TrainingJob>(`/training/jobs/${jobId}/cancel`, { method: 'POST' }); }
  deleteTrainingJob(jobId: string) { return this.request<ResourceDeletionResult>(`/training/jobs/${jobId}`, { method: 'DELETE' }); }
  trainingEvents(jobId: string) { return this.request<{ items: TrainingEvent[] }>(`/training/jobs/${jobId}/events`); }
  trainingObservability(jobId: string) { return this.request<TrainingObservability>(`/training/jobs/${jobId}/observability`); }
  conversions() { return this.request<{ items: ConversionTask[] }>('/conversions'); }
  createConversion(input: { modelName: string; modelVersion: string; format: ConversionTask['format']; precision: string; target: string; options: Record<string, string | boolean> }) { return this.request<ConversionTask>('/conversions', { method: 'POST', body: JSON.stringify(input) }); }
  cancelConversion(conversionId: string) { return this.request<ConversionTask>(`/conversions/${conversionId}/cancel`, { method: 'POST' }); }
  deleteConversion(conversionId: string) { return this.request<ResourceDeletionResult>(`/conversions/${conversionId}`, { method: 'DELETE' }); }
  downloadArtifact(artifactId: string) { return this.requestBlob(`/artifacts/${artifactId}/download`); }
  models() { return this.request<{ items: ModelVersion[] }>('/models'); }
  async uploadModel(input: { name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; file: File }) {
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(input.file.name),
      'x-file-mime-type': input.file.type || 'application/octet-stream',
      'x-model-name': encodeURIComponent(input.name),
      'x-model-version': encodeURIComponent(input.version),
      'x-model-task': encodeURIComponent(input.task),
      'x-model-framework': encodeURIComponent(input.framework),
      'x-model-stage': encodeURIComponent(input.stage),
    });
    const token = this.getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await this.fetch(`${apiBaseUrl}/models/upload`, { method: 'PUT', headers, body: input.file });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorEnvelope | null;
      throw new ApiClientError(body?.error.code ?? 'NETWORK_ERROR', body?.error.message ?? '模型上传失败，请检查服务连接', body?.error.fields);
    }
    return response.json() as Promise<ModelVersion>;
  }
  updateModelStage(modelId: string, stage: ModelVersion['stage']) { return this.request<ModelVersion>(`/models/${modelId}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) }); }
  deleteModel(modelId: string) { return this.request<ResourceDeletionResult>(`/models/${modelId}`, { method: 'DELETE' }); }
}
