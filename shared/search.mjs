export function searchConversations(workspace, query, { includeArchived = true, includeTrashed = false } = {}) {
  const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
  const results = [];
  for (const board of workspace.boards) for (const node of board.nodes) {
    const trashed = board.status === 'trashed' || node.status === 'trashed';
    const archived = board.status === 'archived' || node.status === 'archived';
    if ((trashed && !includeTrashed) || (archived && !includeArchived)) continue;
    const researchLabels = { exploring: '探索中', verify: '待验证', adopted: '已采纳', parked: '暂缓' };
    const categoryLabels = { agreement: '共同结论', difference: '分歧', basis: '依据', open: '未决问题', conclusion: '结论' };
    const headline = `${board.title}\n${node.title}\n${node.summary?.title || ''}\n${node.summary?.text || ''}\n${node.researchStatus || 'exploring'} ${researchLabels[node.researchStatus || 'exploring']}\n${node.kind === 'conclusion' ? 'conclusion 结论' : ''}`;
    // Generated conclusion messages contain internal provenance IDs. Search the
    // structured conclusions instead so previews stay useful to the reader.
    const generated = new Set(node.conclusion?.messageIds || []);
    const records = [node.summary?.text, ...(node.conclusion?.items || []).map((item)=>item.text), node.source?.quote, ...node.messages.filter((m)=>!generated.has(m.id)).map((m) => m.content), ...(node.source?.context || []).map((m) => m.content),
      ...(node.conclusion?.items || []).flatMap((item) => [item.text, `${item.category} ${categoryLabels[item.category] || ''}`, ...item.citations.map((citation) => citation.quote)]),
      ...(node.conclusion?.sourceNodeIds || []).map((id) => board.nodes.find((entry) => entry.id === id)?.title),
    ].filter(Boolean);
    const all = `${headline}\n${records.join('\n')}`.toLocaleLowerCase();
    if (!terms.every((term) => all.includes(term))) continue;
    const rawMatch = records.find((text) => terms.some((term) => text.toLocaleLowerCase().includes(term))) || records[0] || '';
    const match = rawMatch.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/^ {0,3}(?:#{1,6}\s+|>\s?)/gm,'').replace(/[*`]/g,'');
    const position = Math.max(0, Math.min(...terms.map((term) => match.toLocaleLowerCase().indexOf(term)).filter((index) => index >= 0)) - 45);
    const start = Number.isFinite(position) ? position : 0;
    results.push({ board, node, archived, trashed, excerpt: `${start ? '…' : ''}${match.slice(start, start + 160).replace(/\s+/g, ' ')}${match.length > start + 160 ? '…' : ''}`, score: terms.filter((term) => headline.toLocaleLowerCase().includes(term)).length });
  }
  return results.sort((a, b) => b.score - a.score || b.board.updatedAt.localeCompare(a.board.updatedAt));
}
