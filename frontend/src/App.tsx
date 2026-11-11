import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api as defaultApi, createDemoApi, errorMessage, isDemo } from './api';
import type { DemoScenario } from './api';
import TargetPicker, { PersonLabel } from './TargetPicker';
import type { Analysis, Api, Sentiment, Target } from './types';
import { measureText, textLimits, validateText } from './textValidation';
import { SessionPanel, useSession } from './useSession';

const DRAFT_KEY = 'good-motto-draft-v2';
const DRAFT_OPT_IN = 'good-motto-draft-enabled-v2';
function draftEnabled() { try { return sessionStorage.getItem(DRAFT_OPT_IN) === 'true'; } catch { return false; } }
function readDraft() { try { return draftEnabled() ? sessionStorage.getItem(DRAFT_KEY) ?? '' : ''; } catch { return ''; } }

export default function App({ api: providedApi, demo = isDemo }: { api?: Api; demo?: boolean }) {
  const [scenario, setScenario] = useState<DemoScenario>('normal');
  const scenarioApi = useMemo(() => createDemoApi(scenario), [scenario]);
  const api = providedApi ?? (demo ? scenarioApi : defaultApi);
  const [consent, setConsent] = useState(false);
  const [saveDraft, setSaveDraft] = useState(draftEnabled);
  const [draftError, setDraftError] = useState('');
  const auth = useSession(api, demo);
  const [text, setText] = useState(readDraft);
  const [stage, setStage] = useState<'write' | 'analyzing' | 'review' | 'done'>('write');
  const [picker, setPicker] = useState(false);
  const [sentiment, setSentiment] = useState<Sentiment>('motto');
  const [targetType, setTargetType] = useState<'person' | 'place'>('person');
  const [target, setTarget] = useState<Target | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [postId, setPostId] = useState('');
  const analysisController = useRef<AbortController | null>(null);
  const postingLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const wasPicker = useRef(false);
  const previousUserId = useRef<string | null>(null);
  const textError = validateText(text);
  const validText = !textError;
  const count = measureText(text.trim());
  const canAnalyze = validText && (demo ? consent : auth.allowed);

  useEffect(() => {
    try {
      sessionStorage.removeItem('good-motto-draft-v1');
      if (!saveDraft || stage === 'done') { sessionStorage.removeItem(DRAFT_KEY); sessionStorage.removeItem(DRAFT_OPT_IN); }
      else { sessionStorage.setItem(DRAFT_OPT_IN, 'true'); if (text) sessionStorage.setItem(DRAFT_KEY, text); else sessionStorage.removeItem(DRAFT_KEY); }
      setDraftError('');
    } catch { setDraftError('この環境では下書きを保存できません。本文は画面を閉じるまで残ります。'); }
  }, [text, stage, saveDraft]);
  useEffect(() => () => analysisController.current?.abort(), []);
  useEffect(() => {
    const id = auth.user?.person_id;
    if (id && previousUserId.current && previousUserId.current !== id) {
      reset(); setPicker(false); setConsent(false);
    }
    if (id) previousUserId.current = id;
  }, [auth.user?.person_id]);
  useEffect(() => {
    if (picker) return;
    if (wasPicker.current) { targetButton.current?.focus(); wasPicker.current = false; }
    else if (stage !== 'write') heading.current?.focus();
  }, [stage, picker]);
  function openPicker() { wasPicker.current = true; setError(''); setPicker(true); }
  async function analyze() {
    if (!canAnalyze || stage === 'analyzing') return;
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
  function backToWrite() { analysisController.current?.abort(); setStage('write'); setError(''); }
  async function post() {
    if (!target || !validText || !auth.allowed || uncertain || postingLock.current) return;
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
  function reset() { setUncertain(false); setText(''); setSaveDraft(false); setTarget(null); setAnalysis(null); setError(''); setPostId(''); setStage('write'); }
  return <div className="app-shell">
    <aside className="desktop-note" aria-hidden="true"><span className="brand-mark">g/m</span><p>言えなかったことも、<br />よかったことも。</p><span>Good / Motto</span></aside>
    <main className="phone-surface" aria-busy={posting || stage === 'analyzing'}>
      <div className="brand"><span className="brand-dot" /> Good / Motto <span className="brand-caption">日々のメモ</span></div>
      {demo && <details className="demo-banner"><summary>デモ · 投稿は保存しません</summary><label htmlFor="demo-scenario">動作確認する状態</label><select id="demo-scenario" value={scenario} disabled={posting || stage === 'analyzing'} onChange={e => setScenario(e.target.value as DemoScenario)}><option value="normal">通常</option><option value="analyze-error">分析エラー</option><option value="unclassifiable">分析不能</option><option value="people-error">人物検索エラー</option><option value="places-error">場所取得エラー</option><option value="post-error">投稿エラー</option></select><p>「田」で同姓同名、「髙橋」で候補なしを確認できます。</p></details>}
      {!demo && <SessionPanel auth={auth} busy={posting || stage === 'analyzing'} onLogout={() => { reset(); setPicker(false); setConsent(false); }} />}
      {auth.allowed && (picker ? <TargetPicker api={api} onAccessError={auth.handleError} initialType={targetType} onCancel={() => setPicker(false)} onSelect={selected => { setTarget(selected); setTargetType(selected.type); setPicker(false); }} />
        : <section className="screen" aria-labelledby="screen-heading">
          <header><p className="eyebrow">{stage === 'review' ? '投稿の確認' : stage === 'done' ? '完了' : '自分のペースで'}</p>
            <h1 ref={heading} id="screen-heading" tabIndex={-1}>{stage === 'write' ? 'メモ' : stage === 'analyzing' ? '内容を分類しています' : stage === 'review' ? '投稿内容を確認' : demo ? '投稿を試しました' : '投稿しました'}</h1>
            <p className="description">{stage === 'write' ? 'まとまっていなくても、そのまま書けます。' : stage === 'analyzing' ? 'Good / Motto と、人物・場所を分類します。' : stage === 'review' ? '分類と対象は、自分で変更できます。' : demo ? 'デモのため、保存・通知はしていません。' : '相手へすぐに通知されることはありません。'}</p>
          </header>
          {stage === 'write' && <>
            <label htmlFor="memo" className="sr-only">メモの本文</label>
            <textarea id="memo" className="memo" placeholder="ここに書く" value={text} onChange={e => setText(e.target.value)} aria-describedby="memo-note" />
            <div className="memo-meta"><span id="memo-note">入力内容はAIで分類します。原文は本人に届きません。</span><span>{count.characters.toLocaleString()}{textLimits.characters ? ` / ${textLimits.characters.toLocaleString()}` : ''}文字{textLimits.bytes ? ` · ${count.bytes.toLocaleString()} / ${textLimits.bytes.toLocaleString()}バイト` : ''}</span></div>
            <label className="field-label">対象 <span className="optional">あとで選べます</span></label>
            <button ref={targetButton} className="target-field" onClick={openPicker}>{target ? target.type === 'person' ? <PersonLabel person={target.person} /> : <strong>{target.place.name}</strong> : <span className="placeholder">Slackの名前で検索 / 場所を選ぶ</span>}<span className="target-action">{target ? '変更' : '選ぶ'}</span></button>
            {error && <p className="error-panel" role="alert">{error}</p>}
            {text.trim() && textError && <p className="error-panel" role="alert">{textError}</p>}
            <label className="consent"><input type="checkbox" checked={saveDraft} onChange={e => setSaveDraft(e.target.checked)} /><span>このタブに下書きを保存する（オフにすると削除します）</span></label>
            {draftError && <p className="hint" role="status">{draftError}</p>}
            {demo && <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>本文をサーバー経由で外部AI（Gemini）へ送信し、分類することに同意します。無料枠では送信内容がサービス改善に使われる場合があります。</span></label>}
            <div className="actions"><button className="primary" disabled={!canAnalyze} onClick={analyze}>内容を確認する <span aria-hidden="true">→</span></button><p className="quiet">この操作では、まだ投稿されません。</p></div>
          </>}
          {stage === 'analyzing' && <><div className="processing" role="status"><span className="spinner" /><p>分類ができたら、確認画面を表示します。</p><small>入力したメモは残っています。</small></div><div className="actions"><button className="secondary" onClick={backToWrite}>メモに戻る</button></div></>}
          {stage === 'review' && <>
            <fieldset disabled={posting}><legend>分類</legend><div className="segmented sentiment"><button aria-pressed={sentiment === 'good'} onClick={() => setSentiment('good')}><strong>Good</strong><small>よかったこと</small></button><button aria-pressed={sentiment === 'motto'} onClick={() => setSentiment('motto')}><strong>Motto</strong><small>改善してほしいこと</small></button></div></fieldset>
            <label className="field-label">対象 / 人物・場所</label>
            <button ref={targetButton} disabled={posting} className="target-field" onClick={openPicker}>{target ? target.type === 'person' ? <PersonLabel person={target.person} /> : <strong>{target.place.name}</strong> : <span className="placeholder">{analysis?.target_label ? `候補：${analysis.target_label}（未確定）` : '対象を選ぶ'}</span>}<span className="target-action">{target ? '変更' : '選ぶ'}</span></button>
            {!target && <p className="hint">候補から対象を選ぶと、投稿できます。</p>}
            <label className="field-label" htmlFor="review-memo">本文</label><textarea id="review-memo" className="memo review-memo" disabled={posting} value={text} onChange={e => setText(e.target.value)} />
            {text.trim() && textError && <p className="error-panel" role="alert">{textError}</p>}
            <p className="hint">本文も修正できます。人物向けの内容は週次で集計し、配信条件を満たした場合にSlackで届きます。</p>
            {error && <p className="error-panel" role="alert">{error}</p>}
            {uncertain && <p role="status" className="error-panel">投稿結果を確認できません。二重投稿を防ぐため再送を停止しました。担当者に確認してください。</p>}
            <div className="actions"><button className="primary" disabled={!target || !validText || posting || uncertain} onClick={post}>{posting ? <><span className="spinner small" /> 投稿しています</> : demo ? '投稿を試す' : '投稿する'}</button><button className="secondary" disabled={posting} onClick={backToWrite}>入力に戻る</button></div>
          </>}
          {stage === 'done' && <><div className="done-card"><span className="done-check" aria-hidden="true">✓</span><h2>{demo ? '操作の確認ができました' : `${sentiment === 'good' ? 'Good' : 'Motto'} を記録しました`}</h2><p>{target?.type === 'person' ? '人物向けの通知は週次で行われます。原文をそのまま本人へ転送することはありません。' : '場所ごとの集計に使われます。'}</p>{!demo && <small>投稿ID：{postId}</small>}</div><div className="actions"><button className="primary" onClick={reset}>新しく書く</button></div></>}
        </section>)}
      <footer className="app-footer">Good / Motto<span>言葉にするための、小さな余白。</span></footer>
    </main>
  </div>;
}
