import { useEffect, useState } from 'react';
import { Activity, AlertCircle, ArrowLeft, CheckCircle2, Cpu, Database, Download, FileText, Gauge, MemoryStick, RotateCcw, Server, Sparkles, Square, Terminal, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EmptyState, Modal, PageHeader, ProgressBar, SegmentedControl, StatusBadge } from '../components/ui';
import { MetricChart, type MetricSeries } from '../components/MetricChart';
import { useApp } from '../context/AppContext';
import { dataFormatDescriptions, taskLabels } from '../data/catalog';
import type { TrainingEvent, TrainingMetricPoint, TrainingObservability, TrainingType } from '../types';

type DetailTab = 'overview' | 'logs' | 'config';

function failureSummary(message: string) {
  const lines = message.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let summary = lines.at(-1) ?? message;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('{') && lines[index].includes('"event"')) continue;
    if (/(error|exception|failed|failure|失败|异常)/i.test(lines[index])) {
      summary = lines[index];
      break;
    }
  }
  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
}

export function buildTrainingMetricSeries(type: TrainingType, points: TrainingMetricPoint[]): MetricSeries[] {
  const yoloPose = type === 'keypoint' && points.some((point) => typeof point.metrics.mAP50 === 'number');
  const definitions = type === 'detection' || type === 'instance_segmentation'
    ? [{ key: 'mAP50', label: 'mAP@50', color: '#1778d4', axis: 'left' as const, format: 'score' as const }, { key: 'precision', label: 'Precision', color: '#0f9f7f', axis: 'left' as const, format: 'score' as const }, { key: 'recall', label: 'Recall', color: '#e18c28', axis: 'left' as const, format: 'score' as const }, { key: 'trainBoxLoss', label: 'Box Loss', color: '#d85462', axis: 'right' as const, format: 'number' as const }]
    : type === 'segmentation'
      ? [{ key: 'mIoU', label: 'mIoU', color: '#1778d4', axis: 'left' as const, format: 'score' as const }, { key: 'loss', label: 'Loss', color: '#e18c28', axis: 'right' as const, format: 'number' as const }]
      : type === 'keypoint'
        ? yoloPose ? [{ key: 'mAP50', label: 'mAP@50', color: '#7257c8', axis: 'left' as const, format: 'score' as const }, { key: 'loss', label: 'Loss', color: '#e18c28', axis: 'right' as const, format: 'number' as const }] : [{ key: 'oks', label: 'OKS', color: '#7257c8', axis: 'left' as const, format: 'score' as const }, { key: 'loss', label: 'Loss', color: '#e18c28', axis: 'right' as const, format: 'number' as const }]
        : [{ key: 'loss', label: 'Loss', color: '#1778d4', axis: 'right' as const, format: 'number' as const }];
  return definitions.flatMap((definition) => {
    const values = points.map((point) => point.metrics[definition.key]);
    return values.every((value) => typeof value === 'number') ? [{ name: definition.label, color: definition.color, values, axis: definition.axis, format: definition.format }] : [];
  });
}

