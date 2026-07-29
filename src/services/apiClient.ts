import type { AnnotationDocument, AnnotationImageAttributes, AnnotationRecord, AnnotationReviewDecisionInput, AnnotationReviewSummary, ApiErrorEnvelope, Artifact, AuthUser, ConversionTask, Dataset, DatasetImage, ExportTask, ImageCaption, LoginResponse, ModelVersion, RuntimeCapabilities, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability } from '../../shared/contracts';

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
  capabilities() { return this.request<RuntimeCapabilities>('/capabilities'); }
  datasets() { return this.request<{ items: Dataset[] }>('/datasets'); }
  createDataset(input: { name: string; description: string; version: string; classes: string[] }) { return this.request<Dataset>('/datasets', { method: 'POST', body: JSON.stringify(input) }); }
  updateDatasetClasses(datasetId: string, classes: string[]) { return this.request<Dataset>(`/datasets/${datasetId}/classes`, { method: 'PATCH', body: JSON.stringify({ classes }) }); }
  deleteDataset(datasetId: string) { return this.request<void>(`/datasets/${datasetId}`, { method: 'DELETE' }); }
  datasetImages(datasetId: string) { return this.request<{ items: DatasetImage[] }>(`/datasets/${datasetId}/images`); }
  async uploadDatasetImage(datasetId: string, file: File, split: DatasetImage['split'] = 'train') {
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      'x-file-mime-type': file.type,
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
  createDatasetExport(datasetId: string, input: { format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean }) { return this.request<ExportTask>(`/datasets/${datasetId}/exports`, { method: 'POST', body: JSON.stringify(input) }); }
  datasetExports(datasetId: string) { return this.request<{ items: ExportTask[] }>(`/datasets/${datasetId}/exports`); }
  exportTask(exportId: string) { return this.request<ExportTask>(`/exports/${exportId}`); }
  artifact(artifactId: string) { return this.request<Artifact>(`/artifacts/${artifactId}`); }
  trainingJobs() { return this.request<{ items: TrainingJob[] }>('/training/jobs'); }
  createTrainingJob(draft: TrainingDraft) { return this.request<TrainingJob>('/training/jobs', { method: 'POST', body: JSON.stringify(draft) }); }
  retryTrainingJob(jobId: string) { return this.request<TrainingJob>(`/training/jobs/${jobId}/retry`, { method: 'POST' }); }
  cancelTrainingJob(jobId: string) { return this.request<TrainingJob>(`/training/jobs/${jobId}/cancel`, { method: 'POST' }); }
  deleteTrainingJob(jobId: string) { return this.request<void>(`/training/jobs/${jobId}`, { method: 'DELETE' }); }
  trainingEvents(jobId: string) { return this.request<{ items: TrainingEvent[] }>(`/training/jobs/${jobId}/events`); }
  trainingObservability(jobId: string) { return this.request<TrainingObservability>(`/training/jobs/${jobId}/observability`); }
  conversions() { return this.request<{ items: ConversionTask[] }>('/conversions'); }
  createConversion(input: { modelName: string; modelVersion: string; format: ConversionTask['format']; precision: string; target: string; options: Record<string, string | boolean> }) { return this.request<ConversionTask>('/conversions', { method: 'POST', body: JSON.stringify(input) }); }
  cancelConversion(conversionId: string) { return this.request<ConversionTask>(`/conversions/${conversionId}/cancel`, { method: 'POST' }); }
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
}
