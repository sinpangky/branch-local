import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, FileText, GitCompareArrows, LoaderCircle, Pencil, Search, ShieldCheck, X } from 'lucide-react';
import { buildRequestContext, getContextEntries, getConfirmedConclusions, RESEARCH_STATUSES, CONCLUSION_CATEGORIES } from '../../shared/research.mjs';
import { comparisonFingerprint } from '../../shared/comparison.mjs';
import MessageContent from './MessageContent.jsx';
import './research-tools.css';

export const categoryName = (category) => CONCLUSION_CATEGORIES.find((item)=>item.value===category)?.label || '结论';
export const displayDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '未记录';
const titleOf = (node) => node?.summary?.title || node?.title || '来源已删除';
const sameRef = (a,b) => a.kind===b.kind && (a.kind==='message' ? a.id===b.id : a.index===b.index);

export function ResearchStatus({ value='exploring', onChange, disabled=false }) {
  return <label className={`research-status status-${value}`}><span className="status-dot"/><select aria-label="研究状态" value={value} disabled={disabled} onChange={(event)=>onChange(event.target.value)}>
    {RESEARCH_STATUSES.map((status)=><option key={status.value} value={status.value}>{status.label}</option>)}
  </select></label>;
}

export function EvidenceLinks({ citations=[], board, onJump }) {
  const [preview,setPreview] = useState(null);
  const citation=citations[preview], source=citation&&board.nodes.find((node)=>node.id===citation.nodeId);
  const message=citation&&(citation.messageId ? source?.messages.find((message)=>message.id===citation.messageId) : source?.source?.context?.[citation.contextIndex]);
  return <div className="evidence-links">
    <div className="evidence-link-list">{citations.map((citation,index)=>{
      const source=board.nodes.find((node)=>node.id===citation.nodeId);
      return <button type="button" key={`${citation.nodeId}:${citation.messageId??citation.contextIndex}:${index}`} className="evidence-link" title={citation.quote} aria-expanded={preview===index} onClick={()=>setPreview(preview===index?null:index)}><FileText size={14}/><span className="evidence-source-title">{titleOf(source)} · {citation.messageId?'消息':'继承历史'}</span><span>依据 {index+1}</span><ChevronRight size={13}/></button>;
    })}</div>
    {citation&&<section className="evidence-preview" aria-label={`依据 ${preview+1} 的原文`}>
      <header><h4><FileText size={15}/>依据 {preview+1} · 保存的引文</h4><button type="button" aria-label="关闭证据预览" onClick={()=>setPreview(null)}><X size={16}/></button></header>
      <blockquote>{citation.quote}</blockquote><details><summary>查看当前原文</summary>{message ? <MessageContent text={message.content}/> : <p>原消息已不存在，仍保留生成结论时的引文。</p>}</details><button type="button" disabled={!onJump} onClick={()=>onJump?.(citation)}><ArrowUpRight size={14}/>打开来源位置</button>
    </section>}
    {!citations.length && <small className="evidence-missing">尚无可定位的原文依据，请自行核实。</small>}
  </div>;
}

