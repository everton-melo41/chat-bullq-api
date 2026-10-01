export interface KnowledgeChunk { content: string; section: string }

/** Preserve Markdown section paths and repeat them across overlapping windows. */
export function chunkKnowledge(content: string): KnowledgeChunk[] {
  const sections: { section: string; lines: string[] }[] = [];
  let current = { section: '', lines: [] as string[] };
  const headings: string[] = [];
  let fence = '';
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) fence = fence ? (marker[1][0] === fence ? '' : fence) : marker[1][0];
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      sections.push(current);
      headings.length = heading[1].length - 1;
      headings.push(heading[2]);
      current = { section: headings.filter(Boolean).join(' > '), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  const chunks: KnowledgeChunk[] = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (!body && !s.section) continue;
    const prefix = s.section ? `${s.section}\n\n` : '';
    if (!body) { chunks.push({ section: s.section, content: prefix.trim() }); continue; }
    for (let start = 0; start < body.length; start += 1050) {
      chunks.push({ section: s.section, content: prefix + body.slice(start, start + 1200) });
      if (start + 1200 >= body.length) break;
    }
  }
  return chunks;
}
