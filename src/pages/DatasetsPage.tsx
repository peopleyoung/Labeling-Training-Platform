import { useMemo, useState } from 'react';
import { ArrowRight, Database, Download, FileArchive, FileJson, FileStack, Plus, ShieldCheck, Tags, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, Modal, PageHeader, ProgressBar } from '../components/ui';
import { useApp } from '../context/AppContext';
import { dataFormatDescriptions, taskLabels } from '../data/catalog';
import type { DataFormat, ExportTask, TrainingType } from '../types';
import { formatPercent } from '../utils/format';

type ExportFormat = ExportTask['format'];
type DatasetFilter = 'all' | '标注中' | '待审核' | '可训练';

const exportFormatGroups: { task: TrainingType; formats: { id: DataFormat; icon: typeof FileJson }[] }[] = [
  { task: 'detection', formats: [{ id: 'YOLO', icon: FileStack }, { id: 'COCO', icon: FileJson }, { id: 'VOC', icon: FileArchive }] },
  { task: 'segmentation', formats: [{ id: 'COCO_SEGMENTATION', icon: FileJson }, { id: 'PNG_MASK', icon: FileStack }] },
  { task: 'keypoint', formats: [{ id: 'COCO_KEYPOINTS', icon: FileJson }] },
  { task: 'sdxl', formats: [{ id: 'IMAGE_FOLDER', icon: FileJson }] },
];

