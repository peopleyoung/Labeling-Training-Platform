import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import { useApp } from '../context/AppContext';
import type { AnnotatorPerformance, AnnotatorPerformanceFilter } from '../types';

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function AnnotatorPerformancePage() {
  const { loadAnnotatorPerformance, notify } = useApp();
  const [items, setItems] = useState<AnnotatorPerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const load = useCallback(async (filter: AnnotatorPerformanceFilter = { startDate, endDate }) => {
    setLoading(true);
    try { setItems(await loadAnnotatorPerformance(filter)); }
    catch (error) { notify('统计加载失败', error instanceof Error ? error.message : '请稍后重试', 'error'); }
    finally { setLoading(false); }
  }, [endDate, loadAnnotatorPerformance, notify, startDate]);
  useEffect(() => { void load(); }, [load]);

  const exportExcel = () => {
    const escapeCell = (value: string | number) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = items.map((item) => `<tr><td>${escapeCell(item.annotatorName)}</td><td>${item.enabled ? '启用' : '已禁用'}</td><td>${item.validAnnotationCount}</td><td>${item.approvedJobs}</td><td>${item.rejectedJobs}</td><td>${item.reviewedJobs}</td><td>${percentage(item.rejectionRate)}</td></tr>`).join('');
    const html = `<html><head><meta charset="UTF-8"></head><body><table><tr><th>标注员</th><th>账号状态</th><th>有效标注数</th><th>通过 Job</th><th>驳回 Job</th><th>已审核 Job</th><th>驳回率</th></tr>${rows}</table></body></html>`;
    const blob = new Blob([`\ufeff${html}`], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `标注审核统计${startDate || '全部'}_${endDate || '至今'}.xls`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const summary = useMemo(() => ({ valid: items.reduce((total, item) => total + item.validAnnotationCount, 0), approved: items.reduce((total, item) => total + item.approvedJobs, 0), rejected: items.reduce((total, item) => total + item.rejectedJobs, 0) }), [items]);
  const totalReviewed = summary.approved + summary.rejected;

  return <div className="page admin-page annotator-performance-page">
    <PageHeader title="标注审核统计" description="按标注员查看有效标注量和审核驳回率" actions={<><Link className="button secondary compact" to="/admin"><ArrowLeft size={14} />返回账户管理</Link><button className="button primary compact" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />{loading ? '加载中…' : '刷新统计'}</button></>} />
    <section className="admin-card performance-filter-card"><div className="performance-filters"><label className="form-field"><span>开始日期</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} /></label><label className="form-field"><span>结束日期</span><input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label><button className="button primary compact performance-filter-submit" type="button" onClick={() => void load({ startDate, endDate })} disabled={loading}>应用筛选</button><button className="button secondary compact performance-filter-submit" type="button" onClick={() => { setStartDate(''); setEndDate(''); void load({}); }} disabled={loading}>清除</button><button className="button secondary compact performance-filter-submit" type="button" onClick={exportExcel} disabled={loading || !items.length}>导出 Excel</button></div></section>
    <section className="admin-overview performance-overview"><div className="admin-overview-copy"><span className="eyebrow">ANNOTATION PERFORMANCE</span><h2>用审核结果衡量标注质量</h2><p>有效标注数只统计审核通过文档中仍归属于标注员的最终对象；驳回率按已完成审核的 Job 计算。</p></div><div className="admin-role-summary"><div><span className="performance-summary-label">有效标注</span><strong>{summary.valid}</strong><small>个最终有效对象</small></div><div><span className="performance-summary-label">已审核 Job</span><strong>{totalReviewed}</strong><small>通过 {summary.approved} · 驳回 {summary.rejected}</small></div><div><span className="performance-summary-label">总体驳回率</span><strong>{percentage(totalReviewed ? summary.rejected / totalReviewed : 0)}</strong><small>按 Job 统计</small></div></div></section>
    <section className="admin-card performance-card"><header className="admin-card-header"><div><span className="admin-card-icon"><BarChart3 size={18} /></span><div><h2>标注员绩效明细</h2><p>驳回率 = 驳回 Job ÷（通过 Job + 驳回 Job）</p></div></div><span className="card-count">{items.length} 名标注员</span></header>
      {loading ? <div className="empty-state"><span>正在加载统计数据…</span></div> : items.length === 0 ? <EmptyState icon={ShieldCheck} title="暂无标注员数据" description="请先在系统管理创建标注员账号。" /> : <div className="table-scroll"><table className="data-table performance-table"><thead><tr><th>标注员</th><th>账号状态</th><th>有效标注数</th><th>通过 Job</th><th>驳回 Job</th><th>已审核 Job</th><th>驳回率</th></tr></thead><tbody>{items.map((item) => <tr key={item.annotatorId}><td><strong>{item.annotatorName}</strong></td><td><span className={`status-badge ${item.enabled ? 'status-completed' : 'status-cancelled'}`}>{item.enabled ? '启用' : '已禁用'}</span></td><td><strong>{item.validAnnotationCount.toLocaleString()}</strong></td><td>{item.approvedJobs}</td><td>{item.rejectedJobs}</td><td>{item.reviewedJobs}</td><td><strong className={item.rejectionRate > 0.2 ? 'performance-warning' : ''}>{percentage(item.rejectionRate)}</strong></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
