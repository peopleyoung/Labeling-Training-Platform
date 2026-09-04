import { CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '../context/AppContext';
import type { JobStatus } from '../types';
import { statusLabels } from '../utils/format';

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`status-badge status-${status}`}><i />{statusLabels[status]}</span>;
}

export function ProgressBar({ value, tone = 'blue', label }: { value: number; tone?: 'blue' | 'green' | 'orange'; label?: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-track" aria-label={label} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <span className={`progress-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      {label && <small>{label}</small>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><Icon size={25} /><strong>{title}</strong><span>{description}</span>{action}</div>;
}

export function Modal({ title, description, children, footer, onClose, width = 'medium', className = '' }: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: 'medium' | 'large';
  className?: string;
}) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <section className={`modal modal-${width} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === 'success' ? <CheckCircle2 size={20} /> : <Info size={20} />}
          <div><strong>{toast.title}</strong><span>{toast.message}</span></div>
          <button className="icon-button" onClick={() => dismissToast(toast.id)} aria-label="关闭提示"><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}

export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.value} className={value === option.value ? 'active' : ''} onClick={() => onChange(option.value)} type="button">
          {option.label}
        </button>
      ))}
    </div>
  );
}

const pageSizeOptions = [10, 20, 50] as const;

export function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const firstItem = totalItems ? (currentPage - 1) * pageSize + 1 : 0;
  const lastItem = Math.min(currentPage * pageSize, totalItems);

  return (
    <nav className="pagination" aria-label="列表分页">
      <div className="pagination-summary">
        <span>共 {totalItems} 条</span>
        <label>
          <span>每页</span>
          <select aria-label="每页显示条数" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {pageSizeOptions.map((size) => <option value={size} key={size}>{size} 条</option>)}
          </select>
        </label>
        <span>{firstItem}-{lastItem} 条</span>
      </div>
      <div className="pagination-controls">
        <button type="button" className="icon-button bordered" disabled={currentPage === 1} onClick={() => onPageChange(1)} title="第一页" aria-label="第一页"><ChevronsLeft size={15} /></button>
        <button type="button" className="icon-button bordered" disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)} title="上一页" aria-label="上一页"><ChevronLeft size={15} /></button>
        <span>第 <strong>{currentPage}</strong> / {totalPages} 页</span>
        <button type="button" className="icon-button bordered" disabled={currentPage === totalPages} onClick={() => onPageChange(currentPage + 1)} title="下一页" aria-label="下一页"><ChevronRight size={15} /></button>
        <button type="button" className="icon-button bordered" disabled={currentPage === totalPages} onClick={() => onPageChange(totalPages)} title="最后一页" aria-label="最后一页"><ChevronsRight size={15} /></button>
      </div>
    </nav>
  );
}
