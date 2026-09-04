import { ArrowRight, Boxes, Cpu, Database, Plus, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, PageHeader, ProgressBar, StatusBadge } from '../components/ui';
import { useApp } from '../context/AppContext';
import { taskLabels } from '../data/catalog';
import type { WorkspaceActivity } from '../types';

type ActivityTone = 'blue' | 'green' | 'orange';

function metadataText(activity: WorkspaceActivity, key: string) {
  const value = activity.metadata[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

export function describeActivity(activity: WorkspaceActivity): { title: string; detail: string; tone: ActivityTone } {
  const actor = activity.actor?.displayName ?? '系统';
  const name = metadataText(activity, 'name');
  const version = metadataText(activity, 'version');
  const model = metadataText(activity, 'model');
  const format = metadataText(activity, 'format');
  const filename = metadataText(activity, 'filename');
  const stage = metadataText(activity, 'stage');
  const count = metadataText(activity, 'count');

  switch (activity.action) {
    case 'dataset.create': return { title: name ? `创建数据集：${name}` : '创建数据集', detail: actor, tone: 'blue' };
    case 'dataset.classes.update': return { title: '更新数据集类别', detail: actor, tone: 'blue' };
    case 'dataset.image.upload': return { title: filename ? `上传图像：${filename}` : '上传数据集图像', detail: actor, tone: 'blue' };
    case 'dataset.delete': return { title: '删除数据集及产物', detail: actor, tone: 'orange' };
    case 'dataset.export.create': return { title: format ? `创建 ${format} 数据导出` : '创建数据导出', detail: actor, tone: 'blue' };
    case 'annotation.save': return { title: count ? `保存标注：${count} 个对象` : '保存图像标注', detail: actor, tone: 'blue' };
    case 'annotation.review.submit': return { title: '提交标注审核', detail: actor, tone: 'blue' };
    case 'annotation.review.approve': return { title: '审核通过标注', detail: actor, tone: 'green' };
    case 'annotation.review.reject': return { title: '退回标注', detail: actor, tone: 'orange' };
    case 'training.create': return { title: '创建训练任务', detail: [actor, model, version].filter(Boolean).join(' · '), tone: 'green' };
    case 'training.retry': return { title: '重新提交训练任务', detail: [actor, model].filter(Boolean).join(' · '), tone: 'green' };
    case 'training.cancel': return { title: '取消训练任务', detail: actor, tone: 'orange' };
    case 'training.delete': return { title: name ? `删除训练任务：${name}` : '删除训练任务及产物', detail: actor, tone: 'orange' };
    case 'model.upload': return { title: filename ? `上传模型：${filename}` : '上传模型', detail: actor, tone: 'green' };
    case 'model.stage.update': return { title: stage ? `模型阶段更新为${stage}` : '更新模型阶段', detail: actor, tone: 'green' };
    case 'model.delete': return { title: name ? `删除模型：${name}` : '删除模型及产物', detail: [actor, version].filter(Boolean).join(' · '), tone: 'orange' };
    case 'conversion.create': return { title: format ? `创建 ${format} 模型转换` : '创建模型转换', detail: actor, tone: 'green' };
    case 'conversion.cancel': return { title: '取消模型转换', detail: actor, tone: 'orange' };
    case 'conversion.delete': return { title: format ? `删除 ${format} 转换任务` : '删除转换任务及产物', detail: actor, tone: 'orange' };
    case 'storage.gc': return { title: '清理无主磁盘产物', detail: actor, tone: 'orange' };
    default: return { title: '更新工作空间资源', detail: actor, tone: 'blue' };
  }
}

function formatActivityTime(createdAt: string) {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return '--';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return '刚刚';
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}分钟前`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}小时前`;
  if (elapsedSeconds < 604800) return `${Math.floor(elapsedSeconds / 86400)}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function DashboardPage() {
  const { datasets, jobs, models, activities, annotationStatistics, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled } = useApp();
  const runningJobs = jobs.filter((job) => job.status === 'running').length;
  const queuedJobs = jobs.filter((job) => job.status === 'queued').length;
  const reviewDatasets = datasets.filter((dataset) => dataset.status === '待审核').length;
  const candidateModels = models.filter((model) => model.stage === '生产候选').length;

  return (
    <div className="page dashboard-page">
      <PageHeader title="工作台" description={gpuEnabled ? '企业内网单租户模型生产环境' : 'CPU 模式：训练、ONNX 转换和数据处理可用'} actions={(gpuEnabled || cpuTrainingEnabled) ? <Link className="button primary" to="/training/new"><Plus size={17} />新建训练</Link> : <button className="button primary" disabled><Plus size={17} />训练不可用</button>} />

      <section className="stat-grid" aria-label="工作空间概况">
        <article className="stat-item"><span className="stat-icon blue"><Database size={20} /></span><div><small>数据集</small><strong>{datasets.length}</strong><span><b>{reviewDatasets}</b> 个待审核</span></div></article>
        <article className="stat-item"><span className="stat-icon cyan"><Sparkles size={20} /></span><div><small>运行中训练</small><strong>{runningJobs}</strong><span><b>{queuedJobs}</b> 个排队任务</span></div></article>
        <article className="stat-item"><span className="stat-icon violet"><Boxes size={20} /></span><div><small>模型版本</small><strong>{models.length}</strong><span><b>{candidateModels}</b> 个生产候选</span></div></article>
        <article className="stat-item"><span className="stat-icon green"><Cpu size={20} /></span><div><small>计算 Worker</small><strong>{gpuEnabled ? 'GPU' : cpuTrainingEnabled ? 'CPU' : '未启用'}</strong><span>{gpuEnabled ? '全格式训练和转换' : cpuOnnxEnabled ? 'CPU 训练与模型转换' : '仅数据处理'}</span></div></article>
      </section>

      {annotationStatistics && <section className="panel annotation-statistics-panel"><header className="section-header"><div><h2>标注与审核统计</h2><p>按最终有效结果统计，审核员修改单独计量</p></div></header><dl className="config-grid"><div><dt>标注员创建对象</dt><dd>{annotationStatistics.annotatorCreatedObjects}</dd></div><div><dt>最终有效对象</dt><dd>{annotationStatistics.finalEffectiveObjects}</dd></div><div><dt>完成帧数</dt><dd>{annotationStatistics.completedFrames}</dd></div><div><dt>完成 Job</dt><dd>{annotationStatistics.completedJobs}</dd></div><div><dt>审核新增</dt><dd>{annotationStatistics.reviewerAddedObjects}</dd></div><div><dt>审核修改</dt><dd>{annotationStatistics.reviewerModifiedObjects}</dd></div><div><dt>审核删除</dt><dd>{annotationStatistics.reviewerDeletedObjects}</dd></div><div><dt>通过 / 退回 Job</dt><dd>{annotationStatistics.approvedJobs} / {annotationStatistics.rejectedJobs}</dd></div></dl></section>}

      <div className="dashboard-layout">
        <section className="panel training-overview">
          <header className="section-header"><div><h2>训练运行</h2><p>当前训练与排队任务</p></div><Link className="text-link" to="/training">查看全部 <ArrowRight size={15} /></Link></header>
          {jobs.length === 0 ? <EmptyState icon={Sparkles} title="暂无训练任务" description={(gpuEnabled || cpuTrainingEnabled) ? '导入数据并创建首个训练任务' : '当前部署未启用训练 Worker'} action={(gpuEnabled || cpuTrainingEnabled) ? <Link className="button secondary compact" to="/training/new">创建训练</Link> : undefined} /> : <div className="job-list compact">{jobs.slice(0, 3).map((job) => <Link className="job-row" to={`/training/${job.id}`} key={job.id}><div className={`task-type-icon ${job.type}`}><Sparkles size={18} /></div><div className="job-main"><div className="job-title"><strong>{job.name}</strong><StatusBadge status={job.status} /></div><span>{taskLabels[job.type]} · {job.model} · {job.dataset}</span>{(job.status === 'running' || job.status === 'queued') && <ProgressBar value={job.progress} label={`${job.progress}% · ${job.epoch}`} />}</div><div className="job-metric"><small>{job.metricName}</small><strong>{job.metricValue}</strong></div><ArrowRight className="row-arrow" size={17} /></Link>)}</div>}
        </section>

        <aside className="panel cluster-panel">
          <header className="section-header"><div><h2>计算资源</h2><p>{gpuEnabled ? 'GPU Worker 已启用' : 'CPU Worker 已启用'}</p></div></header>
          <EmptyState icon={Cpu} title={gpuEnabled ? '等待资源遥测' : cpuTrainingEnabled ? 'CPU 计算可用' : '训练 Worker 未启用'} description={gpuEnabled ? 'GPU 利用率、显存和功耗将在 Worker 上报后显示' : cpuTrainingEnabled ? 'CPU 可执行训练与 FP32 ONNX 转换，耗时高于 GPU。' : '请在部署配置中启用计算 Worker。'} />
        </aside>
      </div>

      <div className="dashboard-bottom">
        <section className="panel dataset-health">
          <header className="section-header"><div><h2>数据准备度</h2><p>可用于训练的数据版本</p></div><Link className="text-link" to="/datasets">数据中心 <ArrowRight size={15} /></Link></header>
          {datasets.length === 0 ? <EmptyState icon={Database} title="暂无数据集" description="导入图像和标注后在这里查看训练准备度" /> : <div className="dataset-mini-grid">{datasets.map((dataset) => { const progress = dataset.images ? Math.round(dataset.annotated / dataset.images * 100) : 0; return <article key={dataset.id}><div className="dataset-mini-head"><span className="dataset-glyph"><Database size={17} /></span><div><strong>{dataset.name}</strong><small>{dataset.version}</small></div></div><ProgressBar value={progress} label={`${dataset.annotated.toLocaleString()} / ${dataset.images.toLocaleString()} · ${progress}%`} tone={progress === 100 ? 'green' : 'blue'} /></article>; })}</div>}
        </section>

        <section className="panel activity-panel">
          <header className="section-header"><div><h2>近期活动</h2><p>工作空间的重要变更</p></div></header>
          {activities.length === 0 ? <EmptyState icon={Boxes} title="暂无活动记录" description="数据、训练和模型操作将在这里汇总" /> : <div className="activity-list">{activities.map((activity) => {
            const presentation = describeActivity(activity);
            return <article className="activity-item" key={activity.id}><time dateTime={activity.createdAt} title={new Date(activity.createdAt).toLocaleString('zh-CN')}>{formatActivityTime(activity.createdAt)}</time><i className={presentation.tone} aria-hidden="true" /><div><strong>{presentation.title}</strong><span>{presentation.detail}</span></div></article>;
          })}</div>}
        </section>
      </div>
    </div>
  );
}