export function DatasetsPage() {
  const [datasetModalOpen, setDatasetModalOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [datasetVersion, setDatasetVersion] = useState('v1');
  const [datasetClasses, setDatasetClasses] = useState('');
  const [datasetFiles, setDatasetFiles] = useState<File[]>([]);
  const [submittingDataset, setSubmittingDataset] = useState(false);
  const [filter, setFilter] = useState<DatasetFilter>('all');
  const [exportDatasetId, setExportDatasetId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('COCO');
  const [exportScope, setExportScope] = useState<NonNullable<ExportTask['scope']>>('all');
  const [exportVersionName, setExportVersionName] = useState('');
  const [includeImages, setIncludeImages] = useState(true);
  const [submittingExport, setSubmittingExport] = useState(false);
  const { datasets, exports, createDataset, uploadDatasetImages, datasetImages, deleteDataset, createDatasetExport, loadAnnotationReview, loadDatasetExports, downloadArtifact, notify, session } = useApp();
  const navigate = useNavigate();
  const exportDataset = datasets.find((dataset) => dataset.id === exportDatasetId);
  const totalImages = datasets.reduce((sum, dataset) => sum + dataset.images, 0);
  const annotatingCount = datasets.filter((dataset) => dataset.status === '标注中').length;
  const reviewCount = datasets.filter((dataset) => dataset.status === '待审核').length;
  const readyCount = datasets.filter((dataset) => dataset.status === '可训练').length;
  const visibleDatasets = useMemo(() => filter === 'all' ? datasets : datasets.filter((dataset) => dataset.status === filter), [datasets, filter]);
  const visibleExports = exports.filter((task) => task.datasetId === exportDatasetId);
  const canReview = session?.user.role === 'admin' || session?.user.role === 'engineer';

  const openCreateDataset = () => {
    setDatasetName('');
    setDatasetDescription('');
    setDatasetVersion('v1');
    setDatasetClasses('');
    setDatasetFiles([]);
    setDatasetModalOpen(true);
  };

  const submitDataset = async () => {
    if (!datasetName.trim()) {
      notify('数据集未创建', '请填写数据集名称', 'error');
      return;
    }
    setSubmittingDataset(true);
    try {
      const dataset = await createDataset({
        name: datasetName.trim(),
        description: datasetDescription.trim(),
        version: datasetVersion.trim() || 'v1',
        classes: datasetClasses.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
      });
      const images = datasetFiles.length ? await uploadDatasetImages(dataset.id, datasetFiles) : [];
      setDatasetModalOpen(false);
      if (images[0]) navigate(`/annotate/${dataset.id}?image=${encodeURIComponent(images[0].id)}`);
    } catch (error) {
      notify('数据集上传失败', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setSubmittingDataset(false);
    }
  };

  const annotateDataset = async (datasetId: string) => {
    try {
      const images = await datasetImages(datasetId);
      if (!images[0]) {
        notify('暂无可标注图像', '请先通过导入数据上传至少一张图像', 'info');
        return;
      }
      navigate(`/annotate/${datasetId}?image=${encodeURIComponent(images[0].id)}`);
    } catch (error) {
      notify('无法打开标注', error instanceof Error ? error.message : '无法读取数据集图像', 'error');
    }
  };

  const reviewDataset = async (datasetId: string) => {
    try {
      const [images, summary] = await Promise.all([datasetImages(datasetId), loadAnnotationReview(datasetId)]);
      const target = summary.items.find((item) => item.reviewStatus === 'submitted')?.imageId ?? images[0]?.id;
      if (!target) {
        notify('暂无可审核图像', '数据集没有可审核的图片', 'info');
        return;
      }
      navigate(`/annotate/${datasetId}?image=${encodeURIComponent(target)}&mode=review`);
    } catch (error) {
      notify('无法打开审核', error instanceof Error ? error.message : '无法读取审核记录', 'error');
    }
  };

  const removeDataset = async (datasetId: string, name: string) => {
    if (!window.confirm(`确定删除数据集“${name}”吗？该操作会删除其标注记录。`)) return;
    try { await deleteDataset(datasetId); } catch (error) { notify('数据集未删除', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error'); }
  };

  const submitExport = async () => {
    if (!exportDataset) return;
    setSubmittingExport(true);
    try {
      await createDatasetExport(exportDataset.id, { format: exportFormat, scope: exportScope, versionName: exportVersionName.trim() || `${exportDataset.name}_${exportDataset.version}`, includeImages });
      await loadDatasetExports(exportDataset.id);
    } catch (error) {
      notify('导出任务未创建', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setSubmittingExport(false);
    }
  };

  const openExport = (datasetId: string) => {
    const dataset = datasets.find((item) => item.id === datasetId);
    if (dataset?.status !== '可训练') {
      notify('数据集暂不可导出', '全部图像标注审核通过后才能创建正式导出任务', 'info');
      return;
    }
    setExportDatasetId(datasetId);
    setExportVersionName(dataset ? `${dataset.name}_${dataset.version}` : 'export');
    setExportFormat('COCO');
    setExportScope('all');
    setIncludeImages(true);
    void loadDatasetExports(datasetId).catch((error: unknown) => notify('导出记录加载失败', error instanceof Error ? error.message : '无法读取导出任务', 'error'));
  };

  const downloadExport = async (task: ExportTask) => {
    if (!task.artifactId) return;
    try { await downloadArtifact(task.artifactId); } catch (error) { notify('产物下载失败', error instanceof Error ? error.message : '无法读取导出产物', 'error'); }
  };

  return (
    <div className="page datasets-page">
      <PageHeader
        title="数据中心"
        description={`${datasets.length} 个数据集 · ${totalImages.toLocaleString()} 张图像`}
        actions={<><button className="button secondary" onClick={openCreateDataset}><Upload size={17} />导入数据</button><button className="button primary" onClick={openCreateDataset}><Plus size={17} />新建数据集</button></>}
      />

      <section className="data-toolbar">
        <div className="segmented tabs" aria-label="数据状态">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部数据集 <span>{datasets.length}</span></button>
          <button className={filter === '标注中' ? 'active' : ''} onClick={() => setFilter('标注中')}>标注中 <span>{annotatingCount}</span></button>
          <button className={filter === '待审核' ? 'active' : ''} onClick={() => setFilter('待审核')}>待审核 <span>{reviewCount}</span></button>
          <button className={filter === '可训练' ? 'active' : ''} onClick={() => setFilter('可训练')}>可训练 <span>{readyCount}</span></button>
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
                    <td><strong className="version-text">{dataset.version}</strong><span className="cell-subtext">{dataset.size}</span></td>
                    <td><span>{dataset.updatedAt}</span><span className={`dataset-status ${dataset.status}`}>{dataset.status}</span></td>
                    <td>
                      <div className="row-actions">
                        {dataset.status === '待审核' && canReview
                          ? <button className="button compact secondary" onClick={() => void reviewDataset(dataset.id)}><ShieldCheck size={15} />审核标注</button>
                          : <button className="button compact secondary" onClick={() => void annotateDataset(dataset.id)}><Tags size={15} />{dataset.status === '待审核' ? '查看标注' : progress === 100 ? '查看标注' : '继续标注'}</button>}
                        <button className="icon-button bordered" disabled={dataset.status !== '可训练'} title={dataset.status === '可训练' ? '导出' : '审核通过后可导出'} aria-label={`导出 ${dataset.name}`} onClick={() => openExport(dataset.id)}><Download size={17} /></button>
                        <button className="icon-button" title="删除数据集" aria-label={`删除 ${dataset.name}`} onClick={() => void removeDataset(dataset.id, dataset.name)}><Trash2 size={17} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visibleDatasets.length === 0 && <EmptyState icon={Database} title={datasets.length ? '没有匹配的数据集' : '暂无数据集'} description={datasets.length ? '调整状态筛选后重试' : '导入图像与标注，或创建一个空数据集开始整理数据'} />}
      </section>

      <section className="dataset-readiness-band">
        <div><span className="band-icon"><Tags size={21} /></span><div><strong>{readyCount ? `${readyCount} 个数据版本已达到训练条件` : '暂无可训练的数据版本'}</strong><p>{readyCount ? '可训练数据集已经完成标注检查，可以进入训练配置。' : '导入数据并完成标注审核后，训练入口将自动可用。'}</p></div></div>
        <button className="button secondary" onClick={() => navigate('/training/new')} disabled={!readyCount}>配置训练 <ArrowRight size={16} /></button>
      </section>

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
          <div className="form-grid two">
            <label className="form-field"><span>数据范围</span><select value={exportScope} onChange={(event) => setExportScope(event.target.value as NonNullable<ExportTask['scope']>)}><option value="all">全部已标注数据</option><option value="train">训练集（已标注）</option><option value="validation">验证集（已标注）</option><option value="test">测试集（已标注）</option></select></label>
            <label className="form-field"><span>版本名称</span><input value={exportVersionName || `${exportDataset.name}_${exportDataset.version}`} onChange={(event) => setExportVersionName(event.target.value)} /></label>
          </div>
          <label className="check-row"><input type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} /><span><strong>包含已标注原始图像</strong><small>未标注图片不会进入导出包，数据集已标注 {exportDataset.annotated.toLocaleString()} / {exportDataset.images.toLocaleString()} 张</small></span></label>
          <section className="export-history">
            <div className="section-header"><div><h3>导出记录</h3><p>任务状态会自动刷新</p></div></div>
            {visibleExports.length ? <div className="export-history-list">{visibleExports.map((task) => <div key={task.id} className="export-history-row"><span><strong>{task.format}</strong><small>{task.versionName} · {task.scope === 'all' ? '全部已标注数据' : `${task.scope}（已标注）`}</small></span><span><strong>{task.status === 'queued' ? '排队中' : task.status === 'running' ? `${task.progress}%` : task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '已取消'}</strong><small>{task.errorMessage ?? task.createdAt}</small></span>{task.artifactId ? <button className="icon-button bordered" title="下载导出产物" aria-label="下载导出产物" onClick={() => void downloadExport(task)}><Download size={16} /></button> : <span />}</div>)}</div> : <EmptyState icon={FileArchive} title="暂无导出记录" description="创建任务后可在这里查看进度和下载产物" />}
          </section>
        </Modal>
      )}
      {datasetModalOpen && <Modal title="新建并导入数据集" description="创建数据集后，图像会受鉴权逐张上传并持久化保存。" onClose={() => !submittingDataset && setDatasetModalOpen(false)} footer={<><button className="button secondary" onClick={() => setDatasetModalOpen(false)} disabled={submittingDataset}>取消</button><button className="button primary" onClick={() => void submitDataset()} disabled={submittingDataset}>{submittingDataset ? '正在创建并上传' : '创建并上传'}</button></>}>
        <div className="form-grid two">
          <label className="form-field"><span>数据集名称</span><input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} placeholder="例如：焊点缺陷检测" /></label>
          <label className="form-field"><span>版本</span><input value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)} /></label>
          <label className="form-field"><span>类别</span><input value={datasetClasses} onChange={(event) => setDatasetClasses(event.target.value)} placeholder="缺陷, 划痕, 气泡" /></label>
        </div>
        <label className="form-field"><span>说明</span><textarea value={datasetDescription} onChange={(event) => setDatasetDescription(event.target.value)} placeholder="记录采集场景、样本来源或标注规范" /></label>
        <label className="form-field"><span>图像文件</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => setDatasetFiles(Array.from(event.target.files ?? []))} /><small>{datasetFiles.length ? `已选择 ${datasetFiles.length} 张图像` : '支持 JPEG、PNG、WebP，单张最大 50 MB'}</small></label>
      </Modal>}
    </div>
  );
}
