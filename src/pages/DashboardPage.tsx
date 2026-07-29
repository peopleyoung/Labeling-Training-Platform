import { ArrowRight, Boxes, Cpu, Database, Plus, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, PageHeader, ProgressBar, StatusBadge } from '../components/ui';
import { useApp } from '../context/AppContext';
import { taskLabels } from '../data/catalog';

export function DashboardPage() {
  const { datasets, jobs, models, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled } = useApp();
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
          <EmptyState icon={Boxes} title="暂无活动记录" description="数据、训练和模型操作将在这里汇总" />
        </section>
      </div>
    </div>
  );
}
