import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import type { Api, Person, Place, Target, TargetType } from './types';

export function Avatar({ person }: { person: Person }) {
  const [failed, setFailed] = useState(false);
  return <span className="avatar" aria-hidden="true">{person.avatar_url && !failed
    ? <img src={person.avatar_url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : Array.from(person.name)[0]}</span>;
}
export function PersonLabel({ person }: { person: Person }) {
  return <><Avatar person={person} /><span className="person-label"><strong>{person.name}</strong>{person.username ? <small>@{person.username.replace(/^@/, '')}</small> : <small>識別ID：{person.id}</small>}{person.workspace_label && <small>{person.workspace_label}</small>}</span></>;
}

export default function TargetPicker({ api, initialType, onSelect, onCancel }: {
  api: Api; initialType: TargetType; onSelect: (target: Target) => void; onCancel: () => void;
}) {
  const [type, setType] = useState<TargetType>(initialType);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const normalized = query.normalize('NFKC').trim();

  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController(); request.current = controller;
    setPeople([]); setPlaces([]); setActive(-1); setError('');
    if (type === 'person' && (!normalized || composing)) { setStatus('idle'); return () => controller.abort(); }
    setStatus('loading');
    const timer = setTimeout(async () => {
      try {
        const result = type === 'person' ? await api.people(normalized, controller.signal) : await api.places(controller.signal);
        if (controller.signal.aborted || generation.current !== version) return;
        if (type === 'person') setPeople(result as Person[]); else setPlaces(result as Place[]);
        setStatus('ready');
      } catch (e) {
        if (controller.signal.aborted || generation.current !== version) return;
        setError(errorMessage(e)); setStatus('error');
      }
    }, type === 'person' ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, type, normalized, composing, retry]);

  // 入力イベントで直ちに候補を無効化。古い応答が新しい検索語に混ざるのを防ぎます。
  function invalidate() { generation.current++; request.current?.abort(); setPeople([]); setPlaces([]); setActive(-1); setStatus('idle'); }
  const count = type === 'person' ? people.length : places.length;
  function select(index: number) {
    if (status !== 'ready') return;
    if (type === 'person' && people[index]) onSelect({ type, person: people[index] });
    if (type === 'place' && places[index]) onSelect({ type, place: places[index] });
  }
  return <section aria-labelledby="picker-heading" className="picker screen">
    <button className="text-button back" onClick={onCancel}><span aria-hidden="true">←</span> メモに戻る</button>
    <header><p className="eyebrow">対象の選択</p><h1 id="picker-heading" tabIndex={-1}>誰とのこと？</h1><p className="description">候補から選んで、対象を確認します。</p></header>
    <div className="segmented" aria-label="対象の種類">
      <button aria-pressed={type === 'person'} onClick={() => { invalidate(); setType('person'); }}>人物</button>
      <button aria-pressed={type === 'place'} onClick={() => { invalidate(); setType('place'); }}>場所</button>
    </div>
    {type === 'person' ? <>
      <label className="field-label" htmlFor="person-query">Slackの名前で検索</label>
      <div className="search-field"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6"/><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        <input ref={input} id="person-query" role="combobox" aria-autocomplete="list" aria-expanded={status === 'ready' && count > 0} aria-controls="target-results" aria-activedescendant={active >= 0 ? `target-${active}` : undefined} autoComplete="off" placeholder="例：田" value={query}
          onChange={e => { invalidate(); setQuery(e.target.value); }}
          onCompositionStart={() => { invalidate(); setComposing(true); }} onCompositionEnd={e => { invalidate(); setQuery(e.currentTarget.value); setComposing(false); }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || composing) return;
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            if (status !== 'ready' || !count) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(n => (n + 1) % count); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(n => n <= 0 ? count - 1 : n - 1); }
            if (e.key === 'Enter' && active >= 0) { e.preventDefault(); select(active); }
          }} />
        {query && <button className="clear" aria-label="検索語を消す" onClick={() => { invalidate(); setQuery(''); input.current?.focus(); }}>×</button>}
      </div><p className="hint">漢字1文字から検索できます。</p>
    </> : <p className="field-label">場所を選ぶ</p>}
    <div className="search-status" role="status" aria-live="polite">
      {status === 'idle' && (composing ? '文字を確定すると検索します。' : '名前を入力すると候補が表示されます。')}
      {status === 'loading' && <><span className="spinner small" /> 候補を検索しています</>}
      {status === 'ready' && count > 0 && `${count}件の候補`}
      {status === 'ready' && count === 0 && <div className="empty-state"><strong>該当する{type === 'person' ? 'メンバー' : '場所'}がいません</strong><p>{type === 'person' ? '別の漢字やSlackの表示名で検索してください。' : '場所の登録状況を担当者に確認してください。'}</p></div>}
    </div>
    {status === 'error' && <div className="error-panel" role="alert"><strong>候補を取得できませんでした</strong><p>{error}</p><p>入力したメモは残っています。</p><button className="secondary" onClick={() => setRetry(n => n + 1)}>再試行</button></div>}
    <div id="target-results" role="listbox" aria-label={type === 'person' ? 'Slackメンバー候補' : '場所の候補'}>
      {status === 'ready' && (type === 'person' ? people.map((person, i) => <button type="button" role="option" aria-selected={active === i} id={`target-${i}`} key={person.id} className="candidate" onClick={() => select(i)}><PersonLabel person={person} /><span className="candidate-arrow" aria-hidden="true">→</span></button>)
        : places.map((place, i) => <button type="button" role="option" aria-selected={active === i} id={`target-${i}`} key={place.id} className="candidate" onClick={() => select(i)}><span className="avatar" aria-hidden="true">場</span><strong>{place.name}</strong><span className="candidate-arrow" aria-hidden="true">→</span></button>))}
    </div>
    <p className="picker-footer">選んだだけでは投稿されません。</p>
  </section>;
}
