import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BoxSelect, BrainCircuit, Check, ChevronDown, Cpu, Database, KeyRound, Layers3, PackageOpen, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import { useApp } from '../context/AppContext';
import { dataFormatDescriptions, taskLabels } from '../data/catalog';
import { trainingDataFormats } from '../../shared/contracts';
import type { TrainingDataFormat, TrainingDraft, TrainingType } from '../types';

const taskTypes = [
  { id: 'detection' as const, title: '目标检测', description: '定位零件、划痕与表面缺陷', icon: BoxSelect, color: 'blue', models: [{ value: 'yolov8n', label: 'YOLOv8-N' }, { value: 'yolov8s', label: 'YOLOv8-S' }, { value: 'yolov8m', label: 'YOLOv8-M' }, { value: 'yolov8l', label: 'YOLOv8-L' }, { value: 'yolov8x', label: 'YOLOv8-X' }, { value: 'yolov5n', label: 'YOLOv5u-N' }, { value: 'yolov5s', label: 'YOLOv5u-S' }, { value: 'yolov5m', label: 'YOLOv5u-M' }, { value: 'yolov5l', label: 'YOLOv5u-L' }, { value: 'yolov5x', label: 'YOLOv5u-X' }] },
  { id: 'segmentation' as const, title: '语义分割', description: '像素级识别气孔、裂纹和区域', icon: Layers3, color: 'cyan', models: [{ value: 'segformer-b0', label: 'SegFormer-B0' }, { value: 'segformer-b1', label: 'SegFormer-B1' }, { value: 'segformer-b2', label: 'SegFormer-B2' }, { value: 'segformer-b3', label: 'SegFormer-B3' }, { value: 'segformer-b4', label: 'SegFormer-B4' }, { value: 'segformer-b5', label: 'SegFormer-B5' }, { value: 'deeplabv3plus-resnet50', label: 'DeepLabV3+ ResNet50' }, { value: 'deeplabv3plus-resnet101', label: 'DeepLabV3+ ResNet101' }, { value: 'unet', label: 'U-Net' }] },
  { id: 'keypoint' as const, title: '关键点检测', description: '识别装配定位点与角度', icon: KeyRound, color: 'violet', models: [{ value: 'hrnet-w32', label: 'HRNet-W32' }, { value: 'hrnet-w48', label: 'HRNet-W48' }, { value: 'higherhrnet-w32', label: 'HigherHRNet-W32' }, { value: 'higherhrnet-w48', label: 'HigherHRNet-W48' }] },
  { id: 'sdxl' as const, title: 'SDXL 微调', description: '生成可控的合成缺陷样本', icon: WandSparkles, color: 'orange', models: [{ value: 'sdxl-1.0-lora', label: 'SDXL 1.0 LoRA' }, { value: 'sdxl-1.0-dreambooth-lora', label: 'SDXL DreamBooth LoRA' }] },
];

const defaultDraft: TrainingDraft = {
  type: 'detection',
  dataFormat: 'YOLO',
  name: '',
  datasetId: '',
  model: 'yolov8m',
  weightSource: 'pretrained',
  epochs: 120,
  batchSize: 32,
  learningRate: '0.001',
  imageSize: 640,
  gpu: '2 × T4 16G',
  mixedPrecision: true,
  earlyStopping: true,
};

