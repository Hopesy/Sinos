import type { ToolType } from '../store/app-state';

const CHAT_TOOLS = new Set<ToolType>([
  'claude', 'codex', 'qwen', 'antigravity', 'pi', 'hermes',
  'opencode', 'mimocode', 'kilo', 'grok', 'kimicode', 'omp', 'codebuddy',
]);

export function supportsConversationTool(tool: ToolType | null | undefined): boolean {
  return Boolean(tool && CHAT_TOOLS.has(tool));
}

/** Only these verified TUIs need cursor suppression while repainting. */
export function usesSelfRenderedCaret(tool: ToolType | null | undefined): boolean {
  return tool === 'claude' || tool === 'codex' || tool === 'kimicode';
}
