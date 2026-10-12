import React, { useEffect, useState } from 'react';
import { Compass, Plus, Search } from 'lucide-react';
import { directionGroups, directionLimit, matchingMembers, prepareDirectionSave, sortMembers, type DirectionDirectory, type DirectionDraft, type MemberDirections } from '../shared/directions';

export function DirectionsBoard({ username, connected, connect }: { username: string; connected: boolean; connect: () => void }) {
  const [members, setMembers] = useState<MemberDirections[]>([]);
  const [drafts, setDrafts] = useState<DirectionDraft[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'topic' | 'member'>('topic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const load = async (keepDraft: boolean) => {
    setBusy(true); setError('');
    try {
      const directory = await window.workbench.call<DirectionDirectory>('directions.list');
      setMembers(directory.members);
      if (!keepDraft) setDrafts((directory.members.find(item => item.username === username)?.directions || []).map(({ id, title, summary }) => ({ id, title, summary })));
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (connected) void load(false); }, [connected, username]);
  const edit = (next: DirectionDraft[]) => { setDirty(true); setNotice(''); setDrafts(next); };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const directions = prepareDirectionSave(drafts);
      await window.workbench.call('directions.save', { directions });
      setDirty(false); setNotice('已保存，队友现在可以按这些方向找到你。');
      await load(false);
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const listed = sortMembers(members, username);
  const groups = directionGroups(listed, query);
  const people = sortMembers(matchingMembers(listed, query), username);
  const directionCount = members.reduce((count, member) => count + member.directions.length, 0);
  const blank = drafts.some(item => !item.title.trim());
  return <div className="workspace-page directions-page">
    <div className="page-title"><div><span className="eyebrow">TEAM DIRECTIONS</span><h1>工作方向</h1></div></div>
    <p className="directions-intro">登记自己正在做的方向，并查看团队里其他人的方向。用来找可以一起做的人，或找有经验的人请教。每人可以有多条，只能改自己的。</p>
    {!connected ? <div className="page-empty"><Compass size={32}/><h2>连接后查看团队方向</h2><p>工作方向保存在团队服务器上，连接账号后才能查看和编辑。</p><button className="primary" onClick={connect}>连接团队账号</button></div> : <div className="directions-layout">
      <section className="direction-editor" aria-label="我的工作方向">
        <header><b>我的方向</b><span>{drafts.length}/{directionLimit}</span></header>
        <p>写清你在做什么、别人可以怎么跟你合作或请教。同一名称不要重复登记。</p>
        {drafts.map(item => <div className="direction-draft" key={item.id}>
          <label>方向名称<input aria-label="方向名称" maxLength={40} value={item.title} disabled={busy} onChange={event => edit(drafts.map(current => current.id === item.id ? { ...current, title: event.target.value } : current))}/></label>
          <label>说明<textarea aria-label="方向说明" rows={3} maxLength={160} value={item.summary} disabled={busy} placeholder="例如：在做召回实验，欢迎一起看评测集，也可以问我之前的失败经验。" onChange={event => edit(drafts.map(current => current.id === item.id ? { ...current, summary: event.target.value } : current))}/></label>
          <button className="text-button" type="button" disabled={busy} onClick={() => edit(drafts.filter(current => current.id !== item.id))}>移除此方向</button>
        </div>)}
        {!drafts.length && <p className="muted small">你还没有登记。先添加一条，队友才知道可以找你。</p>}
        <div className="row">
          <button className="secondary" type="button" disabled={busy || drafts.length >= directionLimit} onClick={() => edit([...drafts, { id: crypto.randomUUID(), title: '', summary: '' }])}><Plus size={14}/>添加方向</button>
          <button className="primary" type="button" disabled={busy || blank || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存我的方向'}</button>
        </div>
        {drafts.length >= directionLimit && <p className="muted small">已到 {directionLimit} 条上限。方向变多时，先合并相近的，再添加新的。</p>}
        {notice && <p className="muted small" role="status">{notice}</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </section>
      <section className="direction-directory" aria-label="团队工作方向">
        <div className="direction-directory-bar">
          <label className="search"><Search size={14}/><input aria-label="搜索工作方向或成员" placeholder="搜索方向、说明或成员" value={query} onChange={event => setQuery(event.target.value)}/></label>
          <div className="direction-mode" role="group" aria-label="浏览方式">
            <button type="button" aria-pressed={mode === 'topic'} className={mode === 'topic' ? 'selected' : ''} onClick={() => setMode('topic')}>按方向</button>
            <button type="button" aria-pressed={mode === 'member'} className={mode === 'member' ? 'selected' : ''} onClick={() => setMode('member')}>按成员</button>
          </div>
          <button className="text-button" type="button" disabled={busy} onClick={() => void load(dirty)}>刷新</button>
        </div>
        <p className="muted small">{members.length} 人 · {directionCount} 条方向{query.trim() ? ` · 当前显示 ${mode === 'topic' ? groups.length + ' 个方向' : people.length + ' 人'}` : ''}</p>
        {mode === 'topic' ? <div className="direction-groups">{groups.map(group => <article key={group.title.toLocaleLowerCase()} className="direction-group">
          <header><b>{group.title}</b><span>{group.people.length} 人</span></header>
          <ul>{group.people.map(person => <li key={person.username}><b>{person.username}{person.username === username ? ' · 我' : ''}</b>{person.summary && <span>{person.summary}</span>}</li>)}</ul>
        </article>)}{!groups.length && <div className="page-empty compact"><Compass size={28}/><h2>{query.trim() ? '没有匹配的方向' : '还没有人登记方向'}</h2><p>{query.trim() ? '换个关键词，或改用按成员查看谁还没登记。' : '先在左侧写下你正在做的方向。'}</p></div>}</div> : <div className="direction-members">{people.map(member => <article key={member.username} className="direction-member">
          <header><b>{member.username}{member.username === username ? ' · 我' : ''}</b><span>{member.directions.length ? `${member.directions.length} 条` : '还没有登记'}</span></header>
          {member.directions.length ? <ul>{member.directions.map(item => <li key={item.id}><b>{item.title}</b>{item.summary && <span>{item.summary}</span>}</li>)}</ul> : <p className="muted small">这位成员还没有填写工作方向。</p>}
        </article>)}{!people.length && <div className="page-empty compact"><Search size={28}/><h2>没有匹配的成员</h2><p>换个姓名、方向或说明里的词再搜。</p></div>}</div>}
      </section>
    </div>}
  </div>;
}
