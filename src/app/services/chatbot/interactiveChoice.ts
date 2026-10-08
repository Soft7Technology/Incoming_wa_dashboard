type GraphIndex = {
  nodes: Map<string, any>;
  outgoing: Map<string, any[]>;
  replies: Map<string, any[]>;
};

const indexes = new WeakMap<object, GraphIndex>();
const normalize = (value: unknown) => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
const handles = (edge: any): string[] => [...new Set<string>([
  edge.sourceHandle, edge.data?.sourceHandle, edge.data?.buttonId, edge.data?.button_id,
].filter(value => typeof value === 'string' && value.length > 0))];

function options(node: any): Array<{ id: string; title: string }> {
  const action = node?.data?.attributes?.message?.interactive?.action;
  const buttons = node?.data?.attributes ? action?.buttons || [] : node?.data?.buttons || [];
  return [
    ...buttons.map((button: any, index: number) => ({
      id: button?.reply?.id || button?.id || `btn_${index}`,
      title: button?.reply?.title ?? button?.title ?? (typeof button === 'string' ? button : ''),
    })),
    ...(action?.sections || []).flatMap((section: any) => section.rows || []),
  ];
}

function indexGraph(bot: any): GraphIndex {
  const cached = indexes.get(bot);
  if (cached) return cached;
  const nodes = new Map<string, any>((bot.nodes || []).map((node: any) => [node.id, node]));
  const declared = new Map([...nodes].map(([id, node]) => [id, new Set(options(node).map(option => option.id))]));
  const outgoing = new Map<string, any[]>();
  const replies = new Map<string, any[]>();
  for (const edge of bot.edges || []) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source)!.push(edge);
    for (const id of handles(edge)) {
      // Older-message navigation requires a real button/list option on its source.
      if (!declared.get(edge.source)?.has(id)) continue;
      if (!replies.has(id)) replies.set(id, []);
      replies.get(id)!.push(edge);
    }
  }
  const index = { nodes, outgoing, replies };
  indexes.set(bot, index);
  return index;
}

/** Resolve choices only inside the active bot. An opaque reply ID outranks its title. */
export function resolveInteractiveEdge(bot: any, currentNodeId: string, incomingId?: string | null, text?: string) {
  if (!bot || !currentNodeId) return undefined;
  const index = indexGraph(bot);
  const current = index.nodes.get(currentNodeId);
  if (!current) return undefined;
  const edges = index.outgoing.get(currentNodeId) || [];
  const unique = (matches: any[]) => matches.length === 1 ? matches[0] : undefined;
  if (incomingId) {
    const local = edges.filter(edge => handles(edge).includes(incomingId));
    if (local.length) return unique(local);
    // Ambiguous reused IDs must not jump to an arbitrary node.
    return unique(index.replies.get(incomingId) || []);
  }
  const title = normalize(text);
  if (!title || (!options(current).length &&
      !['@whatsapp/send-button-message', '@whatsapp/send-list-message'].includes(current.data?.key))) return undefined;
  const ids = new Set(options(current).filter(option => normalize(option.title) === title).map(option => option.id));
  return unique(edges.filter(edge => normalize(edge.label) === title || handles(edge).some(id => ids.has(id))));
}
