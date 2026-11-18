import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import type { Api, Preferences, SessionUser } from './types';

type Status = 'loading' | 'anonymous' | 'forbidden' | 'error' | 'ready';
export function useSession(api: Api, demo: boolean) {
  const [status, setStatus] = useState<Status>(demo ? 'ready' : 'loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setStatus('loading'); setError('');
    try { const next = await api.me(); if (id !== generation.current) return; setUser(next); setStatus('ready'); }
    catch (e) {
      if (id !== generation.current) return;
      setUser(null); setError(errorMessage(e));
      setStatus(e instanceof ApiError && e.status === 401 ? 'anonymous' : e instanceof ApiError && e.status === 403 ? 'forbidden' : 'error');
    }
  }, [api]);
  useEffect(() => { if (!demo) void refresh(); return () => { generation.current++; }; }, [demo, refresh]);
  const handleError = useCallback(async (e: unknown) => {
    if (demo || !(e instanceof ApiError)) return;
    if (e.status === 401) { generation.current++; setUser(null); setStatus('anonymous'); setSettings(false); }
    else if (e.status === 403) await refresh();
  }, [demo, refresh]);
  async function save(input: Preferences) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { const next = await api.preferences(input); setUser(next); setStatus('ready'); setSettings(false); }
    catch (e) { setError(errorMessage(e)); await handleError(e); }
    finally { lock.current = false; setSaving(false); }
  }
  async function logout(onSuccess: () => void) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { await api.logout(); onSuccess(); setUser(null); setSettings(false); setStatus('anonymous'); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) { onSuccess(); setUser(null); setSettings(false); setStatus('anonymous'); }
      else setError(errorMessage(e));
    } finally { lock.current = false; setSaving(false); }
  }
  return { status, user, error, settings, setSettings, saving, refresh, save, logout, handleError,
    allowed: demo || (status === 'ready' && !!user?.terms_accepted && !settings) };
}

export function SessionPanel({ auth, busy, onLogout }: { auth: ReturnType<typeof useSession>; busy: boolean; onLogout: () => void }) {
  const [terms, setTerms] = useState(false);
  const [feedback, setFeedback] = useState(false);
  useEffect(() => { setTerms(auth.user?.terms_accepted ?? false); setFeedback(auth.user?.feedback_opt_in ?? false); }, [auth.user, auth.settings]);
  if (auth.allowed) return <div className="session-toolbar"><span>{auth.user?.display_name}</span><button disabled={busy || auth.saving} onClick={() => auth.setSettings(true)}>利用設定</button><button disabled={busy || auth.saving} onClick={() => void auth.logout(onLogout)}>ログアウト</button>{auth.error && <p role="alert">{auth.error}</p>}</div>;
  if (auth.status === 'loading') return <section className="auth-screen" role="status"><span className="spinner small" /> ログイン状態を確認しています。</section>;
  if (auth.status === 'anonymous') return <section className="auth-screen"><h1>Slackでログイン</h1><p>学校のSlackアカウントで利用します。</p><a className="primary" href="/api/v1/auth/slack/login">Slackでログインする</a><p className="hint">入力中のメモはこの画面に残っています。ログインで画面を離れると、下書き保存を選んでいない本文は失われます。</p><button className="secondary" onClick={() => void auth.refresh()}>ログイン状態を再確認</button></section>;
  if (auth.status === 'error' || auth.status === 'forbidden') return <section className="auth-screen"><h1>{auth.status === 'forbidden' ? '利用できません' : '接続を確認してください'}</h1><p role="alert">{auth.error}</p><button className="secondary" onClick={() => void auth.refresh()}>再確認する</button></section>;
  return <section className="auth-screen"><h1>利用設定</h1><p>{auth.user?.display_name}さん</p><p className="description">本文はサーバー経由で外部AI（Gemini）に送信し、分類・集計します。無料枠では送信内容がサービス改善に使われる場合があります。投稿原文を本人へ転送することはありません。</p>
    <label className="consent"><input type="checkbox" checked={terms} disabled={auth.saving || !!auth.user?.terms_accepted} onChange={e => setTerms(e.target.checked)} /><span>上記の扱いを確認し、サービスの利用に同意する</span></label>
    <label className="consent"><input type="checkbox" checked={feedback} disabled={auth.saving} onChange={e => setFeedback(e.target.checked)} /><span>自分もフィードバックの対象となり、週次レポートをSlackで受け取る（任意・あとで変更できます）</span></label>
    <p className="hint">受信をオフにしても投稿できます。利用同意の撤回は管理者に連絡してください。</p>
    {auth.error && <p className="error-panel" role="alert">{auth.error}</p>}
    <div className="actions"><button className="primary" disabled={!terms || auth.saving} onClick={() => void auth.save({ terms_accepted: terms, feedback_opt_in: feedback })}>{auth.saving ? '保存しています' : '設定を保存する'}</button>{auth.user?.terms_accepted && <button className="secondary" disabled={auth.saving} onClick={() => auth.setSettings(false)}>メモに戻る</button>}<button className="text-button" disabled={auth.saving} onClick={() => void auth.logout(onLogout)}>ログアウト</button></div>
  </section>;
}
