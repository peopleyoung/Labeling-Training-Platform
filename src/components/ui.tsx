import { CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
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

export function Modal({ title, description, children, footer, onClose, width = 'medium' }: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: 'medium' | 'large';
}) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal modal-${width}`} role="dialog" aria-modal="true" aria-label={title}>
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
