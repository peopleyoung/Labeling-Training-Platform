import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Download, Folder, FolderTree, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Modal, PageHeader } from '../components/ui';
import { BusinessTaskSelect } from '../components/BusinessTaskSelect';
import { useApp } from '../context/AppContext';
import { ApiClient } from '../services/apiClient';
import type { Dataset, ExportTask } from '../../shared/contracts';
import type { BusinessTask, DataCenterQuery, DataCenterResult, TaskCatalog } from '../../shared/taskCatalog';
import { dataFormatDescriptions } from '../data/catalog';
import './dataCenter.css';

const dateText = (value?: string) => value ? new Date(value).toLocaleString() : '--';
const exportFormats: ExportTask['format'][] = ['YOLO', 'COCO', 'VOC', 'YOLO_SEGMENTATION', 'COCO_SEGMENTATION', 'PNG_MASK', 'YOLO_KEYPOINTS', 'COCO_KEYPOINTS', 'IMAGE_FOLDER', 'CVAT_JSON', 'CVAT_XML'];
const emptyFilters = { from: '', to: '', categoryCode: '', taskTypeCode: '', query: '' };

export function DataCenterPage() {
  const { session } = useApp();
  const client = useMemo(() => new ApiClient(() => session?.accessToken ?? null), [session?.accessToken]);
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<TaskCatalog>({ categories: [], taskTypes: [] });
  const [result, setResult] = useState<DataCenterResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Dataset>();
  const query = useMemo(() => ({ ...applied, timezoneOffset: new Date().getTimezoneOffset(), page: 1, pageSize: 20 }), [applied]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setResult(undefined);
    void Promise.all([client.taskCatalog(), client.dataCenter(query)]).then(([c, r]) => { if (active) { setCatalog(c); setResult(r); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '数据加载失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, query, revision]);
  const filteredTasks = catalog.taskTypes.filter((t) => !filters.categoryCode || catalog.categories.some((c) => c.code === filters.categoryCode && c.id === t.categoryId));
  return <div className="page data-center-page">
    <PageHeader title="数据中心" actions={<><Link className="button secondary" to="/admin/task-catalog"><FolderTree size={16} />任务类型目录</Link><button className="icon-button" title="刷新数据" aria-label="刷新数据" disabled={loading} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={17} /></button></>} />
    <form className="dc-filters" onSubmit={(e) => { e.preventDefault(); setApplied({ ...filters }); }}>
      <label className="form-field dc-search"><span>数据集</span><input aria-label="搜索数据集" placeholder="名称或版本" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} /></label>
      <label className="form-field"><span>创建开始日期</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
      <label className="form-field"><span>创建结束日期</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
      <label className="form-field"><span>任务大类</span><select value={filters.categoryCode} onChange={(e) => setFilters({ ...filters, categoryCode: e.target.value, taskTypeCode: '' })}><option value="">全部大类</option>{catalog.categories.map((c) => <option key={c.id} value={c.code}>{c.name}{!c.enabled ? '（已停用）' : ''}</option>)}</select></label>
      <label className="form-field"><span>业务任务</span><select value={filters.taskTypeCode} onChange={(e) => setFilters({ ...filters, taskTypeCode: e.target.value })}><option value="">全部业务任务</option>{filteredTasks.map((t) => <option key={t.id} value={t.code}>{t.name}{!t.enabled ? '（已停用）' : ''}</option>)}</select></label>
      <div className="dc-filter-actions"><button type="submit" className="button primary"><Search size={16} />搜索</button><button type="button" className="button secondary" onClick={() => { setFilters(emptyFilters); setApplied({ ...emptyFilters }); }}>重置</button></div>
    </form>
    <section className="dc-tree" aria-label="数据集目录" aria-busy={loading}>
      <header className="dc-tree-heading"><h2>已审核数据集</h2><span>{result?.total ?? 0} 个数据集</span></header>
      {error && <p role="alert" className="dc-error">{error}</p>}
      {loading ? <p className="dc-empty">正在加载数据</p> : !error && !result?.total ? <p className="dc-empty">暂无符合条件的已审核数据集</p> : null}
      {result?.categories.map((category) => <details className="dc-category" key={category.id} open><summary><Folder size={18} /><strong>{category.name}</strong>{!category.enabled && <span className="dc-disabled">已停用</span>}<span className="dc-count">{category.datasetCount}</span></summary>
        {result.taskTypes.filter((t) => t.categoryId === category.id).map((task) => <TaskBranch key={`${task.id}-${revision}-${JSON.stringify(applied)}`} task={task} client={client} query={query} onSelect={setSelected} />)}
      </details>)}
    </section>
    {selected && <DatasetDetails dataset={selected} catalog={catalog} client={client} onClose={() => setSelected(undefined)} onBindingChanged={(dataset) => { setSelected(dataset); setRevision((n) => n + 1); }} />}
  </div>;
}

function TaskBranch({ task, client, query, onSelect }: { task: BusinessTask; client: ApiClient; query: Partial<DataCenterQuery>; onSelect: (dataset: Dataset) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DataCenterResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true; setLoading(true); setError('');
    void client.dataCenter({ ...query, taskTypeCode: task.code, page }).then((r) => { if (active) setResult(r); }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '加载失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, client, query, task.code, page, retry]);
  return <div className="dc-task"><button className="dc-task-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<FolderTree size={16} /><strong>{task.name}</strong>{!task.enabled && <span className="dc-disabled">已停用</span>}<span className="dc-count">{task.datasetCount}</span></button>
    {open && <div className="dc-leaves" aria-busy={loading}>{error ? <p role="alert" className="dc-error">{error} <button onClick={() => setRetry((n) => n + 1)}>重试</button></p> : loading ? <p className="dc-empty">正在加载数据集</p> : <>
      {result?.items.map((dataset) => <button className="dc-leaf" key={dataset.id} onClick={() => onSelect(dataset)}><Database size={18} /><span className="dc-leaf-name"><strong>{dataset.name}</strong><small>{dataset.version} · {dateText(dataset.createdAt)}</small></span><span>{dataset.images} 张图片<small>{dataset.annotated} 张已标注</small></span><span>{dataset.size}</span><ChevronRight size={16} /></button>)}
      {result && result.total > result.pageSize && <div className="dc-pagination"><button className="icon-button" aria-label={`${task.name}上一页`} title="上一页" disabled={page === 1} onClick={() => setPage((n) => n - 1)}><ChevronRight size={17} style={{ transform: 'rotate(180deg)' }} /></button><span>{page} / {Math.ceil(result.total / result.pageSize)}</span><button className="icon-button" aria-label={`${task.name}下一页`} title="下一页" disabled={page * result.pageSize >= result.total} onClick={() => setPage((n) => n + 1)}><ChevronRight size={17} /></button></div>}
    </>}</div>}
  </div>;
}

function DatasetDetails({ dataset, catalog, client, onClose, onBindingChanged }: { dataset: Dataset; catalog: TaskCatalog; client: ApiClient; onClose: () => void; onBindingChanged: (dataset: Dataset) => void }) {
  const { exports, loadDatasetExports, createDatasetExport, downloadArtifact, refreshDatasets } = useApp();
  const task = catalog.taskTypes.find((t) => t.id === dataset.taskTypeId);
  const category = catalog.categories.find((c) => c.id === task?.categoryId);
  const [target, setTarget] = useState('');
  const [editing, setEditing] = useState(false);
  const [format, setFormat] = useState<ExportTask['format']>('COCO');
  const [includeImages, setIncludeImages] = useState(true);
  const [version, setVersion] = useState(`${dataset.name}_${dataset.version}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentExports = exports.filter((item) => item.datasetId === dataset.id);
  useEffect(() => {
    let active = true;
    const load = () => void loadDatasetExports(dataset.id).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '导出记录加载失败'); });
    load(); const timer = window.setInterval(load, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [dataset.id, loadDatasetExports]);
  const bind = async () => {
    if (!window.confirm(`将“${dataset.name}”改绑到所选业务任务？此操作将记录审计日志。`)) return;
    setBusy(true); setError('');
    try { const next = await client.bindDataset(dataset.id, target, dataset.taskTypeId ?? null); setEditing(false); onBindingChanged(next); void refreshDatasets().catch(() => undefined); }
    catch (e) { setError(e instanceof Error ? e.message : '改绑失败'); } finally { setBusy(false); }
  };
  const exportData = async () => {
    setBusy(true); setError('');
    try { await createDatasetExport(dataset.id, { format, versionName: version, includeImages }); await loadDatasetExports(dataset.id); }
    catch (e) { setError(e instanceof Error ? e.message : '导出失败'); } finally { setBusy(false); }
  };
  return <Modal title={dataset.name} width="large" onClose={() => !busy && onClose()}>
    <div className="dc-detail">{error && <p role="alert" className="dc-error">{error}</p>}
      <dl className="dc-metadata">{[['任务大类', category?.name], ['业务任务', task?.name], ['版本', dataset.version], ['创建时间', dateText(dataset.createdAt)], ['审核完成时间', dateText(dataset.approvedAt)], ['图片数', dataset.images], ['已标注图片', dataset.annotated], ['类别数', dataset.classes.length], ['存储大小', dataset.size]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '--'}</dd></div>)}</dl>
      {dataset.description && <p>{dataset.description}</p>}<p>{dataset.classes.join('、')}</p>
      <section className="dc-detail-section"><header><h3>业务任务归属</h3><button className="button secondary compact" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? '取消修改' : '修改业务任务'}</button></header>{editing && <div className="dc-form"><BusinessTaskSelect value={target} onChange={setTarget} disabled={busy} /><button className="button primary" disabled={busy || !target || target === dataset.taskTypeId} onClick={() => void bind()}>确认改绑</button></div>}</section>
      <section className="dc-detail-section"><header><h3>数据导出</h3></header><div className="form-grid two"><label className="form-field"><span>格式</span><select value={format} onChange={(e) => setFormat(e.target.value as ExportTask['format'])}>{exportFormats.map((f) => <option key={f} value={f}>{dataFormatDescriptions[f].label}</option>)}</select></label><label className="form-field"><span>版本名称</span><input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={120} /></label></div><div className="dc-export-actions"><label className="dc-check"><input type="checkbox" checked={includeImages} onChange={(e) => setIncludeImages(e.target.checked)} />包含图像</label><button className="button primary" disabled={busy || !version.trim()} onClick={() => void exportData()}><Download size={16} />创建导出</button></div>
        {currentExports.map((item) => <div className="dc-export-row" key={item.id}><span>{item.versionName || item.id}<small>{item.format} · {item.status} · {item.progress}%</small>{item.errorMessage && <small className="dc-error">{item.errorMessage}</small>}</span>{item.artifactId && <button className="icon-button" title="下载导出" aria-label={`下载${item.versionName ?? item.id}`} onClick={() => void downloadArtifact(item.artifactId!).catch((e: unknown) => setError(e instanceof Error ? e.message : '下载失败'))}><Download size={17} /></button>}</div>)}
      </section>
    </div>
  </Modal>;
}
