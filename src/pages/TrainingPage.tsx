import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Plus, RotateCcw, Search, Server, Sparkles, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Modal, PageHeader, Pagination, ProgressBar, SegmentedControl, StatusBadge } from '../components/ui';
import { useApp } from '../context/AppContext';
import { taskLabels } from '../data/catalog';
import type { JobStatus, TrainingJob } from '../types';

type JobFilter = 'all' | JobStatus;

export function TrainingPage() {
  const navigate = useNavigate();
  const { jobs, session, retryTrainingJob, deleteTrainingJob, notify } = useApp();
  const [filter, setFilter] = useState<JobFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TrainingJob | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const filteredJobs = useMemo(() => jobs.filter((job) => (filter === 'all' || job.status === filter) && `${job.name}${job.config?.version ?? ''}${job.model}${job.dataset}`.toLowerCase().includes(query.toLowerCase())), [jobs, filter, query]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredJobs.length / pageSize)));
  const visibleJobs = useMemo(() => filteredJobs.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, filteredJobs, pageSize]);
  const runningCount = jobs.filter((item) => item.status === 'running').length;
  const queuedCount = jobs.filter((item) => item.status === 'queued').length;
  const completedCount = jobs.filter((item) => item.status === 'completed').length;
  const failedCount = jobs.filter((item) => item.status === 'failed').length;
  const canRetry = session?.user.role === 'admin' || session?.user.role === 'engineer';
  const retry = async (jobId: string) => {
    setRetryingJobId(jobId);
    try {
      const newJobId = await retryTrainingJob(jobId);
      navigate(`/training/${newJobId}`);
    } catch (error) {
      notify('重新训练失败', error instanceof Error ? error.message : '无法重新提交训练任务', 'error');
    } finally {
      setRetryingJobId(null);
    }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    setDeletingJobId(deleteTarget.id);
    try {
      await deleteTrainingJob(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      notify('训练任务未删除', error instanceof Error ? error.message : '无法删除训练任务', 'error');
    } finally {
      setDeletingJobId(null);
    }
  };

  return (
    <div className="page training-page">
      <PageHeader title="训练中心" description={`${jobs.length} 个任务 · ${runningCount} 个运行中 · ${queuedCount} 个排队中`} actions={<Link className="button primary" to="/training/new"><Plus size={17} />新建训练</Link>} />

      <section className="training-summary-strip">
        <div><span className="summary-signal running"><i /></span><span>运行中</span><strong>{runningCount}</strong><small>Worker 执行任务</small></div>
        <div><span className="summary-signal queued"><i /></span><span>排队中</span><strong>{queuedCount}</strong><small>等待资源分配</small></div>
        <div><span className="summary-signal completed"><i /></span><span>已完成</span><strong>{completedCount}</strong><small>全部历史任务</small></div>
        <div><span className="summary-signal failed"><i /></span><span>需要处理</span><strong>{failedCount}</strong><small>查看失败原因</small></div>
      </section>

      <section className="data-toolbar training-toolbar">
        <SegmentedControl<JobFilter>
          ariaLabel="训练状态筛选"
          value={filter}
          onChange={(value) => { setFilter(value); setPage(1); }}
          options={[{ value: 'all', label: '全部' }, { value: 'running', label: '运行中' }, { value: 'queued', label: '排队中' }, { value: 'completed', label: '已完成' }, { value: 'failed', label: '失败' }]}
        />
        <div className="toolbar-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索训练任务或版本" /></div>
      </section>

      <section className="table-panel">
        <div className="table-scroll">
          <table className="data-table training-table">
            <thead><tr><th>任务</th><th>状态 / 进度</th><th>当前轮次</th><th>最佳指标</th><th>计算资源</th><th>创建时间</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {visibleJobs.map((job) => (
                <tr key={job.id}>
                  <td><Link className="training-name-cell" to={`/training/${job.id}`}><span className={`task-type-icon ${job.type}`}><Sparkles size={18} /></span><div><strong>{job.name}</strong><span>{taskLabels[job.type]} · {job.model} · {job.config?.version ?? '历史版本'}</span><small>{job.dataset}</small></div></Link></td>
                  <td><div className="status-progress"><StatusBadge status={job.status} />{job.status !== 'completed' && job.status !== 'failed' && <ProgressBar value={job.progress} />}{job.status === 'failed' && <span className="failure-reason"><AlertTriangle size={14} />{job.eta}</span>}</div></td>
                  <td><strong>{job.epoch}</strong><span className="cell-subtext">{job.status === 'running' ? job.eta : job.status === 'queued' ? '等待资源' : '训练结束'}</span></td>
                  <td><span className="metric-cell"><small>{job.metricName}</small><strong>{job.metricValue}</strong></span></td>
                  <td><span className="resource-cell"><Server size={15} />{job.gpu}</span></td>
                  <td><span>{job.createdAt}</span></td>
                  <td><div className="row-actions">{canRetry && job.status === 'failed' && <button className="icon-button bordered" type="button" disabled={retryingJobId === job.id} onClick={() => void retry(job.id)} aria-label={`重新训练 ${job.name}`} title="重新训练"><RotateCcw size={16} /></button>}{canRetry && job.status !== 'queued' && job.status !== 'running' && <button className="icon-button bordered" type="button" disabled={deletingJobId === job.id} onClick={() => setDeleteTarget(job)} aria-label={`删除 ${job.name}`} title="删除任务"><Trash2 size={16} /></button>}<Link className="icon-button bordered" to={`/training/${job.id}`} aria-label={`查看 ${job.name}`}><ArrowRight size={16} /></Link></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredJobs.length > 0 && <Pagination page={currentPage} pageSize={pageSize} totalItems={filteredJobs.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />}
        {filteredJobs.length === 0 && <div className="empty-table"><Search size={24} /><strong>{jobs.length ? '没有匹配的训练任务' : '暂无训练任务'}</strong><span>{jobs.length ? '调整状态筛选或搜索内容' : '准备数据后创建首个训练任务'}</span></div>}
      </section>
      {deleteTarget && <Modal title="删除训练任务及产物" description={`确认删除“${deleteTarget.name}”？`} onClose={() => !deletingJobId && setDeleteTarget(null)} footer={<><button className="button secondary" disabled={Boolean(deletingJobId)} onClick={() => setDeleteTarget(null)}>取消</button><button className="button danger" disabled={Boolean(deletingJobId)} onClick={() => void remove()}>{deletingJobId ? '正在删除' : '确认删除'}</button></>}><p className="modal-warning-copy">任务历史、日志、训练指标、权重文件，以及由该任务生成的模型版本和转换产物都将被永久删除。</p></Modal>}
    </div>
  );
}
