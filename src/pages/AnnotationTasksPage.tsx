import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ClipboardList, FileStack, Plus, Search, ShieldCheck } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EmptyState, PageHeader, ProgressBar } from '../components/ui';
import { useApp } from '../context/AppContext';
import type { AnnotationJob, AnnotationSegment, Dataset } from '../types';
import { effectiveUserRoles } from '../../shared/contracts';

const jobStatusLabels: Record<AnnotationJob['status'], string> = {
  available: '待领取',
  claimed: '已领取',
  in_progress: '标注中',
  submitted: '待审核',
  reviewing: '审核中',
  approved: '已完成',
  rework: '返工',
  cancelled: '已取消',
};

const taskStatusLabels: Record<Dataset['status'], string> = {
  '标注中': '标注中',
  '待审核': '审核中',
  '可训练': '已完成',
};

function progressValue(dataset: Dataset) {
  return dataset.images ? Math.round((dataset.annotated / dataset.images) * 100) : 0;
}

export function AnnotationTasksPage() {
  const { datasets, session } = useApp();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | Dataset['status']>('all');
  const navigate = useNavigate();
  const userRoles = session ? effectiveUserRoles(session.user) : [];
  const visibleDatasets = useMemo(() => datasets.filter((dataset) => {
    const matchesFilter = filter === 'all' || dataset.status === filter;
    const matchesQuery = !query.trim() || `${dataset.name} ${dataset.description}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesFilter && matchesQuery;
  }), [datasets, filter, query]);

  return (
    <div className="page reference-task-page">
      <PageHeader
        title="任务"
        description={`${datasets.length} 个标注任务`}
        actions={userRoles.includes('admin') ? <button className="button primary" onClick={() => navigate('/tasks?create=1')}><Plus size={17} />创建任务</button> : undefined}
      />
      <section className="reference-task-toolbar">
        <div className="segmented tabs" aria-label="任务状态">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <span>{datasets.length}</span></button>
          <button className={filter === '标注中' ? 'active' : ''} onClick={() => setFilter('标注中')}>标注中 <span>{datasets.filter((item) => item.status === '标注中').length}</span></button>
          <button className={filter === '待审核' ? 'active' : ''} onClick={() => setFilter('待审核')}>审核中 <span>{datasets.filter((item) => item.status === '待审核').length}</span></button>
          <button className={filter === '可训练' ? 'active' : ''} onClick={() => setFilter('可训练')}>已完成 <span>{datasets.filter((item) => item.status === '可训练').length}</span></button>
        </div>
        <label className="reference-task-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称" /></label>
      </section>
      {visibleDatasets.length ? <section className="reference-task-grid">{visibleDatasets.map((dataset) => <TaskCard key={dataset.id} dataset={dataset} />)}</section> : <EmptyState icon={ClipboardList} title="没有匹配任务" description="调整筛选条件或创建一个新的标注任务。" />}
    </div>
  );
}

function TaskCard({ dataset }: { dataset: Dataset }) {
  const progress = progressValue(dataset);
  return (
    <article className="reference-task-card">
      <header><div><span className="reference-task-id">#{dataset.id}</span><h2>{dataset.name}</h2><p>{dataset.description || '暂无任务说明'}</p></div><span className={`reference-task-status status-${dataset.status}`}>{taskStatusLabels[dataset.status]}</span></header>
      <div className="reference-task-meta"><span>由系统创建</span><span>版本 {dataset.version}</span><span>{dataset.images.toLocaleString()} 张图像</span></div>
      <div className="reference-task-progress"><div><span>标注进度</span><strong>{dataset.annotated.toLocaleString()} / {dataset.images.toLocaleString()}</strong></div><ProgressBar value={progress} tone={progress === 100 ? 'green' : 'blue'} /></div>
      <div className="reference-task-card-footer"><div className="class-chips">{dataset.classes.slice(0, 3).map((item) => <span key={item}>{item}</span>)}{dataset.classes.length > 3 && <b>+{dataset.classes.length - 3}</b>}</div><Link className="button compact secondary" to={`/tasks/${dataset.id}`}>打开 <ArrowRight size={15} /></Link></div>
    </article>
  );
}

export function AnnotationTaskDetailPage() {
  const { datasetId = '' } = useParams();
  const { datasets, annotationSegments, annotationJobs, claimNextAnnotationJob, claimAnnotationReviewJob, datasetImages, notify, session } = useApp();
  const navigate = useNavigate();
  const [segments, setSegments] = useState<AnnotationSegment[]>([]);
  const [jobs, setJobs] = useState<AnnotationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const dataset = datasets.find((item) => item.id === datasetId);
  const isReviewer = session ? effectiveUserRoles(session.user).some((role) => role === 'admin' || role === 'reviewer') : false;

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    setLoading(true);
    void Promise.all([annotationSegments(datasetId), annotationJobs(datasetId)]).then(([segmentList, jobList]) => {
      if (!active) return;
      setSegments(segmentList);
      setJobs(jobList);
    }).catch((error: unknown) => notify('任务段加载失败', error instanceof Error ? error.message : '无法读取任务段')).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [annotationJobs, annotationSegments, datasetId, notify]);

  const openJob = async (job: AnnotationJob) => {
    try {
      const openedJob = isReviewer && job.status === 'submitted'
        ? await claimAnnotationReviewJob(job.id)
        : !isReviewer && job.status === 'available'
          ? await claimNextAnnotationJob(datasetId)
          : job;
      if (!openedJob) throw new Error(isReviewer ? '当前没有可领取的待审核任务' : '当前任务段不可领取');
      const images = await datasetImages(datasetId);
      const segment = segments.find((item) => item.id === openedJob.segmentId);
      const firstImage = segment ? images.find((image) => image.id === segment.startItemId) : images[0];
      if (!firstImage) throw new Error('任务段没有可标注图片');
      navigate(`/annotate/${datasetId}/job/${encodeURIComponent(openedJob.id)}?image=${encodeURIComponent(firstImage.id)}${isReviewer && ['submitted', 'reviewing'].includes(openedJob.status) ? '&mode=review' : ''}`);
    } catch (error) { notify('无法打开 Job', error instanceof Error ? error.message : '无法读取任务资源'); }
  };

  if (!dataset) return <div className="page"><EmptyState icon={ClipboardList} title="任务不存在" description="请返回任务列表重新选择。" /></div>;
  return (
    <div className="page reference-task-detail-page">
      <PageHeader title={dataset.name} description={`任务 #${dataset.id} · ${dataset.images.toLocaleString()} 张图像`} actions={<Link className="button secondary" to="/tasks">返回任务</Link>} />
      <section className="reference-task-summary"><div><span>状态</span><strong>{taskStatusLabels[dataset.status]}</strong></div><div><span>标注进度</span><strong>{dataset.annotated.toLocaleString()} / {dataset.images.toLocaleString()}</strong></div><div><span>标签</span><strong>{dataset.classes.join('、') || '未配置'}</strong></div><div><span>分段大小</span><strong>{dataset.processingConfig?.segmentSize ?? 100}</strong></div></section>
      <section className="reference-task-detail-panel"><header><div><h2>任务段</h2><p>每个任务段对应一个可领取、编辑和审核的 Job。</p></div><span className="reference-task-count">{segments.length} 个任务段</span></header>
        {loading ? <div className="reference-loading">正在加载任务段…</div> : segments.length ? <div className="table-scroll"><table className="data-table reference-segments-table"><thead><tr><th>任务段</th><th>标识开始帧</th><th>标识结束帧</th><th>标注员</th><th>审核员</th><th>状态</th><th>操作</th></tr></thead><tbody>{segments.map((segment, index) => { const job = jobs.find((item) => item.segmentId === segment.id); return <tr key={segment.id}><td><strong>#{job?.sequence ?? index + 1}</strong><span className="cell-subtext">{segment.itemCount} 个对象</span></td><td>{index * (dataset.processingConfig?.segmentSize ?? 100)}</td><td>{index * (dataset.processingConfig?.segmentSize ?? 100) + segment.itemCount - 1}</td><td>{job?.assigneeId || '未分配'}</td><td>{job?.reviewerId || '未分配'}</td><td><span className={`job-status status-${job?.status ?? 'available'}`}>{job ? jobStatusLabels[job.status] : '待生成'}</span></td><td>{job ? <button className="button compact secondary" onClick={() => void openJob(job)}>{isReviewer ? <ShieldCheck size={15} /> : <FileStack size={15} />}查看</button> : <span className="cell-subtext">等待处理</span>}</td></tr>; })}</tbody></table></div> : <EmptyState icon={FileStack} title="暂无任务段" description="请先完成资源处理。" />}
      </section>
    </div>
  );
}