export function ComparisonWorkbench({ board, workspace, session, onChange, onSave, onJump, onRequest, onCancel }) {
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [editing,setEditing] = useState(null);
  const workbench=useRef(null);
  const controller=useRef(null), live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;controller.current?.abort();onRequest?.(null);};},[]);
  const selected=session.selection || [], result=session.result;
  let stale=false;
  if(result){try{stale=comparisonFingerprint(board,result.sourceNodeIds)!==result.fingerprint;}catch{stale=true;}}
  const changeItem=(id,patch)=>onChange({...session,items:session.items.map((item)=>item.id===id?{...item,...patch}:item)});
  const generate=async()=>{
    controller.current=new AbortController();onRequest?.(controller.current);setBusy(true);setError('');
    const ids=[...selected];
    try {
      const response=await fetch('/api/compare',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.current.signal,
        body:JSON.stringify({workspace:{...workspace,activeBoardId:board.id,boards:[structuredClone(board)]},boardId:board.id,nodeIds:ids})});
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error || '比较生成失败');
      if(!live.current || controller.current.signal.aborted)return;
      const comparison=payload.comparison;
      if(!comparison || !Array.isArray(comparison.items) || !comparison.items.length)throw new Error('模型没有返回有效比较，请重试。');
      onChange({...session,selection:ids,result:comparison,title:comparison.title,
        items:comparison.items.map((item)=>({...item,included:true,verified:false,adopted:false}))});
    }catch(failure){if(live.current)setError(failure.name==='AbortError'?'比较已停止，可以重新生成。':failure.message);}
    finally{if(live.current){setBusy(false);onRequest?.(null);}}
  };
  const retained=session.items.filter((item)=>item.included&&item.text.trim());
  const reviewed=retained.filter((item)=>item.verified||item.adopted).length;
  const jumpCategory=(category)=>{
    const section=workbench.current?.querySelector(`[data-comparison-category="${category}"]`);
    if(section){section.open=true;section.scrollIntoView?.({block:'start',behavior:'auto'});section.querySelector('summary')?.focus();}
  };
  return <div className="comparison-workbench" ref={workbench}>
    <p className="research-description">比较所选会话的完整历史，并核对可追溯的原文。生成会使用当前模型；结论草稿可修改，确认状态由你决定。</p>
    <ol className="research-steps" aria-label="比较流程"><li data-current={!result}><span>1</span>选择会话</li><li data-current={!!result}><span>2</span>核对与编辑</li><li><span>3</span>保存结论卡</li></ol>
    <div className="comparison-layout"><aside className="comparison-navigation" aria-label="比较导航">
    <div className="research-pane-title"><h3>比较来源</h3><span>{selected.length} 已选</span></div>
    <div className="comparison-selection" aria-label="选择比较分支">{board.nodes.filter((node)=>node.status==='active'&&node.kind!=='conclusion').map((node)=><label key={node.id}>
      <input type="checkbox" aria-label={`比较分支：${node.title}`} checked={selected.includes(node.id)} disabled={busy} onChange={(event)=>onChange({...session,selection:event.target.checked?[...selected,node.id]:selected.filter((id)=>id!==node.id)})}/>
      <span><strong>{titleOf(node)}</strong><small>{node.summary?.text || `${node.messages.length} 条消息 · ${node.parentId?'分支':'主干'}`}</small></span>
    </label>)}</div>
    <div className="comparison-actions"><span>{selected.length} 段对话 · 完整历史</span>{busy?<button className="button secondary" onClick={()=>controller.current?.abort()}><X size={14}/>停止比较</button>:<button className="button primary" disabled={selected.length<2} onClick={generate}><GitCompareArrows size={15}/>{result?'重新比较所选分支':'生成比较'}</button>}</div>
    {result&&<nav className="comparison-group-nav" aria-label="比较结果分组"><h3>审阅分组</h3>{CONCLUSION_CATEGORIES.map((category)=>{
      const count=session.items.filter((item)=>item.category===category.value).length;
      return count?<button type="button" key={category.value} onClick={()=>jumpCategory(category.value)}><span>{category.label}</span><small>{count}</small></button>:null;
    })}<p>{retained.length} 项保留 · {reviewed} 项已确认</p></nav>}
    </aside><div className="comparison-reading">
    {busy && <p className="research-feedback" role="status"><LoaderCircle className="spin" size={15}/>正在比较完整内容，长会话会分段处理…</p>}
    {error && <p className="research-error" role="alert">{error}</p>}
    {!result&&<div className="comparison-empty"><GitCompareArrows size={30}/><h3>并排思考，逐项核对</h3><p>选择至少两段会话后生成比较。这里会按共识、差异与未决问题分组，每一项都能回看原文。</p></div>}
    {result && <section className="comparison-results" aria-label="比较结果">
      <div className="comparison-result-meta"><span>{result.model} · {displayDate(result.createdAt)}</span><span>{result.model?.includes('演示')?'静态演示，未调用模型':'AI 草稿，待人工核对'}</span></div>
      {stale && <p className="research-error" role="alert">来源会话已变化，请重新比较后再保存，避免采用过时结论。</p>}
      <label className="conclusion-title-input">结论卡标题<input aria-label="结论卡标题" maxLength={160} value={session.title || ''} onChange={(event)=>onChange({...session,title:event.target.value})}/></label>
      {CONCLUSION_CATEGORIES.map((category)=>{
        const items=session.items.filter((item)=>item.category===category.value);
        return items.length?<details className="comparison-category" data-comparison-category={category.value} key={category.value} open><summary><h3>{category.label}<small>{items.length}</small></h3></summary>{items.map((item)=><article className={`comparison-item ${item.included?'':'excluded'}`} key={item.id}>
          <div className="comparison-item-heading"><label className="include-conclusion"><input type="checkbox" aria-label={`保留条目：${item.id}`} checked={item.included} onChange={(event)=>changeItem(item.id,{included:event.target.checked})}/>保留此条</label>
          <button className="comparison-edit" type="button" aria-label={`编辑条目：${item.id}`} aria-pressed={editing===item.id} onClick={()=>setEditing(editing===item.id?null:item.id)}>{editing===item.id?<Check size={14}/>:<Pencil size={14}/>} {editing===item.id?'完成编辑':'编辑条目'}</button></div>
          {editing===item.id?<textarea autoFocus aria-label={`修改比较条目：${item.id}`} value={item.text} maxLength={10000} rows={4} onBlur={()=>setEditing(null)} onChange={(event)=>changeItem(item.id,{text:event.target.value,verified:false,adopted:false})}/>:<div className="comparison-item-content"><MessageContent text={item.text}/></div>}
          <EvidenceLinks citations={item.citations} board={board} onJump={onJump}/>
          <div className="conclusion-confirmations"><label><input type="checkbox" checked={item.verified} onChange={(event)=>changeItem(item.id,{verified:event.target.checked})}/>我已验证</label><label><input type="checkbox" checked={item.adopted} onChange={(event)=>changeItem(item.id,{adopted:event.target.checked})}/>我决定采用</label></div>
        </article>)}</details>:null;
      })}
    </section>}
    </div></div>
    <footer className="comparison-save"><p>{result?`${retained.length} 项保留 · ${reviewed} 项已验证或采用`:'选择会话后开始比较'}<small>保存为独立结论卡；未确认的条目仍会保留为草稿。</small></p><div>{onCancel&&<button type="button" className="button secondary" onClick={onCancel}>取消</button>}{result&&<button className="button primary" disabled={busy||stale||!session.title?.trim()||!retained.length} onClick={()=>onSave({...result,title:session.title,items:retained})}><Check size={15}/>确认并保存结论卡</button>}</div></footer>
  </div>;
}

