import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowRight, ChevronDown, Database, Download, FileArchive, FileJson, FileStack, Play, Plus, ShieldCheck, Tags, Trash2, Upload } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, Modal, PageHeader, Pagination, ProgressBar } from '../components/ui';
import { useApp } from '../context/AppContext';
import { dataFormatDescriptions, taskLabels } from '../data/catalog';
import type { AnnotationJob, AnnotationSegment, AnnotationTask, DataFormat, Dataset, DatasetDeletionPreview, DatasetLabel, DatasetProcessingConfig, ExportTask, ProcessingRun, SourceAsset, TrainingType, UploadSession } from '../types';
import { formatPercent } from '../utils/format';
import { effectiveUserRoles } from '../../shared/contracts';
import { datasetCreateSchema } from '../../shared/schemas';

type ExportFormat = ExportTask['format'];
type DatasetFilter = 'all' | '标注中' | '待审核' | '可训练';

const exportFormatGroups: { task: TrainingType; formats: { id: DataFormat; icon: typeof FileJson }[] }[] = [
  { task: 'detection', formats: [{ id: 'YOLO', icon: FileStack }, { id: 'COCO', icon: FileJson }, { id: 'VOC', icon: FileArchive }, { id: 'CVAT_JSON', icon: FileJson }, { id: 'CVAT_XML', icon: FileArchive }] },
  { task: 'segmentation', formats: [{ id: 'COCO_SEGMENTATION', icon: FileJson }, { id: 'PNG_MASK', icon: FileStack }] },
  { task: 'keypoint', formats: [{ id: 'COCO_KEYPOINTS', icon: FileJson }] },
  { task: 'sdxl', formats: [{ id: 'IMAGE_FOLDER', icon: FileJson }] },
];
const labelColors = ['#2383f2', '#16a085', '#e6a23c', '#e85d75', '#7c5cc4', '#1aa6b7'];

