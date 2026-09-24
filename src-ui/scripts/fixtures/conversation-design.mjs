// Synthetic public example for visual review; contains no personal project data.
export const designConversation = [
  { type: 'user', message: { role: 'user', content: '帮我优化首页的移动端布局，让卡片排列更舒服，保留现有功能。' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我先看首页结构和样式，再调整小屏布局。' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'design-read', name: 'Read', input: { file_path: 'src/pages/Home.tsx' } },
    { type: 'tool_use', id: 'design-search', name: 'Grep', input: { pattern: 'workspace-grid', path: 'src/styles' } },
    { type: 'tool_use', id: 'design-edit', name: 'Edit', input: { file_path: 'src/styles/home.css', old_string: '.workspace-grid {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 12px;\n}', new_string: '.workspace-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));\n  gap: 20px;\n}' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'design-read', content: 'Read 142 lines from src/pages/Home.tsx' },
    { type: 'tool_result', tool_use_id: 'design-search', content: 'src/styles/home.css:18: .workspace-grid' },
    { type: 'tool_result', tool_use_id: 'design-edit', content: 'Updated src/styles/home.css' },
  ] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '### 首页布局已调整\n\n卡片现在会根据屏幕宽度自动排列，手机上阅读更舒展。\n\n- **自适应网格**：小屏单列，宽屏自动扩展\n- **一致的间距**：卡片间距统一为 20px\n- **保留原有操作**：按钮和项目入口位置不变\n\n核心样式是：\n\n```css\n.workspace-grid {\n  display: grid;\n  grid-template-columns:\n    repeat(auto-fit, minmax(240px, 1fr));\n  gap: 20px;\n}\n```\n\n> 可以展开上方的「执行过程」，查看具体修改。\n\n还想调整配色或卡片内容的话，继续告诉我。' }] } },
];