export function ContextPicker({ board,node,systemPrompt='',onSave,onCancel }) {
  const [policy,setPolicy]=useState(()=>structuredClone(node.contextPolicy || {mode:'full',refs:[],conclusionIds:[]}));
  const [filter,setFilter]=useState(''),[preview,setPreview]=useState(false),[shown,setShown]=useState(40);
  const entries=getContextEntries(board,node.id), confirmed=getConfirmedConclusions(board,node.id);
  const cards=[...new Set(confirmed.map((item)=>item.nodeId))].map((id)=>({id,title:titleOf(board.nodes.find((node)=>node.id===id)),count:confirmed.filter((item)=>item.nodeId===id).length}));
  const filtered=entries.filter((entry)=>`${entry.label}\n${entry.content}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const missing=policy.mode==='selected'?policy.refs.filter((ref)=>!entries.some((entry)=>sameRef(ref,entry.ref))).length:policy.mode==='conclusions'?(policy.conclusionIds||[]).filter((id)=>!cards.some((card)=>card.id===id)).length:0;
  let messages=[],previewError='';
  try {
    const next={...node,contextPolicy:policy,messages:[...node.messages,...(node.draft.trim()?[{id:'preview-current-question',role:'user',content:node.draft.trim()}]:[])]};
    messages=buildRequestContext({...board,nodes:board.nodes.map((item)=>item.id===node.id?next:item)},node.id,{...(node.draft.trim()?{currentMessageId:'preview-current-question'}:{})});
    if(!node.draft.trim()&&policy.mode==='selected')messages=entries.filter((entry)=>policy.refs.some((ref)=>sameRef(ref,entry.ref))).map(({role,content})=>({role,content}));
    if(systemPrompt)messages.unshift({role:'system',content:systemPrompt});
  }catch(error){previewError=error.message;}
  return <div className="context-picker"><p className="research-description">只影响下一次回答。完整历史保留在本地；切换策略会改变请求前缀，可能降低缓存复用。比较分支仍会读取所选会话的完整历史。</p>
    <div className="context-modes">{[['full','完整历史','继承快照 + 本会话，保留原前缀'],['conclusions','关键结论','所选已确认结论 + 本会话消息'],['selected','指定消息','仅所选历史 + 当前新问题']].map(([mode,title,description])=><label key={mode}><input type="radio" name="contextMode" value={mode} checked={policy.mode===mode} onChange={()=>setPolicy({...policy,mode})}/><span><strong>{title}</strong><small>{description}</small></span></label>)}</div>
    <div className="context-workspace"><section className="context-selection-pane" aria-label="上下文选择"><div className="research-pane-title"><h3>{policy.mode==='selected'?'选择历史消息':policy.mode==='conclusions'?'选择已确认结论':'完整会话历史'}</h3><span>{policy.mode==='selected'?`${policy.refs.length} / ${entries.length}`:policy.mode==='conclusions'?`${(policy.conclusionIds||[]).length} 张卡片`:`${entries.length} 条历史`}</span></div>
    {policy.mode==='full'&&<div className="context-full-summary"><FileText size={24}/><h4>保留完整的对话前缀</h4><p>继承快照和本会话消息会按原顺序进入请求，当前新问题追加在末尾。</p><small>可在右侧预览实际发送内容。</small></div>}
    {policy.mode==='conclusions' && <div className="context-options"><p>仅包含你勾选的卡片中“已验证 / 已采用”的条目。</p>{cards.length?cards.map((card)=><label key={card.id}><input type="checkbox" checked={(policy.conclusionIds||[]).includes(card.id)} onChange={(event)=>setPolicy({...policy,conclusionIds:event.target.checked?[...(policy.conclusionIds||[]),card.id]:(policy.conclusionIds||[]).filter((id)=>id!==card.id)})}/><span>{card.title}<small>{card.count} 项已确认</small></span></label>):<p className="research-empty">还没有人工确认的结论。先保存结论卡并勾选验证或采用。</p>}</div>}
    {policy.mode==='selected' && <div className="context-options"><label className="context-filter"><Search size={16}/><input aria-label="筛选上下文消息" value={filter} placeholder="搜索历史消息" onChange={(event)=>{setFilter(event.target.value);setShown(40);}}/></label>
      <div className="context-select-tools"><button onClick={()=>setPolicy({...policy,refs:entries.map((entry)=>entry.ref)})}>全选历史</button><button onClick={()=>setPolicy({...policy,refs:[]})}>清空选择</button><span>已选 {policy.refs.length} / {entries.length}</span></div>
      <div className="context-entry-list">{filtered.slice(0,shown).map((entry)=><label key={JSON.stringify(entry.ref)}><input type="checkbox" checked={policy.refs.some((ref)=>sameRef(ref,entry.ref))} onChange={(event)=>setPolicy({...policy,refs:event.target.checked?[...policy.refs,entry.ref]:policy.refs.filter((ref)=>!sameRef(ref,entry.ref))})}/><span><strong>{entry.label}</strong><small>{entry.content.slice(0,260)}{entry.content.length>260?'…':''}</small></span></label>)}</div>{filtered.length>shown&&<button className="button secondary" onClick={()=>setShown(shown+40)}>再显示 40 条</button>}
    </div>}
    {missing>0&&<p className="research-error">原选择中有 {missing} 项已不存在或没有有效确认内容，不会加入请求，请检查选择。</p>}
    </section><section className="context-preview-pane" aria-label="请求内容核对"><div className="research-pane-title"><h3>实际请求</h3><span role="status">{messages.length} 条消息</span></div>
    <div className="context-preview-heading"><button className="button secondary" onClick={()=>setPreview(!preview)}>{preview?'收起请求预览':'预览实际请求内容'}</button><span>{messages.length} 条 · {messages.reduce((sum,message)=>sum+message.content.length,0).toLocaleString()} 字符（非 token 估计）</span></div>
    {!node.draft.trim()&&<p className="research-description">当前没有草稿；发送时会自动加入新问题。模型参数以当前设置为准。</p>}
    {previewError&&<p role="alert" className="research-error">{previewError}</p>}
    {preview&&<div className="request-preview" aria-label="实际请求预览">{messages.map((message,index)=><details key={index}><summary>{index+1}. {message.role} · {message.content.length} 字符</summary><pre>{message.content}</pre></details>)}{!messages.length&&<p>尚未选择历史，下一条新问题仍会加入。</p>}</div>}
    {!preview&&<div className="context-preview-placeholder"><FileText size={24}/><p>展开预览，逐条核对消息角色、内容与顺序。</p><small>此预览在本地生成，不会调用模型。</small></div>}
    </section></div>
    <div className="dialog-actions context-save-actions"><span>仅应用于下一次回答的请求</span>{onCancel&&<button type="button" className="button secondary" onClick={onCancel}>取消</button>}<button className="button primary" disabled={!!previewError} onClick={()=>onSave(policy)}><Check size={15}/>使用此上下文</button></div>
  </div>;
}

export function conclusionMarkdown(node, board) {
  return `# ${node.title}\n\n`+(node.conclusion?.items || []).map((item)=>`## ${categoryName(item.category)}${item.adopted?' · 已采用':''}${item.verified?' · 已验证':''}\n\n${item.text}`+item.citations.map((citation)=>`\n\n> ${citation.quote}\n\n来源：${titleOf(board.nodes.find((source)=>source.id===citation.nodeId))}（${citation.nodeId}${citation.messageId?` / ${citation.messageId}`:citation.contextIndex!==undefined?` / 继承历史 ${citation.contextIndex+1}`:''}）`).join('')).join('\n\n')+'\n';
}

function ConclusionEditor({item,onChange,disabled}) {
  const [text,setText]=useState(item.text),[editing,setEditing]=useState(false);
  const editor=useRef(null);
  useEffect(()=>setText(item.text),[item.text]);
  useEffect(()=>{if(disabled){setText(item.text);setEditing(false);}},[disabled]);
  useEffect(()=>{if(editing){editor.current?.focus();editor.current?.setSelectionRange(text.length,text.length);}},[editing]);
  const commit=()=>{if(!disabled&&text.trim()&&text!==item.text)onChange(item.id,{text,verified:false,adopted:false});else if(!text.trim()||disabled)setText(item.text);setEditing(false);};
  const cancel=()=>{setText(item.text);setEditing(false);};
  return <div className="conclusion-content-editor">{editing?<><textarea ref={editor} aria-label={`结论内容：${item.id}`} value={text} rows={4} maxLength={10000} disabled={disabled}
    onChange={(event)=>setText(event.target.value)} onBlur={commit} onKeyDown={(event)=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();commit();}}}/><div className="conclusion-editor-actions"><small>离开编辑框会自动保存</small><button type="button" onMouseDown={(event)=>event.preventDefault()} onClick={cancel}>取消编辑</button><button type="button" onMouseDown={(event)=>event.preventDefault()} onClick={commit}><Check size={14}/>保存修改</button></div></>:<><MessageContent text={item.text}/>{!disabled&&<button type="button" className="conclusion-edit" aria-label={`编辑结论：${item.id}`} onClick={()=>setEditing(true)}><Pencil size={14}/>编辑结论</button>}</>}</div>;
}

