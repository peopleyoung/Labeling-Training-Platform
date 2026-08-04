import { useMemo, useState } from 'react';
import { Archive, ArrowRight, Boxes, Braces, ChevronDown, Download, GitBranch, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, Modal, PageHeader, Pagination } from '../components/ui';
import { useApp } from '../context/AppContext';
import { taskLabels } from '../data/catalog';
import type { ModelVersion, TrainingType } from '../types';

type ModelFilter = 'all' | TrainingType;

function displayModelVersion(model: ModelVersion) {
  return model.sourceJob !== 'manual-upload' && model.version === model.sourceJob ? '历史版本' : model.version;
}

export function ModelsPage() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModelFilter>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadVersion, setUploadVersion] = useState('v1');
  const [uploadTask, setUploadTask] = useState<TrainingType>('detection');
  const [uploadFramework, setUploadFramework] = useState('PyTorch');
  const [uploadStage, setUploadStage] = useState<ModelVersion['stage']>('评估中');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ModelVersion | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { models: modelVersions, jobs, conversions, session, uploadModel, updateModelStage, deleteModel, downloadArtifact, notify } = useApp();
  const filteredModels = useMemo(() => modelVersions.filter((model) => (filter === 'all' || model.task === filter) && `${model.name}${displayModelVersion(model)}${model.framework}`.toLowerCase().includes(query.toLowerCase())).sort((left, right) => newestFirst ? right.createdAt.localeCompare(left.createdAt) : left.createdAt.localeCompare(right.createdAt)), [modelVersions, filter, newestFirst, query]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredModels.length / pageSize)));
  const models = useMemo(() => filteredModels.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, filteredModels, pageSize]);
  const sourceJobNames = useMemo(() => new Map(jobs.map((job) => [job.id, job.name])), [jobs]);
  const sourceLabel = (model: ModelVersion) => model.sourceJob === 'manual-upload' ? '人工上传' : sourceJobNames.get(model.sourceJob) ? `训练任务：${sourceJobNames.get(model.sourceJob)}` : '训练产出';
  const candidateCount = modelVersions.filter((model) => model.stage === '生产候选').length;
  const artifactCount = modelVersions.reduce((total, model) => total + model.formats.length, 0);
  const detectionCount = modelVersions.filter((model) => model.task === 'detection').length;
  const segmentationCount = modelVersions.filter((model) => model.task === 'segmentation').length;
  const keypointCount = modelVersions.filter((model) => model.task === 'keypoint').length;
  const canDelete = session?.user.role === 'admin' || session?.user.role === 'engineer';
  const dependentConversionCount = deleteTarget ? conversions.filter((task) => task.modelName === deleteTarget.name && task.modelVersion === deleteTarget.version).length : 0;

  const submitUpload = async () => {
    if (!uploadName.trim() || !uploadFile) { notify('模型未上传', '请填写模型名称并选择权重文件', 'error'); return; }
    setUploading(true);
    try {
      await uploadModel({ name: uploadName.trim(), version: uploadVersion.trim() || 'v1', task: uploadTask, framework: uploadFramework.trim() || 'PyTorch', stage: uploadStage, file: uploadFile });
      setUploadOpen(false);
      setUploadName('');
      setUploadFile(null);
    } catch (error) { notify('模型上传失败', error instanceof Error ? error.message : '无法上传模型文件', 'error'); } finally { setUploading(false); }
  };

  const toggleArchive = async (model: ModelVersion) => {
    try { await updateModelStage(model.id, model.stage === '已归档' ? '评估中' : '已归档'); } catch (error) { notify('模型阶段未更新', error instanceof Error ? error.message : '无法更新模型阶段', 'error'); }
  };

  const download = async (model: ModelVersion) => {
    if (!model.artifactId) return;
    try { await downloadArtifact(model.artifactId); } catch (error) { notify('模型下载失败', error instanceof Error ? error.message : '无法读取模型产物', 'error'); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteModel(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      notify('模型未删除', error instanceof Error ? error.message : '无法删除模型及产物', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page models-page">
      <PageHeader title="模型仓库" description={`${modelVersions.length} 个模型版本 · ${artifactCount} 个部署格式产物`} actions={<><button className="button secondary" onClick={() => setUploadOpen(true)}><Upload size={16} />上传模型</button><Link className="button primary" to="/training/new"><Plus size={17} />训练新模型</Link></>} />

      <section className="model-summary-strip">
        <div><span className="summary-icon blue"><Boxes size={20} /></span><p><small>模型版本</small><strong>{modelVersions.length}</strong></p><b>训练产物</b></div>
        <div><span className="summary-icon green"><ShieldCheck size={20} /></span><p><small>生产候选</small><strong>{candidateCount}</strong></p><b>等待评审</b></div>
        <div><span className="summary-icon violet"><Braces size={20} /></span><p><small>部署格式</small><strong>{artifactCount}</strong></p><b>已登记产物</b></div>
      </section>

      <section className="data-toolbar">
        <div className="segmented tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setPage(1); }}>全部模型 <span>{modelVersions.length}</span></button><button className={filter === 'detection' ? 'active' : ''} onClick={() => { setFilter('detection'); setPage(1); }}>目标检测 <span>{detectionCount}</span></button><button className={filter === 'segmentation' ? 'active' : ''} onClick={() => { setFilter('segmentation'); setPage(1); }}>语义分割 <span>{segmentationCount}</span></button><button className={filter === 'keypoint' ? 'active' : ''} onClick={() => { setFilter('keypoint'); setPage(1); }}>关键点 <span>{keypointCount}</span></button></div>
        <div className="toolbar-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索模型与版本" /></div>
        <button className="button secondary compact" onClick={() => { setNewestFirst((value) => !value); setPage(1); }}>{newestFirst ? '最近更新' : '最早创建'} <ChevronDown size={14} /></button>
      </section>

      <section className="table-panel">
        <div className="table-scroll">
          <table className="data-table models-table">
            <thead><tr><th>模型</th><th>当前版本</th><th>任务 / 框架</th><th>最佳指标</th><th>部署格式</th><th>阶段</th><th>创建时间</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td><div className="model-name-cell"><span className={`model-glyph ${model.task}`}><Sparkles size={20} /></span><div><strong>{model.name}</strong><span><GitBranch size={13} />{sourceLabel(model)}</span></div></div></td>
                  <td><strong className="model-version">{displayModelVersion(model)}</strong><span className="cell-subtext">{model.size}</span></td>
                  <td><span className="neutral-badge">{taskLabels[model.task]}</span><span className="cell-subtext">{model.framework}</span></td>
                  <td><span className="metric-cell"><small>{model.metricName}</small><strong>{model.metricValue}</strong></span></td>
                  <td><div className="format-chips">{model.formats.map((format) => <span key={format}>{format}</span>)}<Link to={`/conversions?source=${model.id}`} aria-label="添加转换"><Plus size={14} /></Link></div></td>
                  <td><span className={`stage-badge stage-${model.stage}`}>{model.stage}</span></td>
                  <td>{model.createdAt}</td>
                  <td><div className="row-actions">{model.artifactId && <button className="icon-button bordered" title="下载模型" aria-label={`下载 ${model.name}`} onClick={() => void download(model)}><Download size={16} /></button>}<Link className="button compact secondary" to={`/conversions?source=${model.id}`}>转换 <ArrowRight size={15} /></Link><button className="icon-button" title={model.stage === '已归档' ? '恢复评估' : '归档模型'} aria-label={model.stage === '已归档' ? `恢复 ${model.name}` : `归档 ${model.name}`} onClick={() => void toggleArchive(model)}><Archive size={17} /></button>{canDelete && <button className="icon-button" title="删除模型及产物" aria-label={`删除 ${model.name}`} onClick={() => setDeleteTarget(model)}><Trash2 size={17} /></button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredModels.length > 0 && <Pagination page={currentPage} pageSize={pageSize} totalItems={filteredModels.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />}
        {filteredModels.length === 0 && <EmptyState icon={Boxes} title={modelVersions.length ? '没有匹配的模型' : '暂无模型版本'} description={modelVersions.length ? '调整搜索条件后重试' : '完成训练或上传模型后，版本会出现在这里'} />}
      </section>

      <section className="registry-band"><span className="band-icon"><GitBranch size={20} /></span><div><strong>模型血缘登记</strong><p>{modelVersions.length ? '当前模型版本可追溯到来源训练任务和评估结果。' : '生成首个模型后，平台将在这里建立训练与转换血缘。'}</p></div><button className="text-link" disabled={!modelVersions.length} onClick={() => setLineageOpen(true)}>查看资产谱系 <ArrowRight size={15} /></button></section>

      {uploadOpen && <Modal title="上传模型" description="模型文件会写入制品存储，并登记为可追溯模型版本。" onClose={() => !uploading && setUploadOpen(false)} footer={<><button className="button secondary" onClick={() => setUploadOpen(false)} disabled={uploading}>取消</button><button className="button primary" onClick={() => void submitUpload()} disabled={uploading}>{uploading ? '正在上传' : '上传并登记'}</button></>}><div className="form-grid two"><label className="form-field"><span>模型名称</span><input value={uploadName} onChange={(event) => setUploadName(event.target.value)} /></label><label className="form-field"><span>版本</span><input value={uploadVersion} onChange={(event) => setUploadVersion(event.target.value)} /></label><label className="form-field"><span>任务类型</span><select value={uploadTask} onChange={(event) => setUploadTask(event.target.value as TrainingType)}><option value="detection">目标检测</option><option value="segmentation">语义分割</option><option value="keypoint">关键点检测</option><option value="sdxl">SDXL</option></select></label><label className="form-field"><span>框架</span><input value={uploadFramework} onChange={(event) => setUploadFramework(event.target.value)} /></label><label className="form-field"><span>模型阶段</span><select value={uploadStage} onChange={(event) => setUploadStage(event.target.value as ModelVersion['stage'])}><option>评估中</option><option>生产候选</option><option>已归档</option></select></label><label className="form-field"><span>权重文件</span><input type="file" accept=".pt,.pth,.onnx,.safetensors,.torchscript,.xml,.bin" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /><small>最大 512 MB</small></label></div></Modal>}
      {deleteTarget && <Modal title="删除模型及产物" description={`确认删除“${deleteTarget.name} ${displayModelVersion(deleteTarget)}”？`} onClose={() => !deleting && setDeleteTarget(null)} footer={<><button className="button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="button danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除' : '确认删除'}</button></>}><p className="modal-warning-copy">原始模型权重{dependentConversionCount ? `、${dependentConversionCount} 个转换任务及其产物` : '及关联产物'}将从本地制品存储永久删除，无法恢复。</p></Modal>}
      {lineageOpen && <Modal title="模型资产谱系" description="训练任务或人工上传来源，以及当前部署格式。" onClose={() => setLineageOpen(false)} footer={<button className="button primary" onClick={() => setLineageOpen(false)}>关闭</button>}><div className="lineage-list">{modelVersions.map((model) => <div key={model.id}><span className={`model-glyph ${model.task}`}><GitBranch size={17} /></span><span><strong>{model.name} {displayModelVersion(model)}</strong><small>来源：{sourceLabel(model)} · {model.framework}</small></span><span>{model.formats.length ? model.formats.join(' / ') : '原始模型'}</span></div>)}</div></Modal>}
    </div>
  );
}