export function TrainingDetailPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const { jobs, session, retryTrainingJob, cancelTrainingJob, deleteTrainingJob, trainingEvents, trainingObservability, downloadArtifact, notify } = useApp();
  const [tab, setTab] = useState<DetailTab>('overview');
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [events, setEvents] = useState<TrainingEvent[]>([]);
  const [observability, setObservability] = useState<TrainingObservability>({ metrics: [], resources: [] });
  const job = jobs.find((item) => item.id === jobId);

  useEffect(() => {
    if (!jobId) return;
    const refresh = () => {
      void trainingEvents(jobId).then(setEvents).catch(() => undefined);
      void trainingObservability(jobId).then(setObservability).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [jobId, trainingEvents, trainingObservability]);

  if (!job) {
    return (
      <div className="page training-detail-page">
        <PageHeader
          eyebrow="训练中心 / 任务详情"
          title="任务不存在"
          description="该训练任务尚未创建，或已从当前工作空间移除。"
          actions={<Link className="button secondary" to="/training"><ArrowLeft size={16} />任务列表</Link>}
        />
        <section className="panel">
          <EmptyState icon={FileText} title="暂无任务详情" description="返回任务列表创建或选择训练任务。" />
        </section>
      </div>
    );
  }

  const isRunning = job.status === 'running';
  const isQueued = job.status === 'queued';
  const canManage = session?.user.role === 'admin' || session?.user.role === 'engineer';
  const canRetry = job.status === 'failed' && canManage;
  const canDelete = !isRunning && !isQueued && canManage;
  const latestResource = observability.resources.at(-1);
  const visibleMetrics = observability.metrics.slice(-60);
  const metricSeries = buildTrainingMetricSeries(job.type, visibleMetrics);
  const memoryPercent = latestResource?.memoryTotalMb ? latestResource.memoryUsedMb / latestResource.memoryTotalMb * 100 : 0;
  const cancel = async () => {
    setCancelling(true);
    try { await cancelTrainingJob(job.id); } catch (error) { notify('训练任务未取消', error instanceof Error ? error.message : '无法取消训练任务', 'error'); } finally { setCancelling(false); }
  };
  const download = async () => {
    if (!job.artifactId) return;
    try { await downloadArtifact(job.artifactId); } catch (error) { notify('检查点下载失败', error instanceof Error ? error.message : '无法读取训练产物', 'error'); }
  };
  const retry = async () => {
    setRetrying(true);
    try {
      const newJobId = await retryTrainingJob(job.id);
      navigate(`/training/${newJobId}`);
    } catch (error) {
      notify('重新训练失败', error instanceof Error ? error.message : '无法重新提交训练任务', 'error');
    } finally {
      setRetrying(false);
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      await deleteTrainingJob(job.id);
      navigate('/training');
    } catch (error) {
      notify('训练任务未删除', error instanceof Error ? error.message : '无法删除训练任务', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page training-detail-page">
      <PageHeader
        eyebrow="训练中心 / 任务详情"
        title={job.name}
        description={`${job.id} · 创建于 ${job.createdAt}`}
        actions={<><Link className="button secondary" to="/training"><ArrowLeft size={16} />任务列表</Link>{canDelete && <button className="button danger ghost" disabled={deleting} onClick={() => setDeleteOpen(true)}><Trash2 size={16} />删除任务</button>}{canRetry && <button className="button primary" disabled={retrying} onClick={() => void retry()}><RotateCcw size={16} />{retrying ? '正在提交' : '重新训练'}</button>}</>}
      />

      <section className={`job-hero status-${job.status}`}>
        <div className="job-hero-status"><span className="hero-status-icon">{job.status === 'completed' ? <CheckCircle2 size={25} /> : job.status === 'failed' ? <AlertCircle size={25} /> : <Sparkles size={25} />}</span><div><StatusBadge status={job.status} /><strong>{isRunning ? `Epoch ${job.epoch}` : isQueued ? '等待计算资源' : job.status === 'completed' ? '训练已完成' : '任务异常终止'}</strong><span className="job-error-summary" title={job.errorMessage}>{job.errorMessage ? failureSummary(job.errorMessage) : job.eta}</span></div></div>
        <div className="hero-progress"><div><span>总体进度</span><strong>{job.progress}%</strong></div><ProgressBar value={job.progress} tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'orange' : 'blue'} /></div>
        <div className="hero-metrics"><div><small>{job.metricName || '评估指标'}</small><strong>{job.metricValue || '--'}</strong><span>任务当前值</span></div><div><small>训练轮次</small><strong>{job.epoch || '--'}</strong><span>任务当前进度</span></div><div><small>计算资源</small><strong>{job.gpu || '--'}</strong><span>任务配置</span></div></div>
      </section>

      <SegmentedControl<DetailTab> ariaLabel="任务详情视图" value={tab} onChange={setTab} options={[{ value: 'overview', label: '训练概览' }, { value: 'logs', label: '任务日志' }, { value: 'config', label: '配置参数' }]} />

      {tab === 'overview' && (
        <div className="detail-grid">
          <section className="panel metrics-panel wide">
            <header className="section-header"><div><h2>训练指标</h2><p>{observability.metrics.length ? `${observability.metrics.length} 个轮次数据点 · 每 3 秒刷新` : '等待 Worker 上报首个轮次'}</p></div></header>
            {metricSeries.length ? <MetricChart series={metricSeries} labels={visibleMetrics.map((point) => `E${point.epoch}`)} /> : <EmptyState icon={Gauge} title="暂无指标序列" description={isRunning ? '首个 Epoch 完成后将显示真实训练指标。' : '该任务没有保存按轮次指标。'} />}
          </section>
          <section className="panel resource-monitor">
            <header className="section-header"><div><h2>资源监控</h2><p>{job.gpu || '尚未分配'}</p></div></header>
            {latestResource ? <>
              <div className="resource-gauges">
                <div><span><Cpu size={15} />进程 CPU</span><strong>{latestResource.cpuPercent.toFixed(1)}%</strong><ProgressBar value={Math.min(100, latestResource.cpuPercent)} /></div>
                <div><span><MemoryStick size={15} />进程内存</span><strong>{latestResource.memoryUsedMb.toFixed(0)} MB</strong><ProgressBar value={memoryPercent} tone="green" /></div>
                {latestResource.gpuPercent !== undefined && <div><span><Activity size={15} />GPU 利用率</span><strong>{latestResource.gpuPercent.toFixed(1)}%</strong><ProgressBar value={latestResource.gpuPercent} tone="orange" /></div>}
              </div>
              <dl className="resource-details">
                <div><dt>设备</dt><dd>{latestResource.device === 'gpu' ? 'CUDA GPU' : 'CPU'}</dd></div>
                <div><dt>{latestResource.device === 'gpu' ? '显存' : '系统内存'}</dt><dd>{latestResource.device === 'gpu' ? `${latestResource.gpuMemoryUsedMb?.toFixed(0) ?? '--'} / ${latestResource.gpuMemoryTotalMb?.toFixed(0) ?? '--'} MB` : `${latestResource.memoryTotalMb?.toFixed(0) ?? '--'} MB`}</dd></div>
                <div><dt>采样时间</dt><dd>{new Date(latestResource.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</dd></div>
              </dl>
            </> : <EmptyState icon={Server} title="暂无资源遥测" description={isRunning ? 'Worker 启动资源采样后将在此显示。' : '该任务没有保存资源采样。'} />}
          </section>
          <section className="panel checkpoint-panel">
            <header className="section-header"><div><h2>检查点</h2><p>训练产物将在写入制品库后显示</p></div></header>
            {job.artifactId ? <button className="artifact-download-row" onClick={() => void download()}><FileText size={18} /><span><strong>最终模型产物</strong><small>已登记到制品库</small></span><Download size={17} /></button> : <EmptyState icon={FileText} title="暂无检查点" description="当前任务没有可下载的检查点记录。" />}
          </section>
          <section className="panel task-summary-panel">
            <header className="section-header"><div><h2>任务摘要</h2><p>任务提交时记录的信息</p></div></header>
            <dl><div><dt><Database size={15} />数据集</dt><dd>{job.dataset}</dd></div><div><dt><Sparkles size={15} />任务类型</dt><dd>{taskLabels[job.type]}</dd></div><div><dt><FileText size={15} />模型版本</dt><dd>{job.config?.version ?? '历史版本'}</dd></div><div><dt><FileText size={15} />数据格式</dt><dd>{job.config ? dataFormatDescriptions[job.config.dataFormat].label : '--'}</dd></div><div><dt><FileText size={15} />基础模型</dt><dd>{job.model}</dd></div><div><dt><Server size={15} />计算资源</dt><dd>{job.gpu || '--'}</dd></div></dl>
          </section>
        </div>
      )}

      {tab === 'logs' && <section className="log-console"><header><span><Terminal size={17} />任务日志</span></header><pre>{events.length ? events.map((event) => `[${event.createdAt}] ${event.level.toUpperCase()} ${event.message}`).join('\n') : job.errorMessage ?? '暂无任务事件。'}</pre><div className="console-status">{events.length} 条持久化任务事件 · 每 3 秒刷新</div></section>}

      {tab === 'config' && <section className="config-detail-panel"><div><h2>训练配置</h2><p>任务创建时持久化的完整超参数</p></div>{job.config ? <dl className="config-grid"><div><dt>模型版本</dt><dd>{job.config.version ?? '历史版本'}</dd></div><div><dt>数据格式</dt><dd>{dataFormatDescriptions[job.config.dataFormat].label}</dd></div><div><dt>权重来源</dt><dd>{job.config.weightSource === 'scratch' ? '从头训练' : '官方预训练权重'}</dd></div><div><dt>训练轮次</dt><dd>{job.config.epochs}</dd></div><div><dt>批次大小</dt><dd>{job.config.batchSize}</dd></div><div><dt>学习率</dt><dd>{job.config.learningRate}</dd></div><div><dt>输入尺寸</dt><dd>{job.config.imageSize}</dd></div><div><dt>混合精度</dt><dd>{job.config.mixedPrecision ? '启用' : '关闭'}</dd></div><div><dt>早停</dt><dd>{job.config.earlyStopping ? '启用' : '关闭'}</dd></div></dl> : <EmptyState icon={FileText} title="暂无完整配置" description="旧任务未保存完整训练参数。" />}</section>}

      {(isRunning || isQueued) && <div className="danger-zone-inline"><div><Square size={17} /><span><strong>停止训练</strong><small>取消排队或运行中的任务并释放资源</small></span></div><button className="button danger ghost" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在停止' : '停止任务'}</button></div>}
      {deleteOpen && <Modal title="删除训练任务" description={`确认删除“${job.name}”？`} onClose={() => !deleting && setDeleteOpen(false)} footer={<><button className="button secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>取消</button><button className="button danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除' : '确认删除'}</button></>}><p className="modal-warning-copy">任务历史、日志、训练指标和资源采样将被永久删除。已经登记的模型版本和制品会继续保留。</p></Modal>}
    </div>
  );
}
