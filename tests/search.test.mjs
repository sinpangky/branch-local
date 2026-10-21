import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../shared/core.mjs';
import { searchConversations } from '../shared/search.mjs';
test('full-text search includes summaries, every message, inherited context and multiple keywords', () => {
  const ws = createWorkspace(), b = ws.boards[0], n = b.nodes[1];
  n.summary = { title:'缓存一致性',text:'比较 WAL 与事务方案',updatedAt:new Date().toISOString(),model:'mock',fingerprint:'x' };
  assert(searchConversations(ws, '缓存 WAL').some((r) => r.node.id === n.id));
  assert(searchConversations(ws, '为什么').some((r) => r.node.id === n.id));
  n.messages[1].content += '\nUNIQUE_INTERNAL_KEYWORD';
  const matches = searchConversations(ws, 'unique_internal_keyword');
  assert.equal(matches.length, 1); assert(matches[0].excerpt.includes('UNIQUE_INTERNAL_KEYWORD'));
});
test('archive is searchable and trash is excluded unless explicitly requested', () => {
  const ws = createWorkspace(), b=ws.boards[0]; b.nodes[1].status='archived'; b.nodes[2].status='trashed';
  assert(searchConversations(ws,'').some((r)=>r.node.id===b.nodes[1].id));
  assert(!searchConversations(ws,'').some((r)=>r.node.id===b.nodes[2].id));
  assert(searchConversations(ws,'',{includeTrashed:true}).some((r)=>r.node.id===b.nodes[2].id));
  assert(!searchConversations(ws,'',{includeArchived:false}).some((r)=>r.node.id===b.nodes[1].id));
});

test('research search includes status labels, conclusion text, citations and source titles', () => {
  const ws = createWorkspace(), board = ws.boards[0], node = board.nodes[1];
  node.researchStatus = 'verify'; node.kind = 'conclusion';
  node.conclusion = { sourceNodeIds: [board.nodes[0].id], items: [{ text: '量化结果显著改善', category: 'basis', citations: [{ quote: 'NEEDLE_EVIDENCE 原始实验依据' }] }] };
  assert(searchConversations(ws, '待验证 量化结果').some((result) => result.node.id === node.id));
  assert(searchConversations(ws, 'verify basis needle_evidence').some((result) => result.node.id === node.id));
  const matches = searchConversations(ws, 'needle_evidence');
  assert.equal(matches.length, 1); assert(matches[0].excerpt.includes('NEEDLE_EVIDENCE'));
  assert(searchConversations(ws, `结论 ${board.nodes[0].title}`).some((result) => result.node.id === node.id));
  node.status = 'trashed';
  assert.equal(searchConversations(ws, 'needle_evidence').length, 0);
  assert.equal(searchConversations(ws, 'needle_evidence', { includeTrashed: true }).length, 1);
});

test('search previews read structured conclusions and remove Markdown control characters', () => {
  const ws=createWorkspace(),board=ws.boards[0],node=board.nodes[1];
  node.summary=undefined;
  node.kind='conclusion';
  node.messages=[{id:'generated',role:'assistant',content:'### 共同结论\n来源：internal-node-id / internal-message-id\n**采用事务**'}];
  node.conclusion={messageIds:['generated'],sourceNodeIds:[board.nodes[0].id],items:[{text:'**采用事务**，并保留 [验证依据](https://example.com/)。',category:'agreement',citations:[{quote:'真实核对过的引文'}]}]};
  const result=searchConversations(ws,'采用事务').find((entry)=>entry.node.id===node.id);
  assert.equal(result.excerpt,'采用事务，并保留 验证依据。');
  assert(!result.excerpt.includes('internal-node-id'));
  assert(searchConversations(ws,'真实核对').find((entry)=>entry.node.id===node.id).excerpt.includes('真实核对过的引文'));
});
