import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, KeyRound, Trash2, UserPlus, Users, X } from 'lucide-react';
import { BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { useApp } from '../context/AppContext';
import { userRoles, type UserRole } from '../../shared/contracts';

const roleLabels: Record<UserRole, string> = { admin: '管理员', reviewer: '审核员', annotator: '标注员' };
const roleDescriptions: Record<UserRole, string> = { admin: '系统设置、用户、数据、模型和训练全权限', reviewer: '数据审核、数据下载和模型训练', annotator: '领取 Job、编辑标注并提交审核' };
const roleClass = (role: UserRole) => `role-chip role-${role}`;

export function AdminPage() {
  const { users, session, refreshAdminData, createUser, updateUser, deleteUser, notify } = useApp();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'annotator' as UserRole });
  const [savingUser, setSavingUser] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState<UserRole[]>([...userRoles]);
  const [createUserOpen, setCreateUserOpen] = useState(false);

  useEffect(() => { void refreshAdminData().catch((error) => notify('管理数据加载失败', error instanceof Error ? error.message : '请稍后重试', 'error')); }, [refreshAdminData, notify]);

  const userSummary = useMemo(() => userRoles.map((role) => ({ role, count: users.filter((user) => user.enabled !== false && user.role === role).length })), [users]);
  const removeUserAccount = async (userId: string, username: string, displayName: string) => {
    if (session?.user.id === userId) { notify('无法删除当前账号', '请使用其他管理员账号执行删除', 'error'); return; }
    if (!window.confirm(`确认删除账号“${displayName}（${username}）”吗？\n\n账号将无法登录并从用户列表移除；历史标注、审核和操作记录会保留为“已删除用户”。此操作不可恢复。`)) return;
    try { await deleteUser(userId); notify('账号已删除', `${displayName} 已从系统移除`); }
    catch (error) { notify('账号删除失败', error instanceof Error ? error.message : '请稍后重试', 'error'); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSavingUser(true);
    try { await createUser({ ...form, roles: [form.role] }); setForm({ username: '', displayName: '', password: '', role: 'annotator' }); setCreateUserOpen(false); notify('用户已创建', '账号可以立即参与对应数据集工作'); }
    catch (error) { notify('创建用户失败', error instanceof Error ? error.message : '请检查输入', 'error'); }
    finally { setSavingUser(false); }
  };
  return <div className="page admin-page">
    <PageHeader title="系统管理" description="统一管理用户账号与角色权限" actions={<Link className="button secondary compact" to="/admin/annotation-statistics"><BarChart3 size={14} />标注审核统计</Link>} />
    <section className="admin-overview">
      <div className="admin-overview-copy"><span className="eyebrow">USER MANAGEMENT</span><h2>让每个账号都有清晰的责任边界</h2><p>通过固定角色管理系统成员权限，数据集任务分配在数据中心完成。</p></div>
      <div className="admin-role-summary">{userSummary.map(({ role, count }) => <div key={role}><span className={roleClass(role)}>{roleLabels[role]}</span><strong>{count}</strong><small>个启用账号</small></div>)}</div>
    </section>
    <div className="admin-layout">
      <section className="admin-card admin-users-card"><header className="admin-card-header"><div><span className="admin-card-icon"><Users size={18} /></span><div><h2>用户与角色</h2><p>每个用户只能绑定一个固定角色</p></div></div><div className="admin-card-header-actions"><span className="card-count">{users.length} 个账号</span><button className="button primary compact" type="button" onClick={() => setCreateUserOpen(true)}><UserPlus size={14} />创建账号</button></div></header>
        <div className="admin-user-groups">{userRoles.map((role) => { const groupedUsers = users.filter((user) => user.role === role); const expanded = expandedRoles.includes(role); return <section className="admin-user-group" key={role}><button className="admin-group-toggle" onClick={() => setExpandedRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])}><span className={roleClass(role)}>{roleLabels[role]}</span><span className="admin-group-description">{roleDescriptions[role]}</span><strong>{groupedUsers.length}</strong><ChevronDown size={17} className={expanded ? 'expanded' : ''} /></button>{expanded && <div className="admin-user-list">{groupedUsers.length ? groupedUsers.map((user) => <div className={`admin-user-row ${user.enabled === false ? 'disabled' : ''}`} key={`${role}-${user.id}`}><span className="user-avatar">{user.displayName.slice(0, 1)}</span><div className="user-identity"><strong>{user.displayName}</strong><small>{user.username} · {user.enabled === false ? '已禁用' : '正常'}</small></div><div className="user-roles"><span className={roleClass(user.role)}>{roleLabels[user.role]}</span></div><div className="admin-user-actions"><button className="button secondary compact" onClick={() => void updateUser(user.id, { enabled: user.enabled === false }).catch((error) => notify('更新用户失败', error instanceof Error ? error.message : '请稍后重试', 'error'))}>{user.enabled === false ? '启用账号' : '禁用账号'}</button><button className="button danger compact" disabled={session?.user.id === user.id} title={session?.user.id === user.id ? '不能删除当前登录账号' : '删除账号'} onClick={() => void removeUserAccount(user.id, user.username, user.displayName)}><Trash2 size={14} />删除</button></div></div>) : <p className="admin-group-empty">该角色暂无用户</p>}</div>}</section>; })}</div>
      </section>
      
    </div>
    {createUserOpen && <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateUserOpen(false); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title"><header className="admin-modal-header"><div><span className="admin-card-icon"><UserPlus size={18} /></span><div><h2 id="create-user-title">创建账号</h2><p>账号创建后可在数据集配置中分配任务</p></div></div><button className="icon-button" type="button" aria-label="关闭创建账号窗口" onClick={() => setCreateUserOpen(false)}><X size={18} /></button></header><form className="admin-create-form" onSubmit={submit}><div className="form-grid two"><label className="form-field"><span>登录账号</span><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="例如：zhangsan" /></label><label className="form-field"><span>显示名称</span><input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：张三" /></label></div><label className="form-field"><span>初始密码</span><input required type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 8 位字符" /></label><div className="role-picker"><span className="form-label">绑定角色</span><div className="role-picker-grid">{userRoles.map((role) => <button type="button" key={role} className={`role-option ${form.role === role ? 'selected' : ''}`} onClick={() => setForm({ ...form, role })}><span className={roleClass(role)}>{roleLabels[role]}</span><small>{roleDescriptions[role]}</small>{form.role === role ? <Check size={16} /> : <X size={16} />}</button>)}</div></div><div className="admin-modal-actions"><button className="button secondary" type="button" onClick={() => setCreateUserOpen(false)}>取消</button><button className="button primary" type="submit" disabled={savingUser}><KeyRound size={16} />{savingUser ? '正在创建…' : '创建账号'}</button></div></form></section></div>}
  </div>;
}
