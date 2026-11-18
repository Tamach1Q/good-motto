import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api as defaultApi, createDemoApi, errorMessage, isDemo } from './api';
import type { DemoScenario } from './api';
import Face from './Face';
import Confetti from './Confetti';
import { flushSync } from 'react-dom';
import { useMobileViewport } from './useMobileUX';
import TargetPicker, { PersonLabel } from './TargetPicker';
import type { Analysis, Api, Sentiment, Target } from './types';
import { validateText } from './textValidation';
import { SessionPanel, useSession } from './useSession';

// 保存済みの本文は、/me で確認した同一人物にだけ復元する。
const DRAFT_KEY = 'good-motto-draft-v3';
const DEMO_DRAFT_OWNER = 'demo';
const LEGACY_DRAFT_KEYS = ['good-motto-draft-v1', 'good-motto-draft-v2', 'good-motto-draft-enabled-v2'];
type Draft = { text: string; enabled: boolean };
const EMPTY_DRAFT: Draft = { text: '', enabled: false };
function discardLegacyDrafts() {
  for (const key of LEGACY_DRAFT_KEYS) sessionStorage.removeItem(key);
}
function readDraft(owner: string): Draft {
  try {
    discardLegacyDrafts();
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || !('owner' in saved) || !('text' in saved) ||
        saved.owner !== owner || typeof saved.text !== 'string') {
      sessionStorage.removeItem(DRAFT_KEY);
      return EMPTY_DRAFT;
    }
    return { text: saved.text, enabled: true };
  } catch {
    // 不正な保存値やストレージへのアクセス失敗時には復元しない。
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    return EMPTY_DRAFT;
  }
}
function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
    discardLegacyDrafts();
  } catch { /* storage unavailable */ }
}

