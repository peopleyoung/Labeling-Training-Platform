import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Box, Braces, Check, ChevronDown, Cpu, Download, FileCode2, Gauge, Info, PackageOpen, Plus, Search, Settings2, Square, Trash2, Zap } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, Modal, PageHeader, Pagination, ProgressBar, StatusBadge } from '../components/ui';
import { useApp } from '../context/AppContext';
import { formatDescriptions } from '../data/catalog';
import type { ConversionFormat, ConversionTask } from '../types';

const formats: { id: ConversionFormat; icon: typeof Braces; accent: string }[] = [
  { id: 'ONNX', icon: Braces, accent: 'blue' },
  { id: 'TensorRT', icon: Zap, accent: 'green' },
  { id: 'TorchScript', icon: FileCode2, accent: 'orange' },
  { id: 'OpenVINO', icon: Cpu, accent: 'violet' },
];

export function ConversionsPage() {
  const [searchParams] = useSearchParams();
  const initialSource = searchParams.get('source');
  const [sourceId, setSourceId] = useState(initialSource ?? '');
  const [format, setFormat] = useState<ConversionFormat>('ONNX');
  const [precision, setPrecision] = useState('FP32');
  const [advanced, setAdvanced] = useState(false);
  const [optionA, setOptionA] = useState('18');
  const [optionB, setOptionB] = useState('dynamic');
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [deleteTarget, setDeleteTarget] = useState<ConversionTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { conversions, createConversion, cancelConversion, deleteConversion, downloadArtifact, gpuEnabled, cpuConversionFormats, models, session, notify } = useApp();
  const model = models.find((item) => item.id === sourceId);
  const target = formatDescriptions[format].target;
  const filteredTasks = useMemo(() => conversions.filter((task) => `${task.modelName}${task.format}${task.target}`.toLowerCase().includes(query.toLowerCase())), [conversions, query]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredTasks.length / pageSize)));
  const visibleTasks = useMemo(() => filteredTasks.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, filteredTasks, pageSize]);
  const canDelete = session?.user.role === 'admin' || session?.user.role === 'engineer';
  const sdxlBlocked = model?.task === 'sdxl' && !gpuEnabled;
  const conversionAllowed = !sdxlBlocked && (gpuEnabled || cpuConversionFormats.includes(format));

  useEffect(() => {
    setPrecision(gpuEnabled ? formatDescriptions[format].defaultPrecision : 'FP32');
    const defaults = format === 'ONNX' ? ['18', 'dynamic'] : format === 'TensorRT' ? ['NVIDIA T4', '4 GB'] : format === 'TorchScript' ? ['trace', 'inference'] : ['Intel CPU', 'latency'];
    setOptionA(defaults[0]);
    setOptionB(defaults[1]);
  }, [format, gpuEnabled]);

  useEffect(() => {
    if ((!sourceId || !models.some((item) => item.id === sourceId)) && models[0]) setSourceId(models[0].id);
  }, [models, sourceId]);

  const submit = async () => {
    if (!conversionAllowed) {
      notify('转换任务未创建', sdxlBlocked ? 'SDXL LoRA 融合与 UNet 转换需要 CUDA GPU Worker。' : '当前 Worker 不支持该转换格式。', 'error');
      return;
    }
    if (!model) return;
    try {
      await createConversion({ modelName: model.name, modelVersion: model.version, format, precision, target, options: { optimizeGraph: advanced, optionA, optionB } });
    } catch (error) {
      notify('转换任务未创建', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    }
  };

  const cancel = async (taskId: string) => {
    try { await cancelConversion(taskId); } catch (error) { notify('转换任务未取消', error instanceof Error ? error.message : '无法取消转换任务', 'error'); }
  };

  const download = async (artifactId: string) => {
    try { await downloadArtifact(artifactId); } catch (error) { notify('转换产物下载失败', error instanceof Error ? error.message : '无法读取转换产物', 'error'); }
  };
  const downloadTask = (task: ConversionTask) => task.artifactId ? download(task.artifactId) : Promise.resolve();

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteConversion(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      notify('转换任务未删除', error instanceof Error ? error.message : '无法删除转换任务及产物', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page conversions-page">
      <PageHeader title="转换中心" description="构建针对不同推理环境优化的模型产物" actions={<button className="button primary" onClick={() => document.getElementById('conversion-builder')?.scrollIntoView({ behavior: 'smooth' })}><Plus size={17} />新建转换</button>} />

      <section id="conversion-builder" className="conversion-builder">
        <header className="section-header conversion-header"><div><span className="section-number">01</span><div><h2>创建转换任务</h2><p>选择源模型、目标格式和运行环境。</p></div></div></header>
        <div className="conversion-source-row">
          <label className="form-field"><span>源模型版本</span><select value={model?.id ?? ''} disabled={!models.length} onChange={(event) => setSourceId(event.target.value)}><option value="">{models.length ? '请选择模型' : '暂无可用模型'}</option>{models.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.version}</option>)}</select></label>
          {model && <div className="source-model-summary"><span className={`model-glyph ${model.task}`}><Box size={19} /></span><div><small>{model.framework}</small><strong>{model.metricName} {model.metricValue}</strong></div><div><small>原始大小</small><strong>{model.size}</strong></div><span className="neutral-badge">{model.stage}</span></div>}
          {!model && <EmptyState icon={PackageOpen} title="暂无源模型" description="训练并登记模型后即可创建转换任务。" />}
        </div>

        <label className="field-label">目标格式</label>
        <div className="conversion-format-grid">
          {formats.map(({ id, icon: Icon, accent }) => (
            <button key={id} className={`conversion-format ${format === id ? 'selected' : ''}`} disabled={!gpuEnabled && !cpuConversionFormats.includes(id)} title={!gpuEnabled && !cpuConversionFormats.includes(id) ? '需要 GPU Worker' : undefined} onClick={() => setFormat(id)}>
              <span className={`format-logo ${accent}`}><Icon size={22} /></span>
              <span><strong>{id}</strong><small>{formatDescriptions[id].description}</small><b>{formatDescriptions[id].target}</b></span>
              <i className="radio-mark">{format === id && <Check size={13} />}</i>
            </button>
          ))}
        </div>

        <div className="conversion-config-row">
          <section className="conversion-config">
            <header><Settings2 size={18} /><div><strong>{format} 配置</strong><span>已应用兼容的推荐值</span></div></header>
            <div className="form-grid three">
              <label className="form-field"><span>精度</span><select value={precision} onChange={(event) => setPrecision(event.target.value)}><option>FP32</option>{gpuEnabled && <option>FP16</option>}</select></label>
              {format === 'ONNX' && <><label className="form-field"><span>Opset</span><select value={optionA} onChange={(event) => setOptionA(event.target.value)}><option>17</option><option>18</option><option>19</option></select></label><label className="form-field"><span>输入批次</span><select value={optionB} onChange={(event) => setOptionB(event.target.value)}><option value="dynamic">动态批次</option><option value="batch-1">固定批次 1</option><option value="batch-8">固定批次 8</option></select></label></>}
              {format === 'TensorRT' && <><label className="form-field"><span>目标 GPU</span><select value={optionA} onChange={(event) => setOptionA(event.target.value)}><option>NVIDIA T4</option><option>Jetson Orin</option><option>Hopper</option></select></label><label className="form-field"><span>Workspace</span><select value={optionB} onChange={(event) => setOptionB(event.target.value)}><option>4 GB</option><option>8 GB</option><option>16 GB</option></select></label></>}
              {format === 'TorchScript' && <><label className="form-field"><span>转换模式</span><select value={optionA} onChange={(event) => setOptionA(event.target.value)}><option value="trace">Trace</option><option value="script">Script</option></select></label><label className="form-field"><span>优化级别</span><select value={optionB} onChange={(event) => setOptionB(event.target.value)}><option value="inference">推理优化</option><option value="mobile">移动端优化</option></select></label></>}
              {format === 'OpenVINO' && <><label className="form-field"><span>目标设备</span><select value={optionA} onChange={(event) => setOptionA(event.target.value)}><option>Intel CPU</option><option>Intel GPU</option><option>Intel NPU</option></select></label><label className="form-field"><span>性能提示</span><select value={optionB} onChange={(event) => setOptionB(event.target.value)}><option value="latency">低延迟</option><option value="throughput">高吞吐</option></select></label></>}
            </div>
            <label className="check-row compact-check"><input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} /><span><strong>启用图优化</strong><small>常量折叠、算子融合与冗余节点清理</small></span></label>
          </section>
          <aside className="conversion-estimate">
            <header><Gauge size={18} /><strong>转换摘要</strong></header>
            <dl><div><dt>源模型</dt><dd>{model ? `${model.name} ${model.version}` : '--'}</dd></div><div><dt>目标环境</dt><dd>{target}</dd></div><div><dt>目标格式</dt><dd>{format}</dd></div><div><dt>精度</dt><dd>{precision}</dd></div></dl>
            <div className="compatibility-ok"><Info size={15} />{sdxlBlocked ? 'SDXL LoRA 融合与 UNet 转换需要 CUDA GPU Worker' : gpuEnabled ? '兼容性与产物信息将在转换任务执行后返回' : 'CPU 模式支持 FP32 ONNX、TorchScript 与 OpenVINO'}</div>
            <button className="button primary full-width" disabled={!conversionAllowed || !model} onClick={submit}>{conversionAllowed ? '创建转换任务' : '需要 GPU Worker'} <ArrowRight size={16} /></button>
          </aside>
        </div>
      </section>

      <section className="conversion-tasks-section">
        <header className="section-header"><div><span className="section-number">02</span><div><h2>转换任务</h2><p>近期构建记录与部署产物。</p></div></div><div className="toolbar-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索转换任务" /></div></header>
        {visibleTasks.length ? <div className="table-panel">
          <div className="table-scroll"><table className="data-table conversion-table"><thead><tr><th>源模型</th><th>目标格式</th><th>精度 / 环境</th><th>状态</th><th>产物大小</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{visibleTasks.map((task) => <tr key={task.id}><td><div className="conversion-model-cell"><span className="format-mini"><Braces size={16} /></span><div><strong>{task.modelName}</strong><span>{task.modelVersion}</span></div></div></td><td><strong>{task.format}</strong></td><td><span>{task.precision}</span><span className="cell-subtext">{task.target}</span></td><td><div className="status-progress"><StatusBadge status={task.status} />{task.status === 'running' && <ProgressBar value={task.progress} />}{task.errorMessage && <span className="failure-reason">{task.errorMessage}</span>}</div></td><td>{task.size}</td><td>{task.createdAt}</td><td><div className="row-actions">{task.status === 'completed' && task.artifactId && <button className="icon-button bordered" title="下载产物" aria-label={`下载 ${task.modelName} ${task.format} 产物`} onClick={() => void downloadTask(task)}><Download size={16} /></button>}{(task.status === 'queued' || task.status === 'running') && <button className="icon-button" title="取消转换" aria-label={`取消 ${task.modelName} ${task.format} 转换`} onClick={() => void cancel(task.id)}><Square size={16} /></button>}{canDelete && !['queued', 'running'].includes(task.status) && <button className="icon-button" title="删除转换任务及产物" aria-label={`删除 ${task.modelName} ${task.format} 转换`} onClick={() => setDeleteTarget(task)}><Trash2 size={17} /></button>}</div></td></tr>)}</tbody></table></div>
          <Pagination page={currentPage} pageSize={pageSize} totalItems={filteredTasks.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        </div> : <EmptyState icon={PackageOpen} title={conversions.length ? '没有匹配的转换任务' : '暂无转换任务'} description={conversions.length ? '调整搜索条件后重试。' : '选择已登记模型并提交转换任务后，构建记录将在此显示。'} />}
      </section>

      <div className="format-compatibility-band"><Info size={18} /><span><strong>格式选择建议</strong> NVIDIA 边缘设备优先 TensorRT，Intel 产线工控机使用 OpenVINO，跨平台服务使用 ONNX。</span><button className="text-link" onClick={() => setMatrixOpen((value) => !value)}>查看部署矩阵 <ChevronDown size={14} /></button></div>
      {matrixOpen && <section className="deployment-matrix"><div><strong>ONNX</strong><span>通用 CPU / GPU</span><small>FP32 / FP16</small></div><div><strong>TensorRT</strong><span>NVIDIA T4 / GPU</span><small>FP32 / FP16</small></div><div><strong>TorchScript</strong><span>PyTorch Runtime</span><small>FP32 / FP16</small></div><div><strong>OpenVINO</strong><span>Intel CPU / GPU / NPU</span><small>FP32 / FP16</small></div></section>}
      {deleteTarget && <Modal title="删除转换任务及产物" description={`确认删除“${deleteTarget.modelName} ${deleteTarget.format}”？`} onClose={() => !deleting && setDeleteTarget(null)} footer={<><button className="button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="button danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除' : '确认删除'}</button></>}><p className="modal-warning-copy">转换记录和部署产物将从本地制品存储永久删除，无法恢复。</p></Modal>}
    </div>
  );
}
