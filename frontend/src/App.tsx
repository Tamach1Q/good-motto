import { useEffect, useMemo, useRef, useState } from 'react';
import { api as defaultApi, createDemoApi, errorMessage, isDemo } from './api';
import type { DemoScenario } from './api';
import TargetPicker, { PersonLabel } from './TargetPicker';
import type { Analysis, Api, Sentiment, Target } from './types';

const DRAFT_KEY = 'good-motto-draft-v1';
const MAX_TEXT = 5000; // クライアントの暫定上限。バックエンドと合意してください。
function readDraft() { try { return sessionStorage.getItem(DRAFT_KEY)?.slice(0, MAX_TEXT) ?? ''; } catch { return ''; } }

export default function App({ api: providedApi, demo = isDemo }: { api?: Api; demo?: boolean }) {
  const [scenario, setScenario] = useState<DemoScenario>('normal');
  const scenarioApi = useMemo(() => createDemoApi(scenario), [scenario]);
  const api = providedApi ?? (demo ? scenarioApi : defaultApi);
  const [consent, setConsent] = useState(false);
  const loginUrl = import.meta.env.VITE_LOGIN_URL as string | undefined;
  const [text, setText] = useState(readDraft);
  const [stage, setStage] = useState<'write' | 'analyzing' | 'review' | 'done'>('write');
  const [picker, setPicker] = useState(false);
  const [sentiment, setSentiment] = useState<Sentiment>('motto');
  const [targetType, setTargetType] = useState<'person' | 'place'>('person');
  const [target, setTarget] = useState<Target | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [postId, setPostId] = useState('');
  const analysisController = useRef<AbortController | null>(null);
  const postingLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const wasPicker = useRef(false);
  const validText = text.trim().length > 0 && text.length <= MAX_TEXT;

  useEffect(() => {
    try { if (stage === 'done' || !text) sessionStorage.removeItem(DRAFT_KEY); else sessionStorage.setItem(DRAFT_KEY, text); } catch { /* ストレージが無効でも入力は継続できます。 */ }
  }, [text, stage]);
  useEffect(() => () => analysisController.current?.abort(), []);
  useEffect(() => {
    if (picker) return;
    if (wasPicker.current) { targetButton.current?.focus(); wasPicker.current = false; }
    else if (stage !== 'write') heading.current?.focus();
  }, [stage, picker]);
  function openPicker() { wasPicker.current = true; setError(''); setPicker(true); }
  async function analyze() {
    if (!validText || !consent || stage === 'analyzing') return;
    const controller = new AbortController(); analysisController.current?.abort(); analysisController.current = controller;
    setError(''); setStage('analyzing');
    try {
      const result = await api.analyze(text.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setAnalysis(result); setSentiment(result.sentiment);
      // 人物IDはAIの推測で確定せず、必ず候補から本人を選択します。
      if (!target && result.target_type !== 'unknown') setTargetType(result.target_type);
      setStage('review');
    } catch (e) { if (controller.signal.aborted) return; setError(errorMessage(e)); setStage('write'); }
  }
  function backToWrite() { analysisController.current?.abort(); setStage('write'); setError(''); }
  async function post() {
    if (!target || !validText || postingLock.current) return;
    postingLock.current = true; setPosting(true); setError('');
    try {
      const result = await api.post({ text: text.trim(), sentiment, target_type: target.type, target_id: target.type === 'person' ? target.person.id : target.place.id });
      setPostId(result.post_id); setStage('done'); setText('');
    } catch (e) { setError(`${errorMessage(e)} 投稿できたか不明な場合は、担当者に確認してから再度お試しください。`); }
    finally { postingLock.current = false; setPosting(false); }
  }
  function reset() { setText(''); setTarget(null); setAnalysis(null); setError(''); setPostId(''); setStage('write'); }
  return <div className="app-shell">
    <aside className="desktop-note" aria-hidden="true"><span className="brand-mark">g/m</span><p>言えなかったことも、<br />よかったことも。</p><span>Good / Motto</span></aside>
    <main className="phone-surface" aria-busy={posting || stage === 'analyzing'}>
      <div className="brand"><span className="brand-dot" /> Good / Motto <span className="brand-caption">日々のメモ</span></div>
      {demo && <details className="demo-banner"><summary>デモ · 投稿は保存しません</summary><label htmlFor="demo-scenario">動作確認する状態</label><select id="demo-scenario" value={scenario} disabled={posting || stage === 'analyzing'} onChange={e => setScenario(e.target.value as DemoScenario)}><option value="normal">通常</option><option value="analyze-error">分析エラー</option><option value="unclassifiable">分析不能</option><option value="people-error">人物検索エラー</option><option value="places-error">場所取得エラー</option><option value="post-error">投稿エラー</option></select><p>「田」で同姓同名、「髙橋」で候補なしを確認できます。</p></details>}
      {!demo && <div className="auth-note">投稿にはログインが必要です。{loginUrl ? <a href={loginUrl}>ログインする</a> : <span>ログイン方法は管理者に確認してください。</span>}</div>}
      {picker ? <TargetPicker api={api} initialType={targetType} onCancel={() => setPicker(false)} onSelect={selected => { setTarget(selected); setTargetType(selected.type); setPicker(false); }} />
        : <section className="screen" aria-labelledby="screen-heading">
          <header><p className="eyebrow">{stage === 'review' ? '投稿の確認' : stage === 'done' ? '完了' : '自分のペースで'}</p>
            <h1 ref={heading} id="screen-heading" tabIndex={-1}>{stage === 'write' ? 'メモ' : stage === 'analyzing' ? '内容を分類しています' : stage === 'review' ? '投稿内容を確認' : demo ? '投稿を試しました' : '投稿しました'}</h1>
            <p className="description">{stage === 'write' ? 'まとまっていなくても、そのまま書けます。' : stage === 'analyzing' ? 'Good / Motto と、人物・場所を分類します。' : stage === 'review' ? '分類と対象は、自分で変更できます。' : demo ? 'デモのため、保存・通知はしていません。' : '相手へすぐに通知されることはありません。'}</p>
          </header>
          {stage === 'write' && <>
            <label htmlFor="memo" className="sr-only">メモの本文</label>
            <textarea id="memo" className="memo" placeholder="ここに書く" value={text} maxLength={MAX_TEXT} onChange={e => setText(e.target.value)} aria-describedby="memo-note" />
            <div className="memo-meta"><span id="memo-note">入力内容はAIで分類します。原文は本人に届きません。</span><span>{text.length.toLocaleString()} / {MAX_TEXT.toLocaleString()}</span></div>
            <label className="field-label">対象 <span className="optional">あとで選べます</span></label>
            <button ref={targetButton} className="target-field" onClick={openPicker}>{target ? target.type === 'person' ? <PersonLabel person={target.person} /> : <strong>{target.place.name}</strong> : <span className="placeholder">Slackの名前で検索 / 場所を選ぶ</span>}<span className="target-action">{target ? '変更' : '選ぶ'}</span></button>
            {error && <p className="error-panel" role="alert">{error}</p>}
            <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>本文をサーバー経由で外部AI（Gemini）へ送信し、分類することに同意します。無料枠では送信内容がサービス改善に使われる場合があります。</span></label>
            <div className="actions"><button className="primary" disabled={!validText || !consent} onClick={analyze}>内容を確認する <span aria-hidden="true">→</span></button><p className="quiet">この操作では、まだ投稿されません。</p></div>
          </>}
          {stage === 'analyzing' && <><div className="processing" role="status"><span className="spinner" /><p>分類ができたら、確認画面を表示します。</p><small>入力したメモは残っています。</small></div><div className="actions"><button className="secondary" onClick={backToWrite}>メモに戻る</button></div></>}
          {stage === 'review' && <>
            <fieldset disabled={posting}><legend>分類</legend><div className="segmented sentiment"><button aria-pressed={sentiment === 'good'} onClick={() => setSentiment('good')}><strong>Good</strong><small>よかったこと</small></button><button aria-pressed={sentiment === 'motto'} onClick={() => setSentiment('motto')}><strong>Motto</strong><small>改善してほしいこと</small></button></div></fieldset>
            <label className="field-label">対象 / 人物・場所</label>
            <button ref={targetButton} disabled={posting} className="target-field" onClick={openPicker}>{target ? target.type === 'person' ? <PersonLabel person={target.person} /> : <strong>{target.place.name}</strong> : <span className="placeholder">{analysis?.target_label ? `候補：${analysis.target_label}（未確定）` : '対象を選ぶ'}</span>}<span className="target-action">{target ? '変更' : '選ぶ'}</span></button>
            {!target && <p className="hint">候補から対象を選ぶと、投稿できます。</p>}
            <label className="field-label" htmlFor="review-memo">本文</label><textarea id="review-memo" className="memo review-memo" disabled={posting} value={text} maxLength={MAX_TEXT} onChange={e => setText(e.target.value)} />
            <p className="hint">本文も修正できます。人物向けの内容は週次で集計し、配信条件を満たした場合にSlackで届きます。</p>
            {error && <p className="error-panel" role="alert">{error}</p>}
            <div className="actions"><button className="primary" disabled={!target || !validText || posting} onClick={post}>{posting ? <><span className="spinner small" /> 投稿しています</> : demo ? '投稿を試す' : '投稿する'}</button><button className="secondary" disabled={posting} onClick={backToWrite}>入力に戻る</button></div>
          </>}
          {stage === 'done' && <><div className="done-card"><span className="done-check" aria-hidden="true">✓</span><h2>{demo ? '操作の確認ができました' : `${sentiment === 'good' ? 'Good' : 'Motto'} を記録しました`}</h2><p>{target?.type === 'person' ? '人物向けの通知は週次で行われます。原文をそのまま本人へ転送することはありません。' : '場所ごとの集計に使われます。'}</p>{!demo && <small>投稿ID：{postId}</small>}</div><div className="actions"><button className="primary" onClick={reset}>新しく書く</button></div></>}
        </section>}
      <footer className="app-footer">Good / Motto<span>言葉にするための、小さな余白。</span></footer>
    </main>
  </div>;
}