export default function App({ api: providedApi, demo = isDemo }: { api?: Api; demo?: boolean }) {
  useMobileViewport();
  const memo = useRef<HTMLTextAreaElement>(null);
  const [typingPulse, setTypingPulse] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const caret = useRef({ start: 0, end: 0, scroll: 0 });
  function rememberCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) { const t = e.currentTarget; caret.current = { start: t.selectionStart, end: t.selectionEnd, scroll: t.scrollTop }; }
  function changeText(value: string) { setText(value); setTypingPulse(n => n + 1); }
  function closeKeyboard() { (document.activeElement as HTMLElement | null)?.blur(); setIsEditing(false); }
  const [scenario, setScenario] = useState<DemoScenario>('normal');
  const scenarioApi = useMemo(() => createDemoApi(scenario), [scenario]);
  const api = providedApi ?? (demo ? scenarioApi : defaultApi);
  const auth = useSession(api, demo);
  // Liveでは本人確認前に下書きを読み出さない。Demoだけ固定の仮利用者を使う。
  const [initialDraft] = useState<Draft>(() => demo ? readDraft(DEMO_DRAFT_OWNER) : EMPTY_DRAFT);
  const [draftOwner, setDraftOwner] = useState<string | null>(demo ? DEMO_DRAFT_OWNER : null);
  const [saveDraft, setSaveDraft] = useState(initialDraft.enabled);
  const [draftError, setDraftError] = useState('');
  const [text, setText] = useState(initialDraft.text);
  const [stage, setStage] = useState<'write' | 'analyzing' | 'review' | 'done' | 'ended'>('write');
  const [confirmExit, setConfirmExit] = useState(false);
  const [picker, setPicker] = useState(false);
  const [sentiment, setSentiment] = useState<Sentiment>('motto');
  const [targetType, setTargetType] = useState<'person' | 'place'>('person');
  const [target, setTarget] = useState<Target | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [, setPostId] = useState('');
  const analysisController = useRef<AbortController | null>(null);
  const postingLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const wasPicker = useRef(false);
  const currentDraftOwner = demo ? DEMO_DRAFT_OWNER : auth.user?.person_id ?? null;
  const draftReady = currentDraftOwner !== null && currentDraftOwner === draftOwner;
  const textError = validateText(text);
  const validText = !textError;
  const canAnalyze = validText && auth.allowed;

  useEffect(() => {
    if (!currentDraftOwner || currentDraftOwner === draftOwner) return;
    // 初回ログインやSlack認証後のページ再読み込み時に、確認済みの本人IDで照合する。
    // 別利用者なら古い本文と操作状態を破棄する。未認証中は復元・保存しない。
    const restored = readDraft(currentDraftOwner);
    if (draftOwner !== null) {
      analysisController.current?.abort();
      setPicker(false);
      setTarget(null);
      setAnalysis(null);
      setError('');
      setPostId('');
      setUncertain(false);
      setStage('write');
    }
    setText(restored.text);
    setSaveDraft(restored.enabled);
    setDraftOwner(currentDraftOwner);
  }, [currentDraftOwner, draftOwner]);
  useEffect(() => {
    if (!draftReady || !currentDraftOwner) return;
    try {
      discardLegacyDrafts();
      if (!saveDraft || stage === 'done') sessionStorage.removeItem(DRAFT_KEY);
      else sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: currentDraftOwner, text }));
      setDraftError('');
    } catch { setDraftError('この環境では下書きを保存できません。本文は画面を閉じるまで残ります。'); }
  }, [currentDraftOwner, draftReady, text, stage, saveDraft]);
  useEffect(() => () => analysisController.current?.abort(), []);
  useEffect(() => {
    if (picker) return;
    if (wasPicker.current) { targetButton.current?.focus(); wasPicker.current = false; }
    else if (stage !== 'write') heading.current?.focus();
  }, [stage, picker]);
  function openPicker() { wasPicker.current = true; closeKeyboard(); flushSync(() => { setError(''); setPicker(true); }); document.getElementById('person-query')?.focus(); }
  async function analyze() {
    if (!canAnalyze || stage === 'analyzing') return;
    closeKeyboard();
    const controller = new AbortController(); analysisController.current?.abort(); analysisController.current = controller;
    setError(''); setStage('analyzing');
    try {
      const result = await api.analyze(text.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setAnalysis(result); setSentiment(result.sentiment);
      // 人物IDはAIの推測で確定せず、必ず候補から本人を選択します。
      if (!target && result.target_type !== 'unknown') setTargetType(result.target_type);
      setStage('review');
    } catch (e) { if (controller.signal.aborted) return; setError(errorMessage(e)); setStage('write'); await auth.handleError(e); }
  }
  function backToWrite() { analysisController.current?.abort(); flushSync(() => { setStage('write'); setError(''); }); memo.current?.focus({ preventScroll: true }); memo.current?.setSelectionRange(caret.current.start, caret.current.end); if (memo.current) memo.current.scrollTop = caret.current.scroll; }
  async function post() {
    if (!target || !validText || !auth.allowed || uncertain || postingLock.current) return;
    closeKeyboard();
    postingLock.current = true; setPosting(true); setError('');
    try {
      const result = await api.post({ text: text.trim(), sentiment, target_type: target.type, target_id: target.type === 'person' ? target.person.id : target.place.id });
      setPostId(result.post_id); setStage('done'); setText('');
    } catch (e) {
      const unknown = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      if (unknown) setUncertain(true);
      setError(errorMessage(e));
      await auth.handleError(e);
    }
    finally { postingLock.current = false; setPosting(false); }
  }
  function reset() { setConfirmExit(false); clearDraft(); setUncertain(false); setText(''); setSaveDraft(false); setTarget(null); setAnalysis(null); setError(''); setPostId(''); setStage('write'); }
  function startNew() { flushSync(reset); memo.current?.focus({ preventScroll: true }); }
  return <div className="app-shell">
    <main className="phone-surface" aria-busy={posting || stage === 'analyzing'}>
      <div className="topbar"><div className="brand">Good / Motto</div>
        <details className="utility-menu"><summary aria-label="設定">···</summary><div className="utility-content">
          {demo && <><strong>デモ・保存や通知はしません</strong><label htmlFor="demo-scenario">動作確認</label><select id="demo-scenario" value={scenario} disabled={posting || stage === 'analyzing'} onChange={e => setScenario(e.target.value as DemoScenario)}><option value="normal">通常</option><option value="analyze-error">分析エラー</option><option value="unclassifiable">分析不能</option><option value="people-error">人物検索エラー</option><option value="places-error">場所取得エラー</option><option value="post-error">投稿エラー</option></select></>}
          <label className="consent"><input type="checkbox" checked={saveDraft} disabled={!draftReady || posting} onChange={e => setSaveDraft(e.target.checked)} /><span>このタブに下書きを保存する</span></label>
          {draftError && <p role="status">{draftError}</p>}
        </div></details>
      </div>
      {!demo && <SessionPanel auth={auth} busy={posting || stage === 'analyzing'} onLogout={() => { reset(); setPicker(false); }} />}
      {auth.allowed && !draftReady && <section className="auth-screen" role="status">下書きを確認しています。</section>}
      {auth.allowed && draftReady && (picker ? <TargetPicker api={api} onAccessError={auth.handleError} initialType={targetType} onCancel={() => setPicker(false)} onSelect={selected => { closeKeyboard(); setTarget(selected); setTargetType(selected.type); setPicker(false); }} />
        : <section className={`screen stage-${stage}`} aria-labelledby="screen-heading">
          <Face expression={stage === 'review' ? sentiment : 'neutral'} typingPulse={typingPulse} isEditing={isEditing && (stage === 'write' || stage === 'review')} />
          {stage === 'done' && <Confetti />}
          <h1 ref={heading} id="screen-heading" tabIndex={-1}>{stage === 'write' ? 'メモ' : stage === 'analyzing' ? '分類しています' : stage === 'review' ? '投稿内容を確認' : stage === 'ended' ? '投稿せずに終了しました' : demo ? '投稿を試しました' : '投稿しました'}</h1>
          {stage === 'write' && <>
            <label htmlFor="memo" className="sr-only">メモの本文</label>
            <textarea ref={memo} autoFocus id="memo" className="memo" placeholder="ここに書く" value={text} onChange={e => changeText(e.target.value)} onFocus={() => setIsEditing(true)} onBlur={e => { rememberCaret(e); setIsEditing(false); }} onSelect={rememberCaret} />
            {text.trim() && textError && <p className="error-panel" role="alert">{textError}</p>}
            {error && <p className="error-panel" role="alert">{error}</p>}
            <div className="actions">
              <button className="primary" disabled={!canAnalyze} onClick={analyze}>AIで分類する</button>
              <button className="text-button" onClick={() => text ? setConfirmExit(true) : setStage('ended')}>投稿せずに終える</button>
            </div>
          </>}
          {stage === 'analyzing' && <><div className="processing" role="status"><span className="spinner" /><p>内容を確認しています。</p></div><div className="actions"><button className="text-button" onClick={backToWrite}>メモに戻る</button></div></>}
          {stage === 'review' && <>
            <label className="field-label">対象</label>
            <button ref={targetButton} disabled={posting} className="target-field" onClick={openPicker}>{target ? target.type === 'person' ? <PersonLabel person={target.person} /> : <strong>{target.place.name}</strong> : <span className="placeholder">{analysis?.target_label ? `候補：${analysis.target_label}（未確定）` : '対象を選ぶ'}</span>}<span className="target-action">{target ? '変更' : '選ぶ'}</span></button>
            <fieldset disabled={posting}><legend>分類</legend><div className="segmented sentiment"><button aria-pressed={sentiment === 'good'} onClick={() => setSentiment('good')}>Good</button><button aria-pressed={sentiment === 'motto'} onClick={() => setSentiment('motto')}>Motto</button></div></fieldset>
            <label className="field-label" htmlFor="review-memo">本文</label><textarea id="review-memo" className="memo review-memo" disabled={posting} value={text} onChange={e => changeText(e.target.value)} onFocus={() => setIsEditing(true)} onBlur={e => { rememberCaret(e); setIsEditing(false); }} onSelect={rememberCaret} />
            {text.trim() && textError && <p className="error-panel" role="alert">{textError}</p>}
            {error && <p className="error-panel" role="alert">{error}</p>}
            {uncertain && <p role="status" className="error-panel">投稿結果を確認できません。二重投稿を防ぐため再送を停止しました。担当者に確認してください。</p>}
            <div className="actions"><button className="primary" disabled={!target || !validText || posting || uncertain} onClick={post}>{posting ? '投稿しています' : demo ? '投稿を試す' : '投稿する'}</button><p className="quiet">原文は届きません。条件を満たすと<br />週次の要約がSlackに届きます。</p><button className="text-button" disabled={posting} onClick={backToWrite}>入力に戻る</button></div>
          </>}
          {(stage === 'done' || stage === 'ended') && <div className="actions"><button className="primary" onClick={startNew}>新しく書く</button></div>}
        </section>)}
      {confirmExit && <div className="modal-backdrop"><section className="exit-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-title" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setConfirmExit(false); }
        if (e.key === 'Tab') {
          const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          e.preventDefault(); buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }
      }}><h2 id="exit-title">本文を消して終了しますか？</h2><p>このタブの下書きも削除します。</p><button className="primary" onClick={() => { reset(); setStage('ended'); }}>消して終了</button><button className="text-button" autoFocus onClick={() => setConfirmExit(false)}>書き続ける</button></section></div>}
    </main>
  </div>;
}
