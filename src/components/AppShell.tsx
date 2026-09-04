import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Boxes,
  Braces,
  ClipboardList,
  ChevronDown,
  CircleHelp,
  Database,
  Gauge,
  LogOut,
  Menu,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Modal } from './ui';
import { effectiveUserRoles } from '../../shared/contracts';
import { guideRoleFor, roleGuides } from '../data/roleGuides';

const navItems = [
  { to: '/', label: '工作台', icon: Gauge, end: true },
  { to: '/datasets', label: '数据中心', icon: Database },
  { to: '/tasks', label: '标注任务', icon: ClipboardList },
  { to: '/training', label: '训练中心', icon: Sparkles },
  { to: '/models', label: '模型仓库', icon: Boxes },
  { to: '/conversions', label: '转换中心', icon: Braces },
];

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [utilityModal, setUtilityModal] = useState<'help' | 'settings' | 'notifications' | null>(null);
  const { session, apiEnabled, gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, datasets, jobs, models, conversions, logout } = useApp();
  const navigate = useNavigate();
  const user = session?.user;
  const userRoles = user ? effectiveUserRoles(user) : [];
  const isAdmin = userRoles.includes('admin');
  const guide = roleGuides[guideRoleFor(userRoles)];
  const roleLabel = userRoles.map((role) => role === 'admin' ? '管理员' : role === 'annotator' ? '标注员' : '审核员').join(' / ') || '审核员';
  const visibleNavItems = navItems.filter(({ to }) => userRoles.includes('admin') || userRoles.includes('reviewer') || to === '/datasets');
  const failedTasks = [...jobs, ...conversions].filter((task) => task.status === 'failed');
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return [
      ...datasets.filter((item) => `${item.name}${item.description}`.toLowerCase().includes(query)).map((item) => ({ id: item.id, title: item.name, subtitle: `数据集 · ${item.version}`, path: isAdmin ? '/tasks' : '/datasets' })),
      ...jobs.filter((item) => `${item.name}${item.model}${item.dataset}`.toLowerCase().includes(query)).map((item) => ({ id: item.id, title: item.name, subtitle: `训练任务 · ${item.status}`, path: `/training/${item.id}` })),
      ...models.filter((item) => `${item.name}${item.version}${item.framework}`.toLowerCase().includes(query)).map((item) => ({ id: item.id, title: `${item.name} ${item.version}`, subtitle: `模型 · ${item.stage}`, path: '/models' })),
    ].slice(0, 12);
  }, [datasets, isAdmin, jobs, models, searchQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openResult = (path: string) => {
    setSearchOpen(false);
    setSearchQuery('');
    navigate(path);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <strong>FORGE AI</strong>
            <small>MODEL STUDIO</small>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航">
            <X size={18} />
          </button>
        </div>

        <nav className="main-nav" aria-label="主导航">
          {visibleNavItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileNavOpen(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <nav className="utility-nav" aria-label="辅助导航">
          <button onClick={() => setUtilityModal('help')}><CircleHelp size={18} />帮助与文档</button>
          {userRoles.includes('admin') && <NavLink className="utility-link" to="/admin"><Settings size={18} /><span>系统管理</span></NavLink>}
        </nav>
        <div className="sidebar-user">
          <details className="sidebar-user-menu">
            <summary className="sidebar-user-trigger" aria-label="用户菜单" title="用户菜单">
              <span className="sidebar-user-identity"><span>{user?.displayName ?? '本地开发'}</span><small>{roleLabel}</small></span>
              <ChevronDown className="sidebar-user-chevron" size={16} />
            </summary>
            {apiEnabled && <div className="sidebar-user-menu-panel" role="menu"><span>{user?.displayName ?? '本地开发'}</span><button type="button" role="menuitem" onClick={logout}><LogOut size={16} />退出登录</button></div>}
          </details>
        </div>
      </aside>

      {mobileNavOpen && <button className="sidebar-scrim" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航遮罩" />}

      <div className="app-main">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNavOpen(true)} aria-label="打开导航">
            <Menu size={20} />
          </button>
          <button className="global-search" type="button" onClick={() => setSearchOpen(true)}>
            <Search size={17} />
            <span>搜索数据集、任务或模型</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="topbar-actions">
            <div className="cluster-health"><span />{gpuEnabled ? 'GPU Worker 已启用' : cpuTrainingEnabled ? 'CPU Worker 已启用' : '数据处理模式'}</div>
            <button className="icon-button" title="通知" aria-label="通知" onClick={() => setUtilityModal('notifications')}>
              <Bell size={19} />
              {failedTasks.length > 0 && <i className="notification-dot" />}
            </button>
          </div>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      {searchOpen && <Modal title="全局搜索" description="查找数据集、训练任务和模型版本。" onClose={() => setSearchOpen(false)} footer={<button className="button secondary" onClick={() => setSearchOpen(false)}>关闭</button>}><label className="toolbar-search global-search-input"><Search size={17} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="输入名称、模型或数据集" /></label><div className="global-search-results">{searchResults.map((result) => <button key={`${result.path}:${result.id}`} onClick={() => openResult(result.path)}><span><strong>{result.title}</strong><small>{result.subtitle}</small></span><ChevronDown size={16} /></button>)}{searchQuery && !searchResults.length && <p className="empty-inline">没有匹配结果</p>}</div></Modal>}
      {utilityModal === 'help' && <Modal title={`帮助与文档 · ${guide.roleLabel}`} description={guide.title} width="large" className="role-help-modal" onClose={() => setUtilityModal(null)} footer={<button className="button primary" onClick={() => setUtilityModal(null)}>关闭</button>}><div className="role-guide"><header className="role-guide-intro"><span>{guide.roleLabel}</span><h3>{guide.title}</h3><p>{guide.summary}</p></header><div className="role-guide-sections">{guide.sections.map((section) => <section className="role-guide-section" key={section.title}><h3>{section.title}</h3><p>{section.summary}</p><ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol>{section.notes?.map((note) => <div className="role-guide-note" key={note}>{note}</div>)}</section>)}</div></div></Modal>}
      {utilityModal === 'settings' && <Modal title="系统设置" description="当前单租户部署的只读运行配置" onClose={() => setUtilityModal(null)} footer={<button className="button primary" onClick={() => setUtilityModal(null)}>关闭</button>}><dl className="config-grid"><div><dt>部署模式</dt><dd>企业内网 · 单租户</dd></div><div><dt>计算能力</dt><dd>{gpuEnabled ? 'GPU Worker 已启用' : cpuTrainingEnabled ? 'CPU Worker 已启用' : '数据处理模式'}</dd></div><div><dt>CPU 模型转换</dt><dd>{cpuOnnxEnabled ? 'ONNX / TorchScript / OpenVINO' : '未启用'}</dd></div><div><dt>API 连接</dt><dd>{apiEnabled ? '已启用' : '本地模式'}</dd></div><div><dt>当前角色</dt><dd>{roleLabel}</dd></div></dl></Modal>}
      {utilityModal === 'notifications' && <Modal title="任务通知" description={failedTasks.length ? `${failedTasks.length} 个任务需要处理` : '当前没有异常任务'} onClose={() => setUtilityModal(null)} footer={<button className="button primary" onClick={() => setUtilityModal(null)}>关闭</button>}><div className="notification-list">{failedTasks.map((task) => <div key={task.id}><AlertTask /><span><strong>{'name' in task ? task.name : `${task.modelName} ${task.format}`}</strong><small>{task.errorMessage ?? '执行失败，请查看任务详情'}</small></span></div>)}{!failedTasks.length && <p className="empty-inline">所有任务状态正常</p>}</div></Modal>}
    </div>
  );
}

function AlertTask() {
  return <span className="notification-alert">!</span>;
}