export function DatasetsPage({ pageTitle = '数据中心' }: { pageTitle?: string }) {
  const [datasetModalOpen, setDatasetModalOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [datasetVersion, setDatasetVersion] = useState('v1');
  const [datasetLabels, setDatasetLabels] = useState<DatasetLabel[]>([]);
  const [labelEditorMode, setLabelEditorMode] = useState<'raw' | 'builder'>('builder');
  const [datasetAnnotatorIds, setDatasetAnnotatorIds] = useState<string[]>([]);
  const [datasetReviewerIds, setDatasetReviewerIds] = useState<string[]>([]);
  const [datasetFiles, setDatasetFiles] = useState<File[]>([]);
  const [submittingDataset, setSubmittingDataset] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [filter, setFilter] = useState<DatasetFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [exportDatasetId, setExportDatasetId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('COCO');
  const [exportVersionName, setExportVersionName] = useState('');
  const [includeImages, setIncludeImages] = useState(true);
  const [submittingExport, setSubmittingExport] = useState(false);
  const [assetsByDataset, setAssetsByDataset] = useState<Record<string, SourceAsset[]>>({});
  const [runsByDataset, setRunsByDataset] = useState<Record<string, ProcessingRun[]>>({});
  const [, setSessionsByDataset] = useState<Record<string, UploadSession[]>>({});
  const [processingDatasetId, setProcessingDatasetId] = useState<string | null>(null);
  const [segmentSize, setSegmentSize] = useState('100');
  const [frameStep, setFrameStep] = useState('1');
  const [startFrame, setStartFrame] = useState('');
  const [endFrame, setEndFrame] = useState('');
  const [imageQuality, setImageQuality] = useState('95');
  const [overlapSize, setOverlapSize] = useState('0');
  const [blockSize, setBlockSize] = useState('');
  const [useZipBlocks, setUseZipBlocks] = useState(false);
  const [zOrder, setZOrder] = useState(false);
  const [startingProcessing, setStartingProcessing] = useState(false);
  const [taskDatasetId, setTaskDatasetId] = useState<string | null>(null);
  const [segmentsByDataset, setSegmentsByDataset] = useState<Record<string, AnnotationSegment[]>>({});
  const [jobsByDataset, setJobsByDataset] = useState<Record<string, AnnotationJob[]>>({});
  const [tasksByDataset, setTasksByDataset] = useState<Record<string, AnnotationTask | null>>({});
  const { datasets, exports, users, refreshAdminData, refreshDatasets, createDataset, uploadDatasetAssets, datasetAssets, uploadSessions, processingRuns, startDatasetProcessing, openAnnotationTask, annotationTask, datasetImages, annotationSegments, annotationJobs, claimNextAnnotationJob, claimAnnotationReviewJob, deleteDataset, datasetDeletionPreview, createDatasetExport, loadDatasetExports, downloadArtifact, notify, session } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const exportDataset = datasets.find((dataset) => dataset.id === exportDatasetId);
  const totalImages = datasets.reduce((sum, dataset) => sum + dataset.images, 0);
  const annotatingCount = datasets.filter((dataset) => dataset.status === '标注中').length;
  const reviewCount = datasets.filter((dataset) => dataset.status === '待审核').length;
  const readyCount = datasets.filter((dataset) => dataset.status === '可训练').length;
  const filteredDatasets = useMemo(() => filter === 'all' ? datasets : datasets.filter((dataset) => dataset.status === filter), [datasets, filter]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredDatasets.length / pageSize)));
  const visibleDatasets = useMemo(() => filteredDatasets.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, filteredDatasets, pageSize]);
  const visibleDatasetKey = visibleDatasets.map((dataset) => dataset.id).join('|');
  const visibleExports = exports.filter((task) => task.datasetId === exportDatasetId);
  const userRoles = session ? effectiveUserRoles(session.user) : [];
  const canReview = userRoles.includes('admin') || userRoles.includes('reviewer');
  const isAdmin = userRoles.includes('admin');
  const canManageAssets = isAdmin;
  const annotators = users.filter((user) => user.enabled !== false && (user.roles ?? [user.role]).includes('annotator'));
  const reviewers = users.filter((user) => user.enabled !== false && (user.roles ?? [user.role]).includes('reviewer'));
  const taskDataset = datasets.find((dataset) => dataset.id === taskDatasetId);
  const taskSegments = taskDatasetId ? segmentsByDataset[taskDatasetId] ?? [] : [];
  const taskJobs = taskDatasetId ? jobsByDataset[taskDatasetId] ?? [] : [];

  const readProcessingConfig = (): DatasetProcessingConfig => {
    const parsedSegmentSize = Number(segmentSize);
    const parsedFrameStep = Number(frameStep);
    const parsedStartFrame = startFrame === '' ? undefined : Number(startFrame);
    const parsedEndFrame = endFrame === '' ? undefined : Number(endFrame);
    const parsedImageQuality = Number(imageQuality);
    if (!Number.isInteger(parsedSegmentSize) || parsedSegmentSize < 1 || parsedSegmentSize > 10_000) throw new Error('分段大小必须是 1 到 10000 之间的整数');
    if (!Number.isInteger(parsedImageQuality) || parsedImageQuality < 1 || parsedImageQuality > 100) throw new Error('图片质量必须是 1 到 100 之间的整数');
    if (parsedStartFrame !== undefined && (!Number.isInteger(parsedStartFrame) || parsedStartFrame < 0)) throw new Error('开始帧必须是大于或等于 0 的整数');
    if (parsedEndFrame !== undefined && (!Number.isInteger(parsedEndFrame) || parsedEndFrame < 0)) throw new Error('结束帧必须是大于或等于 0 的整数');
    if (parsedStartFrame !== undefined && parsedEndFrame !== undefined && parsedEndFrame < parsedStartFrame) throw new Error('结束帧不能小于开始帧');
    const parsedOverlapSize = Number(overlapSize);
    const parsedBlockSize = blockSize === '' ? undefined : Number(blockSize);
    if (!Number.isInteger(parsedFrameStep) || parsedFrameStep < 1) throw new Error('帧步长必须是大于 0 的整数');
    if (!Number.isInteger(parsedOverlapSize) || parsedOverlapSize < 0 || parsedOverlapSize >= parsedSegmentSize) throw new Error('重叠大小必须是大于等于 0 且小于段大小的整数');
    if (parsedBlockSize !== undefined && (!Number.isInteger(parsedBlockSize) || parsedBlockSize < 1)) throw new Error('块大小必须是大于 0 的整数');
    return {
      segmentSize: parsedSegmentSize,
      extractionStrategy: 'frame_step',
      frameStep: parsedFrameStep,
      startFrame: parsedStartFrame,
      endFrame: parsedEndFrame,
      imageQuality: parsedImageQuality,
      overlapSize: parsedOverlapSize,
      blockSize: parsedBlockSize,
      useZipBlocks,
      zOrder,
    };
  };

  const openProcessing = (dataset: Dataset) => {
    const config = dataset.processingConfig ?? { segmentSize: 100, extractionStrategy: 'frame_step' as const, frameStep: 1, imageQuality: 95, overlapSize: 0, useZipBlocks: false, zOrder: false };
    setSegmentSize(String(config.segmentSize));
    setFrameStep(String(config.frameStep ?? 1));
    setStartFrame(config.startFrame === undefined ? '' : String(config.startFrame));
    setEndFrame(config.endFrame === undefined ? '' : String(config.endFrame));
    setImageQuality(String(config.imageQuality));
    setOverlapSize(String(config.overlapSize ?? 0));
    setBlockSize(config.blockSize === undefined ? '' : String(config.blockSize));
    setUseZipBlocks(config.useZipBlocks ?? false);
    setZOrder(config.zOrder ?? false);
    setProcessingDatasetId(dataset.id);
  };

  useEffect(() => {
    if (isAdmin) void refreshAdminData().catch(() => undefined);
  }, [isAdmin, refreshAdminData]);

  useEffect(() => {
    if (isAdmin && searchParams.get('create') === '1') {
      openCreateDataset();
      setSearchParams({}, { replace: true });
    }
  }, [isAdmin, searchParams, setSearchParams]);

  const beginProcessing = async () => {
    if (!processingDatasetId) return;
    setStartingProcessing(true);
    try {
      const datasetId = processingDatasetId;
      await startDatasetProcessing(datasetId, readProcessingConfig());
      const latestRuns = await processingRuns(datasetId);
      setRunsByDataset((current) => ({ ...current, [datasetId]: latestRuns }));
      await refreshDatasets().catch(() => undefined);
      setProcessingDatasetId(null);
    } catch (error) { notify('处理未开始', error instanceof Error ? error.message : '无法创建处理任务', 'error'); }
    finally { setStartingProcessing(false); }
  };

  const openAnnotation = async (datasetId: string) => {
    try {
      const task = await openAnnotationTask(datasetId);
      setTasksByDataset((current) => ({ ...current, [datasetId]: task }));
      notify('标注已开放', '标注员现在可以按 Segment 顺序领取 Job', 'success');
    } catch (error) {
      notify('开放标注失败', error instanceof Error ? error.message : '资源处理尚未完成', 'error');
    }
  };

  useEffect(() => {
    if (!canReview || canManageAssets || visibleDatasets.length === 0) return;
    let active = true;
    void Promise.all(visibleDatasets.map(async (dataset) => [dataset.id, await datasetAssets(dataset.id)] as const))
      .then((entries) => { if (active) setAssetsByDataset((current) => ({ ...current, ...Object.fromEntries(entries) })); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canManageAssets, canReview, datasetAssets, visibleDatasets]);

  useEffect(() => {
    const datasetIds = visibleDatasetKey ? visibleDatasetKey.split('|') : [];
    if (!canManageAssets || datasetIds.length === 0) return;
    let active = true;
    const refresh = async () => {
      const [runEntries, assetEntries] = await Promise.all([
        Promise.all(datasetIds.map(async (datasetId) => [datasetId, await processingRuns(datasetId)] as const)),
        Promise.all(datasetIds.map(async (datasetId) => [datasetId, await datasetAssets(datasetId)] as const)),
      ]);
      if (!active) return;
      setRunsByDataset((current) => ({ ...current, ...Object.fromEntries(runEntries) }));
      setAssetsByDataset((current) => ({ ...current, ...Object.fromEntries(assetEntries) }));
      await refreshDatasets().catch(() => undefined);
    };
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [canManageAssets, datasetAssets, processingRuns, refreshDatasets, visibleDatasetKey]);

  useEffect(() => {
    if (!canManageAssets || visibleDatasets.length === 0) return;
    let active = true;
    const refresh = async () => {
      const entries = await Promise.all(visibleDatasets.map(async (dataset) => [dataset.id, await uploadSessions(dataset.id)] as const));
      if (active) setSessionsByDataset((current) => ({ ...current, ...Object.fromEntries(entries) }));
    };
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [canManageAssets, uploadSessions, visibleDatasets]);

  useEffect(() => {
    if (!session || visibleDatasets.length === 0) return;
    let active = true;
    void Promise.all(visibleDatasets.map(async (dataset) => [dataset.id, await annotationTask(dataset.id)] as const))
      .then((entries) => { if (active) setTasksByDataset((current) => ({ ...current, ...Object.fromEntries(entries) })); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [annotationTask, session, visibleDatasets]);

  useEffect(() => {
    if (!session || visibleDatasets.length === 0) return;
    const datasetIds = visibleDatasetKey ? visibleDatasetKey.split('|') : [];
    let active = true;
    const refresh = async () => {
      const entries = await Promise.all(datasetIds.map(async (datasetId) => {
        const [segments, jobs] = await Promise.all([annotationSegments(datasetId), annotationJobs(datasetId)]);
        return [datasetId, segments, jobs] as const;
      }));
      if (!active) return;
      setSegmentsByDataset((current) => ({ ...current, ...Object.fromEntries(entries.map(([id, segments]) => [id, segments])) }));
      setJobsByDataset((current) => ({ ...current, ...Object.fromEntries(entries.map(([id, , jobs]) => [id, jobs])) }));
    };
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [annotationJobs, annotationSegments, session, visibleDatasetKey, visibleDatasets.length]);

  const openTaskSegments = (datasetId: string) => {
    setTaskDatasetId(datasetId);
    void Promise.all([annotationSegments(datasetId), annotationJobs(datasetId)]).then(([segments, jobs]) => {
      setSegmentsByDataset((current) => ({ ...current, [datasetId]: segments }));
      setJobsByDataset((current) => ({ ...current, [datasetId]: jobs }));
    }).catch((error: unknown) => notify('任务段加载失败', error instanceof Error ? error.message : '无法读取任务段', 'error'));
  };

  const openTaskSegment = async (segment: AnnotationSegment, job: AnnotationJob | undefined) => {
    try {
      const openedJob = canReview && job?.status === 'submitted'
        ? await claimAnnotationReviewJob(job.id)
        : !canReview && job?.status === 'available'
          ? await claimNextAnnotationJob(segment.datasetId)
          : job;
      if (!openedJob) return;
      const openedSegment = (segmentsByDataset[segment.datasetId] ?? []).find((item) => item.id === openedJob.segmentId) ?? segment;
      const target = `/annotate/${segment.datasetId}/job/${encodeURIComponent(openedJob.id)}?image=${encodeURIComponent(openedSegment.startItemId)}${canReview && ['submitted', 'reviewing'].includes(openedJob.status) ? '&mode=review' : ''}`;
      setTaskDatasetId(null);
      navigate(target);
    } catch (error) { notify('无法领取 Job', error instanceof Error ? error.message : '当前任务段不可领取', 'error'); }
  };

  const openCreateDataset = () => {
    setDatasetName('');
    setDatasetDescription('');
    setDatasetVersion('v1');
    setDatasetLabels([]);
    setLabelEditorMode('builder');
    setDatasetAnnotatorIds([]);
    setDatasetReviewerIds([]);
    setDatasetFiles([]);
    setSegmentSize('100');
    setFrameStep('1');
    setStartFrame('');
    setEndFrame('');
    setImageQuality('95');
    setOverlapSize('0');
    setBlockSize('');
    setUseZipBlocks(false);
    setZOrder(false);
    setUploadProgress(0);
    setDatasetModalOpen(true);
  };

  const submitDataset = async () => {
    if (!datasetName.trim()) {
      notify('数据集未创建', '请填写数据集名称', 'error');
      return;
    }
    if (!datasetLabels.length || datasetLabels.some((label) => !label.name.trim())) {
      notify('数据集未创建', '请在标签构造器中至少添加一个有效标签', 'error');
      return;
    }
    let processingConfig: DatasetProcessingConfig;
    try {
      processingConfig = readProcessingConfig();
    } catch (error) {
      notify('任务配置无效', error instanceof Error ? error.message : '请检查处理与分段参数', 'error');
      return;
    }
    const input = {
      name: datasetName.trim(),
      description: datasetDescription.trim(),
      version: datasetVersion.trim() || 'v1',
      classes: datasetLabels.map((label) => label.name.trim()).filter(Boolean),
      labels: datasetLabels,
      annotatorIds: datasetAnnotatorIds,
      reviewerIds: datasetReviewerIds,
      processingConfig,
    };
    const validation = datasetCreateSchema.safeParse(input);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      notify('数据集未创建', `${issue.path.join('.') || '表单'}：${issue.message}`, 'error');
      return;
    }
    setSubmittingDataset(true);
    try {
      const dataset = await createDataset(validation.data);
      if (datasetFiles.length) {
        const assets = await uploadDatasetAssets(dataset.id, datasetFiles, (completed, total) => setUploadProgress(total ? Math.round(completed * 100 / total) : 100));
        setAssetsByDataset((current) => ({ ...current, [dataset.id]: assets }));
      }
      setDatasetModalOpen(false);
      notify('任务已创建', datasetFiles.length ? '资源已上传，请由管理员点击“开始处理”后开放标注' : '任务已创建，请继续上传资源');
    } catch (error) {
      notify('数据集上传失败', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setSubmittingDataset(false);
    }
  };

  const copyLabelTemplate = async () => {
    if (!datasetLabels.length) return;
    try { await navigator.clipboard.writeText(JSON.stringify(datasetLabels, null, 2)); notify('标签模板已复制', '标签与属性 JSON 已复制到剪贴板'); } catch { notify('复制失败', '当前浏览器不允许访问剪贴板', 'error'); }
  };

  const addDatasetLabel = () => setDatasetLabels((current) => [...current, { name: '', color: labelColors[current.length % labelColors.length], attributes: [] }]);
  const updateDatasetLabel = (index: number, change: Partial<DatasetLabel>) => setDatasetLabels((current) => current.map((label, labelIndex) => labelIndex === index ? { ...label, ...change } : label));
  const removeDatasetLabel = (index: number) => setDatasetLabels((current) => current.filter((_, labelIndex) => labelIndex !== index));

  const annotateDataset = async (datasetId: string) => {
    try {
      const jobs = await annotationJobs(datasetId);
      let job = jobs.find((item) => ['rework', 'available', 'claimed', 'in_progress'].includes(item.status));
      if (!canReview && job?.status === 'available') job = await claimNextAnnotationJob(datasetId);
      const [images, segments] = await Promise.all([datasetImages(datasetId), annotationSegments(datasetId)]);
      const segment = job ? segments.find((item) => item.id === job.segmentId) : undefined;
      const firstImage = segment ? images.find((image) => image.id === segment.startItemId) : images[0];
      if (!firstImage || (jobs.length > 0 && !job)) {
        notify('暂无可标注任务', jobs.length ? '当前任务段正在审核或已完成' : '请先由管理员完成资源处理并生成任务段', 'info');
        return;
      }
      navigate(job
        ? `/annotate/${datasetId}/job/${encodeURIComponent(job.id)}?image=${encodeURIComponent(firstImage.id)}`
        : `/annotate/${datasetId}?image=${encodeURIComponent(firstImage.id)}`);
    } catch (error) {
      notify('无法打开标注', error instanceof Error ? error.message : '无法读取数据集图像', 'error');
    }
  };

  const removeDataset = async (datasetId: string, name: string) => {
    try {
      const preview: DatasetDeletionPreview = await datasetDeletionPreview(datasetId);
      const { counts } = preview;
      const confirmed = window.confirm(`确定永久删除数据集“${name}”吗？\n\n将删除：${counts.assets} 个源文件、${counts.images} 张图片、${counts.annotations} 份标注、${counts.segments} 个分段、${counts.jobs} 个标注 Job、${counts.exports} 个导出、${counts.trainingJobs} 个训练任务、${counts.models} 个模型。\n预计释放 ${Math.round(preview.releasedBytes / 1024 / 1024)} MB 存储。`);
      if (!confirmed) return;
      await deleteDataset(datasetId);
    } catch (error) { notify('数据集未删除', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error'); }
  };

  const submitExport = async () => {
    if (!exportDataset) return;
    setSubmittingExport(true);
    try {
      await createDatasetExport(exportDataset.id, { format: exportFormat, versionName: exportVersionName.trim() || `${exportDataset.name}_${exportDataset.version}`, includeImages });
      await loadDatasetExports(exportDataset.id);
    } catch (error) {
      notify('导出任务未创建', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setSubmittingExport(false);
    }
  };

  const openExport = (datasetId: string) => {
    const dataset = datasets.find((item) => item.id === datasetId);
    if (!dataset) return;
    setExportDatasetId(datasetId);
    setExportVersionName(dataset ? `${dataset.name}_${dataset.version}` : 'export');
    setExportFormat('COCO');
    setIncludeImages(true);
    void loadDatasetExports(datasetId).catch((error: unknown) => notify('导出记录加载失败', error instanceof Error ? error.message : '无法读取导出任务', 'error'));
  };

  const downloadExport = async (task: ExportTask) => {
    if (!task.artifactId) return;
    try { await downloadArtifact(task.artifactId); } catch (error) { notify('产物下载失败', error instanceof Error ? error.message : '无法读取导出产物', 'error'); }
  };

  const renderProcessingConfig = () => (
    <section className="dataset-processing-config">
      <header><strong>处理与分段配置</strong><span>图片和压缩包内容统一按顺序切段；每个视频独立抽帧并切段。</span></header>
      <div className="form-grid three">
        <label className="form-field"><span>段大小</span><input type="number" min="1" max="10000" step="1" value={segmentSize} onChange={(event) => setSegmentSize(event.target.value)} /><small>每个 Segment 对应一个可领取 Job，默认 100 帧</small></label>
        <label className="form-field"><span>帧步长</span><input type="number" min="1" max="100000" step="1" value={frameStep} onChange={(event) => setFrameStep(event.target.value)} /><small>每隔 N 帧抽取一帧</small></label>
        <label className="form-field"><span>重叠大小</span><input type="number" min="0" max="9999" step="1" value={overlapSize} onChange={(event) => setOverlapSize(event.target.value)} /><small>相邻 Segment 重复的帧数</small></label>
        <label className="form-field"><span>开始帧（可选）</span><input type="number" min="0" step="1" value={startFrame} onChange={(event) => setStartFrame(event.target.value)} placeholder="0" /></label>
        <label className="form-field"><span>结束帧（可选）</span><input type="number" min="0" step="1" value={endFrame} onChange={(event) => setEndFrame(event.target.value)} placeholder="留空表示视频末尾" /></label>
        <label className="form-field"><span>输出图片质量</span><input type="number" min="1" max="100" step="1" value={imageQuality} onChange={(event) => setImageQuality(event.target.value)} /><small>1–100，数值越高文件越大</small></label>
        <label className="form-field"><span>块大小</span><input type="number" min="1" max="10000" step="1" value={blockSize} onChange={(event) => setBlockSize(event.target.value)} placeholder="可选" /></label>
        <label className="form-field processing-checkbox-field"><span>使用压缩块</span><span className="processing-checkbox-input"><input type="checkbox" checked={useZipBlocks} onChange={(event) => setUseZipBlocks(event.target.checked)} /><strong>{useZipBlocks ? '已启用' : '未启用'}</strong></span><small>视频处理时强制使用 ZIP 块</small></label>
        <label className="form-field processing-checkbox-field"><span>启用 Z 顺序</span><span className="processing-checkbox-input"><input type="checkbox" checked={zOrder} onChange={(event) => setZOrder(event.target.checked)} /><strong>{zOrder ? '已启用' : '未启用'}</strong></span><small>保留对象绘制顺序</small></label>
      </div>
    </section>
  );

  return (
    <div className="page datasets-page">
      <PageHeader
        title={pageTitle}
        description={`${datasets.length} 个数据集 · ${totalImages.toLocaleString()} 张图像`}
        actions={isAdmin ? <><button className="button secondary" onClick={openCreateDataset}><Upload size={17} />导入资源</button><button className="button primary" onClick={openCreateDataset}><Plus size={17} />创建任务</button></> : undefined}
      />

      <section className="data-toolbar">
        <div className="segmented tabs" aria-label="数据状态">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setPage(1); }}>全部数据集 <span>{datasets.length}</span></button>
          <button className={filter === '标注中' ? 'active' : ''} onClick={() => { setFilter('标注中'); setPage(1); }}>标注中 <span>{annotatingCount}</span></button>
          <button className={filter === '待审核' ? 'active' : ''} onClick={() => { setFilter('待审核'); setPage(1); }}>待审核 <span>{reviewCount}</span></button>
          <button className={filter === '可训练' ? 'active' : ''} onClick={() => { setFilter('可训练'); setPage(1); }}>可训练 <span>{readyCount}</span></button>
        </div>
        <div className="toolbar-meta"><span>按最近更新</span></div>
      </section>

      <section className="table-panel dataset-table-panel">
        <div className="table-scroll">
          <table className="data-table datasets-table">
            <thead><tr><th>数据集</th><th>标注进度</th><th>类别</th><th>版本 / 大小</th><th>最近更新</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {visibleDatasets.map((dataset) => {
                const progress = formatPercent(dataset.annotated, dataset.images);
                const assets = assetsByDataset[dataset.id] ?? [];
                const runs = runsByDataset[dataset.id] ?? [];
                const latestRun = [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
                const task = tasksByDataset[dataset.id];
                const waitingAssets = assets.filter((asset) => asset.uploadStatus === 'uploaded' && asset.processingStatus === 'pending').length;
                const processingActive = latestRun?.status === 'queued' || latestRun?.status === 'running';
                const processingProgress = Math.max(0, Math.min(100, latestRun?.progress ?? 0));
                return (
                  <tr key={dataset.id}>
                    <td>
                      <div className="dataset-name-cell">
                        <span className="dataset-square"><Database size={21} /></span>
                        <div><strong>{dataset.name}</strong><span>{dataset.description}</span></div>
                      </div>
                    </td>
                    <td><div className="table-progress"><div><strong>{progress}%</strong><span>{dataset.annotated.toLocaleString()} / {dataset.images.toLocaleString()}</span></div><ProgressBar value={progress} tone={progress === 100 ? 'green' : 'blue'} /></div></td>
                    <td><div className="class-chips">{dataset.classes.slice(0, 2).map((item) => <span key={item}>{item}</span>)}{dataset.classes.length > 2 && <b>+{dataset.classes.length - 2}</b>}</div></td>
                    <td><strong className="version-text">{dataset.version}</strong></td>
                    <td><span>{dataset.updatedAt}</span><span className={`dataset-status ${dataset.status}`}>{dataset.status}</span></td>
                    <td>
                      <div className="row-actions">
                        {dataset.status === '待审核' && canReview
                          ? <button className="button compact secondary" onClick={() => openTaskSegments(dataset.id)}><ShieldCheck size={15} />审核任务段</button>
                          : <button className="button compact secondary" onClick={() => void annotateDataset(dataset.id)}><Tags size={15} />{dataset.status === '待审核' ? '查看标注' : progress === 100 ? '查看标注' : '继续标注'}</button>}
                        <button className="button compact secondary" onClick={() => openTaskSegments(dataset.id)}><FileStack size={15} />任务段</button>
                        {isAdmin && (waitingAssets > 0 || processingActive) && <button className="button compact primary processing-action-button" disabled={processingActive} onClick={() => openProcessing(dataset)}>{processingActive ? <><span className="processing-progress-ring" style={{ '--progress': `${processingProgress * 3.6}deg` } as CSSProperties} aria-label={`处理进度 ${processingProgress}%`}><span>{processingProgress}%</span></span><span>处理中</span></> : <><Play size={15} />开始处理</>}</button>}
                        {isAdmin && task?.status === 'ready' && <button className="button compact primary" onClick={() => void openAnnotation(dataset.id)}><Play size={15} />开放标注</button>}
                        {canReview && <button className="icon-button bordered" disabled={dataset.annotated === 0} title={dataset.annotated > 0 ? '导出全部已标注数据' : '暂无已标注数据'} aria-label={`导出 ${dataset.name}`} onClick={() => openExport(dataset.id)}><Download size={17} /></button>}
                        {isAdmin && <button className="icon-button" title="删除数据集" aria-label={`删除 ${dataset.name}`} onClick={() => void removeDataset(dataset.id, dataset.name)}><Trash2 size={17} /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredDatasets.length > 0 && <Pagination page={currentPage} pageSize={pageSize} totalItems={filteredDatasets.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />}
        {visibleDatasets.length === 0 && <EmptyState icon={Database} title={datasets.length ? '没有匹配的数据集' : '暂无数据集'} description={datasets.length ? '调整状态筛选后重试' : '导入图像与标注，或创建一个空数据集开始整理数据'} />}
      </section>

      {canReview && <section className="dataset-readiness-band">
        <div><span className="band-icon"><Tags size={21} /></span><div><strong>{readyCount ? `${readyCount} 个数据版本已达到训练条件` : '暂无可训练的数据版本'}</strong><p>{readyCount ? '可训练数据集已经完成标注检查，可以进入训练配置。' : '导入数据并完成标注审核后，训练入口将自动可用。'}</p></div></div>
        <button className="button secondary" onClick={() => navigate('/training/new')} disabled={!readyCount}>配置训练 <ArrowRight size={16} /></button>
      </section>}

      {exportDataset && (
        <Modal
          title="导出标注数据"
          description={`${exportDataset.name} · ${exportDataset.version} · ${exportDataset.images.toLocaleString()} 张图像`}
          onClose={() => setExportDatasetId(null)}
          footer={<><button className="button secondary" onClick={() => setExportDatasetId(null)}>取消</button><button className="button primary" onClick={submitExport} disabled={submittingExport}><Download size={17} />{submittingExport ? '正在创建' : '创建导出任务'}</button></>}
        >
          <div className="form-section">
            <label className="field-label">导出格式</label>
            <div className="format-option-groups">
              {exportFormatGroups.map((group) => (
                <section className="format-option-group" key={group.task}>
                  <strong>{taskLabels[group.task]}</strong>
                  <div className="format-option-list">
                    {group.formats.map(({ id, icon: Icon }) => (
                      <button key={id} className={`format-option ${exportFormat === id ? 'selected' : ''}`} onClick={() => setExportFormat(id)}>
                        <span className="format-icon"><Icon size={21} /></span>
                        <span><strong>{dataFormatDescriptions[id].label}</strong><small>{dataFormatDescriptions[id].description}</small></span>
                        <i className="radio-mark" />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
          <label className="form-field"><span>版本名称</span><input value={exportVersionName || `${exportDataset.name}_${exportDataset.version}`} onChange={(event) => setExportVersionName(event.target.value)} /><small>按整个数据集导出，未审核、未标注或当前格式无法表达的图片会自动跳过。</small></label>
          <label className="check-row"><input type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} /><span><strong>包含已标注原始图像</strong><small>未标注图片不会进入导出包，数据集已标注 {exportDataset.annotated.toLocaleString()} / {exportDataset.images.toLocaleString()} 张</small></span></label>
          <section className="export-history">
            <div className="section-header"><div><h3>导出记录</h3><p>任务状态会自动刷新</p></div></div>
            {visibleExports.length ? <div className="export-history-list">{visibleExports.map((task) => <div key={task.id} className="export-history-row"><span><strong>{task.format}</strong><small>{task.versionName} · {task.scope === 'all' ? '全部已标注数据' : `${task.scope}（已标注）`}</small></span><span><strong>{task.status === 'queued' ? '排队中' : task.status === 'running' ? `${task.progress}%` : task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '已取消'}</strong><small>{task.errorMessage ?? task.createdAt}</small></span>{task.artifactId ? <button className="icon-button bordered" title="下载导出产物" aria-label="下载导出产物" onClick={() => void downloadExport(task)}><Download size={16} /></button> : <span />}</div>)}</div> : <EmptyState icon={FileArchive} title="暂无导出记录" description="创建任务后可在这里查看进度和下载产物" />}
          </section>
        </Modal>
      )}
      {taskDataset && <Modal title={`${taskDataset.name} · 任务段`} description="按参考平台流程查看 Segment 与 Job；打开具体任务段后才进入标注或审核。" onClose={() => setTaskDatasetId(null)}>
        <div className="task-segment-list">
          {taskSegments.length ? taskSegments.map((segment) => {
            const job = taskJobs.find((item) => item.segmentId === segment.id);
            const status = job?.status === 'available' ? '待领取' : job?.status === 'claimed' ? '已领取' : job?.status === 'in_progress' ? '标注中' : job?.status === 'submitted' ? '待审核' : job?.status === 'reviewing' ? '审核中' : job?.status === 'approved' ? '已通过' : job?.status === 'rework' ? '待返工' : '未生成';
            return <div className="task-segment-row" key={segment.id}><span><strong>Segment {segment.sequence}</strong><small>{segment.itemCount} 帧 · {segment.startItemId} → {segment.endItemId}</small></span><span className="dataset-status">{status}</span><button className="button compact secondary" onClick={() => void openTaskSegment(segment, job)} disabled={!job || job.status === 'cancelled'}>{job?.status === 'submitted' && canReview ? '审核' : job?.status === 'available' && !canReview ? '领取并打开' : '打开'}</button></div>;
          }) : <EmptyState icon={FileStack} title="暂无任务段" description="请先上传资源并由管理员开始处理。" />}
        </div>
      </Modal>}
      {datasetModalOpen && <Modal title="创建任务" description="按参考平台流程配置任务、人员、标签和媒体处理参数。" width="large" className="dataset-create-modal" onClose={() => !submittingDataset && setDatasetModalOpen(false)} footer={<><button className="button secondary" onClick={() => setDatasetModalOpen(false)} disabled={submittingDataset}>取消</button><button className="button primary" onClick={() => void submitDataset()} disabled={submittingDataset}>{submittingDataset ? '正在创建并上传' : '创建并上传'}</button></>}>
        <div className="dataset-create-form"><div className="dataset-form-heading"><span>01</span><div><strong>基础配置</strong><small>设置任务名称、版本和标注类别</small></div></div><div className="form-grid two dataset-create-grid">
          <label className="form-field"><span>数据集名称</span><input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} placeholder="例如：焊点缺陷检测" /></label>
          <label className="form-field"><span>版本</span><input value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)} /></label>
          <label className="form-field form-field-full"><span>说明</span><textarea value={datasetDescription} onChange={(event) => setDatasetDescription(event.target.value)} placeholder="记录采集场景、样本来源或标注规范" /></label>
        </div>
        {isAdmin && <><div className="dataset-form-heading"><span>02</span><div><strong>人员分配</strong><small>配置该任务可领取和审核的人员</small></div></div><div className="assignment-grid"><div><strong>标注员</strong><small>只允许所选标注员领取该数据集 Job</small><details className="member-select"><summary><span>{datasetAnnotatorIds.length ? `已选择 ${datasetAnnotatorIds.length} 人` : '请选择标注员'}</span><ChevronDown size={15} /></summary><div className="member-select-panel"><header><span>可用标注员（{annotators.length}）</span><div><button type="button" onClick={() => setDatasetAnnotatorIds(annotators.map((user) => user.id))} disabled={!annotators.length}>全选</button><button type="button" onClick={() => setDatasetAnnotatorIds([])} disabled={!datasetAnnotatorIds.length}>清空</button></div></header>{annotators.length ? <div className="member-select-options">{annotators.map((user) => <label key={user.id}><input type="checkbox" checked={datasetAnnotatorIds.includes(user.id)} onChange={(event) => setDatasetAnnotatorIds((current) => event.target.checked ? [...new Set([...current, user.id])] : current.filter((id) => id !== user.id))} /><span><strong>{user.displayName}</strong><small>{user.username}</small></span></label>)}</div> : <p className="cell-subtext">暂无可用标注员，请先在系统管理创建用户</p>}</div></details></div><div><strong>审核员</strong><small>只允许所选审核员领取审核 Job</small><details className="member-select"><summary><span>{datasetReviewerIds.length ? `已选择 ${datasetReviewerIds.length} 人` : '请选择审核员'}</span><ChevronDown size={15} /></summary><div className="member-select-panel"><header><span>可用审核员（{reviewers.length}）</span><div><button type="button" onClick={() => setDatasetReviewerIds(reviewers.map((user) => user.id))} disabled={!reviewers.length}>全选</button><button type="button" onClick={() => setDatasetReviewerIds([])} disabled={!datasetReviewerIds.length}>清空</button></div></header>{reviewers.length ? <div className="member-select-options">{reviewers.map((user) => <label key={user.id}><input type="checkbox" checked={datasetReviewerIds.includes(user.id)} onChange={(event) => setDatasetReviewerIds((current) => event.target.checked ? [...new Set([...current, user.id])] : current.filter((id) => id !== user.id))} /><span><strong>{user.displayName}</strong><small>{user.username}</small></span></label>)}</div> : <p className="cell-subtext">暂无可用审核员，请先在系统管理创建用户</p>}</div></details></div></div></>}
        {isAdmin && <div className="dataset-label-section"><div className="dataset-form-heading"><span>03</span><div><strong>标签</strong><small>在构造器中添加任务标签和标签属性</small></div></div><div className="form-field dataset-label-editor"><div className="dataset-label-tabs"><button type="button" className={labelEditorMode === 'raw' ? 'active' : ''} onClick={() => setLabelEditorMode('raw')}>原生的</button><button type="button" className={labelEditorMode === 'builder' ? 'active' : ''} onClick={() => setLabelEditorMode('builder')}>构造器</button><button type="button" className="dataset-label-copy" onClick={() => void copyLabelTemplate()}>复制</button></div>{labelEditorMode === 'raw' ? <textarea value={JSON.stringify(datasetLabels, null, 2)} onChange={(event) => { try { const next = JSON.parse(event.target.value) as DatasetLabel[]; if (Array.isArray(next)) setDatasetLabels(next); } catch { return; } }} rows={7} placeholder={'[{"name":"缺陷","color":"#2383f2","attributes":[]}'}/> : <div className="dataset-label-builder"><div className="dataset-label-builder-toolbar"><strong>标签列表</strong><button type="button" className="button compact secondary" onClick={addDatasetLabel}><Plus size={14} />添加标签</button></div>{datasetLabels.length ? <div className="dataset-label-builder-list">{datasetLabels.map((label, index) => <div className="dataset-label-builder-row" key={`label-${index}`}><input aria-label={`标签名称 ${index + 1}`} value={label.name} onChange={(event) => updateDatasetLabel(index, { name: event.target.value })} placeholder="标签名称" /><input aria-label={`标签颜色 ${index + 1}`} type="color" value={label.color} onChange={(event) => updateDatasetLabel(index, { color: event.target.value })} /><button type="button" className="icon-button" onClick={() => removeDatasetLabel(index)} aria-label={`删除标签 ${index + 1}`}><Trash2 size={15} /></button></div>)}</div> : <div className="dataset-label-empty">暂无标签，点击“添加标签”创建第一个标签。</div>}</div>}<small>标签创建后随任务冻结；至少添加一个标签后，标注任务才有可用类别。</small></div></div>}
        <div className="dataset-form-heading"><span>{isAdmin ? '04' : '03'}</span><div><strong>选择文件</strong><small>支持批量图像、压缩包或单个视频</small></div></div><label className="form-field dataset-upload-field"><input type="file" accept="image/jpeg,image/png,image/webp,.zip,.tar,.mp4,.mov,.avi,.mkv,video/*" multiple onChange={(event) => setDatasetFiles(Array.from(event.target.files ?? []))} /><small>{datasetFiles.length ? `已选择 ${datasetFiles.length} 个资源` : '单击或将文件拖到该区域；等待管理员开始处理'}</small></label>{submittingDataset && datasetFiles.length > 0 && <ProgressBar value={uploadProgress} label={`资源上传进度 ${uploadProgress}%`} />}
        <div className="dataset-form-heading"><span>{isAdmin ? '05' : '04'}</span><div><strong>预配置</strong><small>配置完成后将不可再修改</small></div></div>{renderProcessingConfig()}
        </div>
      </Modal>}
      {processingDatasetId && <Modal title="开始处理资源" description="处理完成后将生成统一图片、视频帧、缩略图和按帧数切分的 Segment。" onClose={() => !startingProcessing && setProcessingDatasetId(null)} footer={<><button className="button secondary" disabled={startingProcessing} onClick={() => setProcessingDatasetId(null)}>取消</button><button className="button primary" disabled={startingProcessing} onClick={() => void beginProcessing()}>{startingProcessing ? '正在提交' : '开始处理'}</button></>}>
        {renderProcessingConfig()}
        <p className="cell-subtext">压缩包会递归扫描图片；不同视频独立处理，单个视频失败不会阻止其他资源完成。</p>
      </Modal>}
    </div>
  );
}