export function TrainingWizardPage() {
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<TrainingDraft>({ ...defaultDraft, datasetId: searchParams.get('dataset') ?? defaultDraft.datasetId });
  const { datasets, createTrainingJob, gpuEnabled, cpuTrainingEnabled, notify } = useApp();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const currentTask = taskTypes.find((item) => item.id === draft.type) ?? taskTypes[0];
  const stepLabels = ['任务类型', '数据与模型', '参数与资源', '确认启动'];
  const trainingAvailable = gpuEnabled || cpuTrainingEnabled;
  const taskTrainingAvailable = trainingAvailable && (draft.type !== 'sdxl' || gpuEnabled);

  useEffect(() => {
    if (!gpuEnabled && cpuTrainingEnabled) setDraft((current) => ({ ...current, gpu: 'CPU', mixedPrecision: false, model: current.type === 'detection' ? 'yolov8n' : current.model, batchSize: Math.min(current.batchSize, 4) }));
  }, [cpuTrainingEnabled, gpuEnabled]);

  const compatibleDatasets = useMemo(() => datasets.filter((item) => item.status === '可训练'), [datasets]);
  const compatibleFormats = trainingDataFormats[draft.type];
  const selectedDataset = compatibleDatasets.find((item) => item.id === draft.datasetId) ?? compatibleDatasets[0];

  const chooseType = (type: TrainingType) => {
    const config = taskTypes.find((item) => item.id === type) ?? taskTypes[0];
    const readyDatasets = datasets.filter((item) => item.status === '可训练');
    const imageSize = type === 'sdxl' ? 1024 : type === 'keypoint' ? 384 : type === 'segmentation' ? 512 : 640;
    const weightSource = 'pretrained';
    setDraft((current) => ({ ...current, type, dataFormat: trainingDataFormats[type][0], model: type === 'detection' ? (gpuEnabled ? 'yolov8m' : 'yolov8n') : config.models[0].value, datasetId: readyDatasets[0]?.id ?? '', name: `${config.title}训练`, imageSize, weightSource, batchSize: type === 'sdxl' ? 1 : gpuEnabled ? current.batchSize : Math.min(current.batchSize, 4) }));
  };

  const submit = async () => {
    if (!taskTrainingAvailable) {
      notify('训练任务未创建', draft.type === 'sdxl' ? 'SDXL 训练需要 CUDA GPU Worker。' : '当前部署未启用可用的训练 Worker。', 'error');
      return;
    }
    if (!draft.name.trim() || !selectedDataset) {
      notify('训练任务未创建', '请填写任务名称并选择兼容的数据集。', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const id = await createTrainingJob({ ...draft, datasetId: selectedDataset.id }, `${selectedDataset.name} ${selectedDataset.version}`);
      navigate(`/training/${id}`);
    } catch (error) {
      notify('训练任务未创建', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page wizard-page">
      <PageHeader eyebrow="训练中心 / 新建任务" title="创建训练任务" description={gpuEnabled ? '配置训练任务并提交到 GPU Worker' : '配置训练任务并提交到 CPU Worker'} actions={<Link className="button secondary" to="/training"><ArrowLeft size={16} />返回列表</Link>} />

      <nav className="wizard-steps" aria-label="训练创建步骤">
        {stepLabels.map((label, index) => {
          const number = index + 1;
          return <button key={label} className={`${step === number ? 'active' : ''} ${step > number ? 'complete' : ''}`} onClick={() => step > number && setStep(number)}><span>{step > number ? <Check size={15} /> : number}</span><strong>{label}</strong><i /></button>;
        })}
      </nav>

      <section className="wizard-surface">
        {!gpuEnabled && cpuTrainingEnabled && <div className="selection-note"><Cpu size={19} /><div><strong>CPU 训练模式</strong><span>任务将由 CPU Worker 执行，耗时通常高于 GPU。</span></div></div>}
        {!trainingAvailable && <div className="selection-note"><Cpu size={19} /><div><strong>训练 Worker 未启用</strong><span>当前只能查看数据与参数。</span></div></div>}
        {step === 1 && (
          <div className="wizard-step-content">
            <header className="wizard-section-heading"><span>01</span><div><h2>选择任务类型</h2><p>任务类型决定可用的数据格式、模型和评估指标。</p></div></header>
            <div className="task-type-grid">
              {taskTypes.map(({ id, title, description, icon: Icon, color }) => (
                <button key={id} className={`task-choice ${draft.type === id ? 'selected' : ''}`} disabled={id === 'sdxl' && !gpuEnabled} title={id === 'sdxl' && !gpuEnabled ? 'SDXL 训练需要 CUDA GPU Worker' : undefined} onClick={() => chooseType(id)}>
                  <span className={`choice-icon ${color}`}><Icon size={24} /></span>
                  <span><strong>{title}</strong><small>{description}</small></span>
                  <i className="radio-mark">{draft.type === id && <Check size={13} />}</i>
                </button>
              ))}
            </div>
            <div className="selection-note"><BrainCircuit size={19} /><div><strong>推荐配置已就绪</strong><span>选择任务后，系统会匹配可用数据集、预训练模型和评估指标。</span></div></div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step-content">
            <header className="wizard-section-heading"><span>02</span><div><h2>选择数据与基础模型</h2><p>{taskLabels[draft.type]}任务的数据版本和预训练权重。</p></div></header>
            <div className="wizard-form-layout">
              <div className="form-stack">
                <label className="form-field"><span>任务名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                <label className="form-field"><span>数据集版本</span><select value={selectedDataset?.id ?? ''} disabled={!compatibleDatasets.length} onChange={(event) => setDraft((current) => ({ ...current, datasetId: event.target.value }))}><option value="">{compatibleDatasets.length ? '请选择数据集' : '暂无已审核数据集'}</option>{compatibleDatasets.map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.name} · {dataset.version}</option>)}</select></label>
                <label className="form-field"><span>数据格式</span><select value={draft.dataFormat} disabled={draft.type === 'sdxl'} onChange={(event) => setDraft((current) => ({ ...current, dataFormat: event.target.value as TrainingDataFormat }))}>{compatibleFormats.map((format) => <option key={format} value={format}>{dataFormatDescriptions[format].label}</option>)}</select><small>{dataFormatDescriptions[draft.dataFormat].description}</small></label>
                <label className="form-field"><span>基础模型</span><select value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}>{currentTask.models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
                <label className="form-field"><span>权重来源</span><select value={draft.weightSource} disabled={draft.type === 'sdxl'} onChange={(event) => setDraft((current) => ({ ...current, weightSource: event.target.value as TrainingDraft['weightSource'] }))}>{draft.type === 'sdxl' ? <option value="pretrained">预置 SDXL Base 模型</option> : <><option value="pretrained">官方预训练权重</option><option value="scratch">从头训练</option></>}</select></label>
              </div>
              <aside className="dataset-snapshot">
                {selectedDataset ? <><div className="snapshot-header"><span className="dataset-glyph"><Database size={20} /></span><div><strong>{selectedDataset.name}</strong><small>{selectedDataset.version} · 通用标注数据集</small></div></div><dl><div><dt>样本数量</dt><dd>{selectedDataset.images.toLocaleString()}</dd></div><div><dt>类别数量</dt><dd>{selectedDataset.classes.length}</dd></div><div><dt>数据状态</dt><dd>{selectedDataset.status}</dd></div></dl></> : <EmptyState icon={PackageOpen} title="暂无可训练数据集" description="请先完成数据标注与审核。" />}
              </aside>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-step-content">
            <header className="wizard-section-heading"><span>03</span><div><h2>配置参数与资源</h2><p>设置训练规模、优化器参数和计算资源。</p></div></header>
            <div className="config-sections">
              <section className="config-section">
                <header><SlidersHorizontal size={18} /><div><strong>训练参数</strong><span>{draft.model} 推荐值</span></div></header>
                <div className="form-grid three">
                  <label className="form-field"><span>训练轮次</span><input type="number" value={draft.epochs} min="1" onChange={(event) => setDraft((current) => ({ ...current, epochs: Number(event.target.value) }))} /></label>
                  <label className="form-field"><span>批次大小</span><select value={draft.batchSize} onChange={(event) => setDraft((current) => ({ ...current, batchSize: Number(event.target.value) }))}><option value="1">1</option><option value="2">2</option><option value="4">4</option><option value="8">8</option><option value="16">16</option><option value="32">32</option><option value="64">64</option></select></label>
                  <label className="form-field"><span>初始学习率</span><input value={draft.learningRate} onChange={(event) => setDraft((current) => ({ ...current, learningRate: event.target.value }))} /></label>
                  <label className="form-field"><span>输入尺寸</span><select value={draft.imageSize} onChange={(event) => setDraft((current) => ({ ...current, imageSize: Number(event.target.value) }))}><option value="128">128 × 128</option><option value="256">256 × 256</option><option value="384">384 × 384</option><option value="512">512 × 512</option><option value="640">640 × 640</option><option value="1024">1024 × 1024</option></select></label>
                  <label className="form-field"><span>优化器</span><select defaultValue="adamw"><option value="adamw">AdamW</option><option>SGD</option><option>Lion</option></select></label>
                  <label className="form-field"><span>学习率策略</span><select defaultValue="cosine"><option value="cosine">Cosine Annealing</option><option>One Cycle</option><option>Step Decay</option></select></label>
                </div>
              </section>
              <section className="config-section">
                <header><Cpu size={18} /><div><strong>计算资源</strong><span>提交后由 Worker 分配</span></div></header>
                <div className="form-grid two resource-form">
                  <label className="form-field"><span>计算设备</span><select value={draft.gpu} disabled={!gpuEnabled} onChange={(event) => setDraft((current) => ({ ...current, gpu: event.target.value }))}>{!gpuEnabled && <option>CPU</option>}<option>1 × T4 16G</option><option>2 × T4 16G</option></select></label>
                  <label className="form-field"><span>优先级</span><select defaultValue="normal"><option value="normal">普通</option><option>低优先级 / 空闲资源</option><option>高优先级</option></select></label>
                </div>
                <div className="toggle-list">
                  <label><input type="checkbox" checked={draft.mixedPrecision} disabled={!gpuEnabled} onChange={(event) => setDraft((current) => ({ ...current, mixedPrecision: event.target.checked }))} /><span className="toggle" /><div><strong>混合精度训练</strong><small>{gpuEnabled ? '使用 FP16/BF16 降低显存并提升吞吐' : 'CPU 模式使用 FP32'}</small></div></label>
                  <label><input type="checkbox" checked={draft.earlyStopping} onChange={(event) => setDraft((current) => ({ ...current, earlyStopping: event.target.checked }))} /><span className="toggle" /><div><strong>早停策略</strong><small>验证指标连续 20 轮不提升时停止</small></div></label>
                </div>
              </section>
              <details className="advanced-config"><summary><span><ChevronDown size={16} />高级参数</span><small>数据增强、保存策略、评估频率</small></summary><div className="advanced-body">高级参数已使用模型推荐配置。</div></details>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="wizard-step-content review-step">
            <header className="wizard-section-heading"><span>04</span><div><h2>确认并启动</h2><p>检查任务配置，提交后将进入{gpuEnabled ? ' GPU' : ' CPU'}资源队列。</p></div></header>
            <div className="review-banner"><span className={`choice-icon ${currentTask.color}`}><currentTask.icon size={23} /></span><div><strong>{draft.name}</strong><span>{taskLabels[draft.type]} · {draft.model}</span></div><span className="neutral-badge">配置完整</span></div>
            <div className="review-grid">
              <section><header><Database size={17} />数据与模型</header><dl><div><dt>数据版本</dt><dd>{selectedDataset ? `${selectedDataset.name} ${selectedDataset.version}` : '--'}</dd></div><div><dt>数据格式</dt><dd>{dataFormatDescriptions[draft.dataFormat].label}</dd></div><div><dt>基础模型</dt><dd>{draft.model}</dd></div><div><dt>权重来源</dt><dd>{draft.weightSource === 'scratch' ? '从头训练' : '官方预训练权重'}</dd></div><div><dt>输入尺寸</dt><dd>{draft.imageSize} × {draft.imageSize}</dd></div></dl></section>
              <section><header><SlidersHorizontal size={17} />训练参数</header><dl><div><dt>训练轮次</dt><dd>{draft.epochs}</dd></div><div><dt>Batch / 学习率</dt><dd>{draft.batchSize} / {draft.learningRate}</dd></div><div><dt>混合精度</dt><dd>{draft.mixedPrecision ? '开启' : '关闭'}</dd></div></dl></section>
              <section><header><Cpu size={17} />计算资源</header><dl><div><dt>设备</dt><dd>{draft.gpu}</dd></div><div><dt>资源状态</dt><dd>提交后排队</dd></div></dl></section>
            </div>
            <div className="launch-note"><Sparkles size={19} /><div><strong>提交前检查</strong><span>任务提交后将由服务端校验数据集、模型和计算资源。</span></div></div>
          </div>
        )}

        <footer className="wizard-footer">
          <span>步骤 {step} / 4</span>
          <div>{step > 1 && <button className="button secondary" onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>}{step < 4 ? <button className="button primary" onClick={() => setStep((current) => current + 1)} disabled={(step === 2 && (!draft.name.trim() || !selectedDataset)) || !taskTrainingAvailable}>下一步 <ArrowRight size={16} /></button> : <button className="button primary launch-button" onClick={submit} disabled={!taskTrainingAvailable || submitting || !selectedDataset || !draft.name.trim()}><Sparkles size={17} />{submitting ? '正在提交' : taskTrainingAvailable ? '创建并启动' : draft.type === 'sdxl' ? 'SDXL 需要 GPU' : '训练 Worker 未启用'}</button>}</div>
        </footer>
      </section>
    </div>
  );
}
