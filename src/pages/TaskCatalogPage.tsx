import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderTree, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Modal, PageHeader } from '../components/ui';
import { useApp } from '../context/AppContext';
import { ApiClient } from '../services/apiClient';
import type { CatalogInput, TaskCatalog, TaskCategory } from '../../shared/taskCatalog';
import './dataCenter.css';

export function TaskCatalogPage() {
  const { session } = useApp();
  const client = useMemo(() => new ApiClient(() => session?.accessToken ?? null), [session?.accessToken]);
  const [catalog, setCatalog] = useState<TaskCatalog>({ categories: [], taskTypes: [] });
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ kind: 'category' | 'task'; item?: TaskCategory }>();
  const [form, setForm] = useState<CatalogInput>({ name: '', description: '', sortOrder: 0, enabled: true });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const next = await client.taskCatalog(); setCatalog(next); setSelectedId((id) => next.categories.some((item) => item.id === id) ? id : next.categories[0]?.id ?? ''); }
    catch (e) { setError(e instanceof Error ? e.message : '目录加载失败'); }
    finally { setLoading(false); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const selected = catalog.categories.find((item) => item.id === selectedId);
  const tasks = catalog.taskTypes.filter((item) => item.categoryId === selectedId);
  const edit = (kind: 'category' | 'task', item?: TaskCategory) => {
    setForm(item ? { name: item.name, description: item.description, sortOrder: item.sortOrder, enabled: item.enabled } : { name: '', description: '', sortOrder: 0, enabled: true });
    setFormError(''); setEditing({ kind, item });
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true); setFormError('');
    try { await client.saveCatalog(editing.kind, editing.item?.id ?? null, form, selectedId); setEditing(undefined); await load(); }
    catch (e) { setFormError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <div className="page catalog-page">
    <PageHeader title="任务类型目录" actions={<><Link className="button secondary" to="/admin"><ArrowLeft size={16} />系统管理</Link><button className="icon-button" title="刷新目录" aria-label="刷新目录" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /></button></>} />
    {error && <p role="alert" className="dc-error">{error}</p>}
    <div className="catalog-layout" aria-busy={loading}>
      <section className="catalog-categories"><header><h2>任务大类</h2><button className="icon-button" title="新增大类" aria-label="新增大类" onClick={() => edit('category')}><Plus size={18} /></button></header>
        {catalog.categories.map((item) => <div key={item.id} className={`catalog-category ${selectedId === item.id ? 'selected' : ''}`}><button className="catalog-select" onClick={() => setSelectedId(item.id)}><FolderTree size={17} /><span>{item.name}{!item.enabled && <small>已停用</small>}</span></button><button className="icon-button" title={`编辑${item.name}`} aria-label={`编辑${item.name}`} onClick={() => edit('category', item)}><Pencil size={15} /></button></div>)}
        {!loading && !catalog.categories.length && <p className="dc-empty">暂无任务大类</p>}
      </section>
      <section className="catalog-tasks"><header><div><h2>{selected?.name ?? '业务任务'}</h2><p>{selected?.description}</p></div><button className="button primary compact" disabled={!selected?.enabled} onClick={() => edit('task')}><Plus size={16} />新增业务任务</button></header>
        {tasks.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>业务任务</th><th>编码</th><th>数据集</th><th>排序</th><th>状态</th><th>操作</th></tr></thead><tbody>{tasks.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className="cell-subtext">{item.description}</small></td><td className="catalog-code">{item.code}</td><td>{item.datasetCount}</td><td>{item.sortOrder}</td><td>{item.enabled ? '启用' : '已停用'}</td><td><button className="icon-button" title={`编辑${item.name}`} aria-label={`编辑${item.name}`} onClick={() => edit('task', item)}><Pencil size={16} /></button></td></tr>)}</tbody></table></div> : <p className="dc-empty">{loading ? '正在加载目录' : '暂无业务任务'}</p>}
      </section>
    </div>
    {editing && <Modal title={`${editing.item ? '编辑' : '新增'}${editing.kind === 'category' ? '任务大类' : '业务任务'}`} onClose={() => !saving && setEditing(undefined)} footer={<><button className="button secondary" disabled={saving} onClick={() => setEditing(undefined)}>取消</button><button className="button primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>{saving ? '保存中' : '保存'}</button></>}>
      <div className="dc-form">{formError && <p role="alert" className="dc-error">{formError}</p>}
        <label className="form-field"><span>名称</span><input maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        {editing.item && <label className="form-field"><span>编码</span><input readOnly value={editing.item.code} /></label>}
        <label className="form-field"><span>说明</span><textarea maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="form-field"><span>排序</span><input type="number" min={0} max={100000} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} /></label>
        <label className="dc-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />启用</label>
      </div>
    </Modal>}
  </div>;
}
