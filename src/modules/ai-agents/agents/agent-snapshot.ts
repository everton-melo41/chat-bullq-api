/** Campos versionados; kind representa o papel (role) do agente. */
export const SNAPSHOT_FIELDS = ["entryQuestion", "name", "description", "avatarUrl", "kind", "category", "capabilities", "parentAgentId", "department", "squad", "modelId", "modelParams", "systemPrompt", "operationalContext", "operationalContextUpdatedAt", "temperature", "maxTokens", "canRespondDirectly", "isActive", "followUpEnabled", "followUpCadenceHours", "enabledBuiltinTools"] as const;
export function agentSnapshot(agent: any, skills: any[] = []) {
  return JSON.parse(JSON.stringify({
    ...Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key, agent[key] ?? null])),
    skills: skills.map(({ skillId, requiresApproval }) => ({ skillId, requiresApproval })),
  }));
}
export function revisionDiff(before: any, after: any) {
  const a = String(before.systemPrompt ?? '').split('\n');
  const b = String(after.systemPrompt ?? '').split('\n');
  // LCS with linear memory, preserving unchanged lines and repeated lines.
  const lines: { type: 'added' | 'removed' | 'context'; text: string }[] = [];
  function diff(x: string[], y: string[]) {
    if (!x.length) { y.forEach(text => lines.push({ type: 'added', text })); return; }
    if (!y.length) { x.forEach(text => lines.push({ type: 'removed', text })); return; }
    if (x.length === 1) {
      const at = y.indexOf(x[0]);
      if (at < 0) { lines.push({ type: 'removed', text: x[0] }); y.forEach(text => lines.push({ type: 'added', text })); }
      else y.forEach((text, i) => lines.push({ type: i === at ? 'context' : 'added', text }));
      return;
    }
    const lengths = (u: string[], v: string[]) => {
      let row = new Array(v.length + 1).fill(0);
      for (const line of u) {
        const next = [0];
        for (let j = 0; j < v.length; j++) next.push(line === v[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]));
        row = next;
      }
      return row;
    };
    const mid = Math.floor(x.length / 2);
    const left = lengths(x.slice(0, mid), y);
    const right = lengths(x.slice(mid).reverse(), [...y].reverse());
    let split = 0;
    for (let j = 1; j <= y.length; j++) if (left[j] + right[y.length-j] > left[split] + right[y.length-split]) split = j;
    diff(x.slice(0, mid), y.slice(0, split)); diff(x.slice(mid), y.slice(split));
  }
  diff(a, b);
  return { lines, fields: [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => key !== 'systemPrompt' && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(field => ({ field, before: before[field], after: after[field] })) };
}
