import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ApiClient } from '../services/apiClient';
import type { TaskCatalog } from '../../shared/taskCatalog';

export function BusinessTaskSelect({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { session } = useApp();
  const client = useMemo(() => new ApiClient(() => session?.accessToken ?? null), [session?.accessToken]);
  const [catalog, setCatalog] = useState<TaskCatalog>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void client.taskCatalog().then((data) => { if (active) setCatalog(data); }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : '目录加载失败'); });
    return () => { active = false; };
  }, [client, revision]);
  const categories = catalog?.categories.filter((item) => item.enabled) ?? [];
  const tasks = catalog?.taskTypes.filter((item) => item.enabled && categories.some((c) => c.id === item.categoryId)) ?? [];
  return <div className="form-field"><label><span>业务任务</span><select aria-label="业务任务" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !catalog || Boolean(error)} required>
    <option value="">请选择业务任务</option>
    {categories.map((category) => <optgroup key={category.id} label={category.name}>{tasks.filter((item) => item.categoryId === category.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}
  </select></label>
    {error ? <span role="alert">{error} <button type="button" onClick={() => setRevision((n) => n + 1)}>重试</button></span> : catalog && !tasks.length ? <Link to="/admin/task-catalog">暂无可用业务任务，前往任务类型目录新增</Link> : null}
  </div>;
}