export function ConclusionView({ node,board,onChangeItem,onJump,onExport,readOnly }) {
  let outdated=false;
  try{outdated=!node.conclusion?.fingerprint||comparisonFingerprint(board,node.conclusion.sourceNodeIds)!==node.conclusion.fingerprint;}catch{outdated=true;}
  return <section className="conclusion-view" aria-label="结论卡内容"><div className="conclusion-view-heading"><ShieldCheck size={17}/><strong>可追溯结论</strong><button onClick={onExport}>导出 Markdown</button></div>
    <p className="research-description">由 {node.conclusion?.model || '手动整理'} 生成于 {displayDate(node.conclusion?.createdAt)}。验证与采用状态由你确认；修改文本会清除该条原有确认。</p>
    {outdated&&<p className="research-error" role="status">来源讨论已变化或无法核对，请重新检查结论是否仍然适用。保存时的原文引句与人工确认状态仍保留。</p>}
    {node.conclusion?.items.map((item)=><article className="saved-conclusion-item" key={item.id}><div className="saved-conclusion-category">{categoryName(item.category)}{item.adopted&&<span>已采用</span>}{item.verified&&<span>已验证</span>}</div>
      <ConclusionEditor item={item} onChange={onChangeItem} disabled={readOnly}/>
      <EvidenceLinks citations={item.citations} board={board} onJump={onJump}/><div className="conclusion-confirmations"><label><input type="checkbox" checked={item.verified} disabled={readOnly} onChange={(event)=>onChangeItem(item.id,{verified:event.target.checked})}/>我已验证</label><label><input type="checkbox" checked={item.adopted} disabled={readOnly} onChange={(event)=>onChangeItem(item.id,{adopted:event.target.checked})}/>我决定采用</label></div>
    </article>)}
    <div className="conclusion-source-list"><strong>比较来源</strong>{node.conclusion?.sourceNodeIds.map((id)=>{const source=board.nodes.find((entry)=>entry.id===id);return <span key={id}>{titleOf(source)}</span>;})}</div>
  </section>;
}

