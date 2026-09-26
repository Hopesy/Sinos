import type { TerminalStatus } from './claudeChrome';

// Parse only recognized CLI status fields, never arbitrary percentages in chat.
export function contextUsage(status: TerminalStatus) {
  let used = Number.isFinite(status.contextUsed) ? status.contextUsed : undefined;
  const lines = status.lines.map(line => {
    const match = /^(?:上下文(已用|剩余)\s*(\d+(?:\.\d+)?)%|context\s+(\d+(?:\.\d+)?)%\s+left|(\d+(?:\.\d+)?)%\s+context\s+left|(\d+(?:\.\d+)?)%)(?=\s*(?:[|·]|$))/i.exec(line.trim());
    if (!match) return line;
    const value = Number(match[2] ?? match[3] ?? match[4] ?? match[5]);
    if (value > 100) return line;
    if (used === undefined) used = match[1] === '剩余' || match[3] || match[4] ? 100 - value : value;
    return line.trim().slice(match[0].length).replace(/^\s*[|·]\s*/, '').trim();
  }).filter(Boolean);
  return { used: used === undefined ? undefined : Math.round(Math.max(0, Math.min(100, used))), lines };
}
