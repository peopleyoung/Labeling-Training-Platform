import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, UserRound } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export function LoginPage() {
  const { apiEnabled, login, session } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const destination = from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/';

  if (!apiEnabled) return <Navigate to="/" replace />;
  if (session) return <Navigate to={destination} replace />;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(username, password);
      navigate(destination, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand"><span className="login-mark"><i /><i /></span><div><strong>FORGE AI</strong><small>MODEL STUDIO</small></div></div>
        <div className="login-copy"><span>工业质检模型平台</span><h1 id="login-title">登录工作空间</h1><p>使用内网账号进入数据、训练、模型和部署工作台。</p></div>
        <form className="login-form" onSubmit={submit}>
          <label className="form-field"><span>账号</span><div className="login-input"><UserRound size={17} /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="输入账号" required /></div></label>
          <label className="form-field"><span>密码</span><div className="login-input"><LockKeyhole size={17} /><input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" type="password" placeholder="输入密码" required /></div></label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="button primary login-submit" disabled={submitting}>{submitting ? '正在验证' : '登录工作空间'}<ArrowRight size={17} /></button>
        </form>
      </section>
    </main>
  );
}