export function getResearchProgress(board,lastVisit) {
  const nodes=board.nodes.filter((node)=>node.status==='active');
  const latest=nodes.find((node)=>node.id===lastVisit?.nodeId) || [...nodes].filter((node)=>node.messages.length).sort((a,b)=>(b.messages.at(-1)?.createdAt||'').localeCompare(a.messages.at(-1)?.createdAt||''))[0];
  const confirmed=nodes.flatMap((node)=>(node.conclusion?.items||[]).filter((item)=>item.verified||item.adopted).map((item)=>({node,item})));
  const open=nodes.flatMap((node)=>(node.conclusion?.items||[]).filter((item)=>item.category==='open'&&!item.adopted).map((item)=>({node,item})));
  return {nodes,latest,confirmed,open,lastActivity:latest&&lastVisit&&latest.id===lastVisit.nodeId?lastVisit.at:latest?.messages.at(-1)?.createdAt,waiting:nodes.filter((node)=>node.researchStatus==='verify')};
}

export function ResearchResume({ board,onNavigate,onCompare,onDemo,lastVisit }) {
  const [limit,setLimit]=useState(12);
  const progress=getResearchProgress(board,lastVisit);
  return <div className="research-resume"><p className="research-description">这些进展来自本地消息、人工状态与已保存结论，不额外调用模型。</p><div className="resume-latest"><small>上次研究到</small>{progress.latest?<button onClick={()=>onNavigate(progress.latest)}><strong>{titleOf(progress.latest)}</strong><span>{displayDate(progress.lastActivity)}<ArrowUpRight size={14}/></span></button>:<p>还没有对话。新建一个问题开始探索。</p>}</div>
    <section><h3>已经确定了什么 <small>{progress.confirmed.length}</small></h3>{progress.confirmed.length?progress.confirmed.slice(0,limit).map(({node,item})=><button className="resume-item" key={`${node.id}:${item.id}`} onClick={()=>onNavigate(node)}><span>{item.adopted?'已采用':'已验证'}</span><strong>{item.text}</strong><ArrowUpRight size={13}/></button>):<p className="research-empty">还没有人工确认的结论。可以比较分支，核对依据后保存。</p>}</section>
    <section><h3>还有什么没解决 <small>{progress.open.length+progress.waiting.length}</small></h3>{progress.open.slice(0,limit).map(({node,item})=><button className="resume-item" key={`${node.id}:${item.id}`} onClick={()=>onNavigate(node)}><span>未决问题</span><strong>{item.text}</strong><ArrowUpRight size={13}/></button>)}{progress.waiting.slice(0,limit).map((node)=><button className="resume-item" key={node.id} onClick={()=>onNavigate(node)}><span>待验证</span><strong>{titleOf(node)}</strong><ArrowUpRight size={13}/></button>)}{!progress.open.length&&!progress.waiting.length&&<p className="research-empty">尚未记录未决问题；这不代表所有问题都已解决。</p>}</section>
    {Math.max(progress.confirmed.length,progress.open.length,progress.waiting.length)>limit&&<button className="button secondary" onClick={()=>setLimit(limit+12)}>显示更多进展</button>}<div className="resume-actions"><button className="button primary" disabled={progress.nodes.filter((node)=>node.kind!=='conclusion').length<2} onClick={onCompare}><GitCompareArrows size={15}/>比较分支，整理结论</button><button className="button secondary" onClick={onDemo}>离线体验完整流程</button></div>
  </div>;
}
