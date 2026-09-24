// Local fixture server for reviewing the built mobile UI. Never binds to LAN.
// Run after npm run build:phone: node scripts/mobile-preview.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { claudeTrustStartup } from '../src/remote/fixtures/claudeTrustStartup.ts';
import { claudeStatusReplay } from '../src/remote/fixtures/claudeStatusReplay.ts';
import { designConversation } from './fixtures/conversation-design.mjs';

const root = fileURLToPath(new URL('../dist-phone/', import.meta.url));
const port = Number(process.env.SINOS_PREVIEW_PORT || 5174);
let outputSequence = 1;
let mode = process.env.SINOS_PREVIEW_INITIAL_MODE || 'normal';
const claudeFrames = ['·', '✢', '*', '✶', '✻', '✽'];
let claudeFrame = 0;
let activityRevision = 1, queueHeld = false;
const queues = new Map(), receipts = new Set();
const imageUploads = new Map();
const imageList = () => [...new Set(imageUploads.values())].flatMap(item => item.image ? [item.image] : []);
const withImages = (text, ids = []) => ids.length ? `${text.trim() ? text : '请参考这些图片。'}\n\n参考图片：\n${ids.map(id => `- ${imageUploads.get(id)?.image.reference}`).join('\n')}` : text;
function activity() { return { state: ['streaming', 'claude-spinner'].includes(mode) ? 'working' : ['multi', 'text', 'approval', 'trust', 'trust-moved'].includes(mode) ? 'waiting' : 'idle', source: 'fixture', revision: activityRevision, auto_send_ready: mode === 'normal' && !queueHeld }; }
function queueFor(id) { if (!queues.has(id)) queues.set(id, []); return queues.get(id); }
function queueSnapshot(id) { return { messages: queueFor(id), activity: activity(), held: queueHeld }; }
let sessions = [{ id: 'preview-claude', tool: 'claude', cwd: 'C:/Projects/sinos-studio', running: true, paused: false, output_chunks: 1, cols: mode.endsWith('-native') ? claudeTrustStartup.cols : 100, rows: mode.endsWith('-native') ? claudeTrustStartup.rows : 30 }, { id: 'preview-codex', tool: 'codex', cwd: 'C:/Projects/design-system', running: true, paused: false, output_chunks: 1, cols: 100, rows: 30 }];
let revision = 1;
let chatRows = [
  { type: 'user', message: { role: 'user', content: '帮我把工作台改成适合手机的对话界面，风格简洁一点。' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我先检查现有布局和会话组件，再调整手机上的阅读与输入体验。' }, { type: 'tool_use', id: 'read-app', name: 'Read', input: { file_path: 'src/App.tsx' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-app', content: 'Read 142 lines from src/App.tsx' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已经完成界面调整。\n\n### 这次做了什么\n\n- 用会话抽屉收起项目列表\n- 对话区保留完整阅读宽度\n- 输入框固定在底部，支持多行编辑\n\n文件和代码变更可以从右上角的 **会话工具** 打开。\n\n```tsx\n<ChatScreen session={session} />\n```\n\n你可以继续描述想调整的细节。' }] } },
];
if (mode === 'design') chatRows = designConversation;
let content = "import { useState } from 'react';\n\nexport function App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <main className=\"workspace\">\n      <h1>Build from anywhere</h1>\n      <button onClick={() => setCount(count + 1)}>\n        Count: {count}\n      </button>\n    </main>\n  );\n}\n";
const original = content.replace('Build from anywhere', 'Welcome to Sinos');
const output = '\x1b[32m╭─ Sinos · Claude Code ──────────╮\r\n│  sinos-studio  /  main        │\r\n╰──────────────────────────────╯\x1b[0m\r\n\r\n\x1b[90m› 优化工作台的移动端体验\x1b[0m\r\n\r\n我会先梳理布局，再完善交互细节。\r\n\r\n\x1b[32m✓\x1b[0m 读取 src/App.tsx\r\n\x1b[32m✓\x1b[0m 检查现有组件和样式\r\n\x1b[32m✓\x1b[0m 更新工作台布局\r\n\r\n\x1b[36m  src/App.tsx         +12 −4\r\n  src/theme.css       +28 −8\x1b[0m\r\n\r\n已完成。可以在「变更」中查看修改。\r\n\r\n\x1b[90m────────────────────────────────\x1b[0m\r\n› ';
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Sinos mobile UI review</title><style>body{margin:0;background:#e7eae6;font:14px system-ui;color:#26382b;display:flex;gap:40px;padding:24px;align-items:flex-start}aside{width:210px;position:sticky;top:24px}h1{font-size:23px}button{padding:11px;border:1px solid #b9c7bc;background:white;border-radius:8px;margin:0 5px 8px 0;cursor:pointer}iframe{border:1px solid #9cac9d;border-radius:20px;background:#101211;width:390px;height:844px;box-shadow:0 18px 70px #26382b33}p{line-height:1.7;color:#647468}label{display:block;margin:25px 0 12px}</style><aside><h1>Sinos / 移动工作台</h1><p>本地 UI 验证 · 模拟数据<br>不会操作真实项目或进程</p><label>视口</label><button onclick="size(320,668)">320 × 668</button><button onclick="size(390,844)">390 × 844</button><button onclick="size(430,932)">430 × 932</button><button onclick="size(768,1024)">768 × 1024</button><button onclick="size(390,450)">键盘高度</button><label>接口状态</label><button onclick="mode('normal')">正常</button><button onclick="mode('offline')">离线</button><button onclick="mode('unauthorized')">配对失效</button><button onclick="mode('conflict')">保存冲突</button><button onclick="mode('empty')">无会话</button><button onclick="document.querySelector('iframe').src='/remote/'">重载</button><p id="result">等待验证</p></aside><iframe title="移动工作台预览" allow="clipboard-write" src="/remote/"></iframe><script>function size(w,h){const f=document.querySelector('iframe');f.style.width=w+'px';f.style.height=h+'px'}async function mode(v){await fetch('/fixture/'+v,{method:'POST'});document.getElementById('result').textContent='当前：'+v;}</script></html>`;
// Local-only image fixture, using an already public asset, never personal files.
const imageFixtureButton = `<button onclick="mode('claude-spinner')">Claude 连续动画</button><button onclick="fixtureImage()">添加示例图片</button><script>async function fixtureImage(){const data=await (await fetch('/remote-icon.png')).blob();const transfer=new DataTransfer();transfer.items.add(new File([data],'示例图片.png',{type:'image/png'}));const input=document.querySelector('iframe').contentDocument.querySelector('input[aria-label="选择图片文件"]');if(input){input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}}</script>`;
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
const menuFixtureButtons = `<button onclick="mode('trust')">目录信任菜单</button><button onclick="mode('trust-moved')">桌面下移一项</button>`;
function screenOutput() {
  // A full native history plus its latest visible reply, like a scrolled CLI.
  // Do not fabricate parallel tool-result echoes in a different display order.
  if (mode === 'design') return (designConversation.at(-1).message.content[0].text + '\n\n' + '─'.repeat(100) + '\n❯\n' + '─'.repeat(100) + '\n[Fable 5.1] ▰▱▱▱ 12% | sinos-studio\n⏸ manual mode on · ← for agents').replace(/\n/g, '\r\n');
  if (mode === 'status-native') return claudeStatusReplay.frames.join('');
  if (mode === 'trust-native') return claudeTrustStartup.data;
  if (mode === 'trust' || mode === 'trust-moved') return ['C:\\Users\\zhouh', '', 'Quick safety check: Is this a project you created or one you trust?', "If not, take a moment to review what's in this folder first.", '', "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '', `${mode === 'trust' ? '❯' : ' '} No, exit`, `${mode === 'trust-moved' ? '❯' : ' '} Yes, I trust this folder`, '', 'Enter to confirm · Esc to cancel'].join('\r\n');
  if (mode === 'claude-spinner') return `我先检查现有布局和会话组件，再调整手机上的阅读与输入体验。\r\n\r\n${claudeFrames[claudeFrame]} Synthesizing… (12s · ↓ 180 tokens)`;
  if (mode === 'multi') return 'Which areas should we improve?\r\n\r\n› [x] 界面布局\r\n  [ ] 消息体验\r\n  [ ] 自动化测试\r\n\r\nSpace to select, Enter to confirm';
  if (mode === 'text') return '你希望采用什么配色？\r\n\r\nType your answer:';
  if (mode === 'startup') return '正在连接你的工作空间…\r\n\r\n登录后即可继续创建。请在浏览器中完成登录：\r\nhttps://example.com/login\r\n\r\nPress Enter to continue';
  if (mode === 'approval') return 'Would you like to run the following command?\r\n\r\n  $ npm test\r\n\r\n› 1. Yes, proceed\r\n  2. No, cancel\r\n\r\nPress enter to confirm';
  if (mode === 'streaming') return '› 请检查当前项目\r\n\r\n我会先检查项目结构，然后运行测试。\r\n\r\n\x1b[32m✓\x1b[0m 读取 src/App.tsx\r\n⠋ 正在检查 10%\r\x1b[2K⠙ 正在检查 80%';
  return chatRows.flatMap(row => {
    const body = row.message.content;
    if (typeof body === 'string') return [`${row.type === 'user' ? '› ' : ''}${body}`];
    return body.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'tool_use' ? [`● ${block.name}(${block.input.file_path})`] : block.type === 'tool_result' ? [block.content] : []);
  }).join('\r\n\r\n').replace(/(?<!\r)\n/g, '\r\n') + '\r\n› ';
}
function broadcastScreen() {
  outputSequence++;
  for (const ws of wss.clients) { ws.send(JSON.stringify({ type: 'reset' })); ws.send(JSON.stringify({ type: 'output', session_id: ws.sessionId, data: screenOutput(), sequence: outputSequence })); }
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:5174');
    const route = url.pathname;
    if (route.startsWith('/fixture/')) {
      mode = route.split('/').pop(); activityRevision++;
      if (mode === 'finish') {
        mode = 'normal';
        for (const items of queues.values()) if (!queueHeld && items[0]?.status === 'queued') {
          const item = items.shift(); receipts.add(item.id);
          chatRows.push({ type: 'user', message: { role: 'user', content: withImages(item.text, item.attachments?.map(image => image.id)) } }, { type: 'assistant', message: { role: 'assistant', content: '已收到排队消息。这是本地模拟，不会操作真实项目。' } });
          mode = 'streaming';
        }
      }
      for (const ws of wss.clients) if (['offline','unauthorized','empty'].includes(mode)) ws.close();
      broadcastScreen(); return json(response, 200, { mode });
    }
    if (route === '/preview.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(page.replace('</aside>', menuFixtureButtons + imageFixtureButton + '</aside>').replace('<p id="result">', '<button onclick="mode(\'startup\')">启动提示</button><button onclick="mode(\'streaming\')">生成中</button><button onclick="mode(\'finish\')">完成本轮</button><button onclick="mode(\'approval\')">确认卡片</button><button onclick="mode(\'multi\')">多选问题</button><button onclick="mode(\'text\')">文字回答</button><button onclick="mode(\'upload-failure\')">上传失败</button><p id="result">')); }
    if (route.startsWith('/api/')) {
      if (mode === 'offline') return json(response, 503, {});
      if (mode === 'unauthorized') return json(response, 401, {});
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = body ? JSON.parse(body) : {};
      if (route === '/api/state') return json(response, 200, { device_name: 'Sinos Dev Computer', capabilities: ['activity','message_queue','answer_text','answer_multiselect','image_attachments_v1'], sessions: mode === 'empty' ? [] : sessions.map(s => ({ ...s, activity: activity(), queued_count: queueFor(s.id).length })) });
      if (route === '/api/tools') return json(response, 200, [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex CLI' }, { id: 'gemini', displayName: 'Gemini CLI' }, { id: 'opencode', displayName: 'OpenCode' }]);
      if (route === '/api/launch') { const id = `preview-${Date.now()}`; sessions = [...sessions, { ...sessions[0], id, tool: payload.tool, cwd: payload.cwd || sessions[0].cwd }]; return json(response, 202, { session_id: id }); }
      if (route.endsWith('/directory')) return json(response, 200, { truncated: false, entries: url.searchParams.get('path') ? [{ name: 'App.tsx', path: 'src/App.tsx', is_dir: false, size: content.length }, { name: 'theme.css', path: 'src/theme.css', is_dir: false, size: 2048 }, { name: 'components', path: 'src/components', is_dir: true, size: 0 }] : [{ name: 'src', path: 'src', is_dir: true, size: 0 }, { name: 'public', path: 'public', is_dir: true, size: 0 }, { name: 'package.json', path: 'package.json', is_dir: false, size: 1493 }, { name: 'README.md', path: 'README.md', is_dir: false, size: 2679 }] });
      if (route.endsWith('/file')) {
        if (request.method === 'POST') { if (mode === 'conflict' || payload.expected_revision !== String(revision)) return json(response, 409, { status: 'conflict' }); content = payload.content; revision++; return json(response, 200, { status: 'saved', revision: String(revision), size: content.length }); }
        return json(response, 200, { content, revision: String(revision), line_ending: 'lf', has_utf8_bom: false, size: content.length });
      }
      if (route.endsWith('/changes')) return json(response, 200, { state: 'ok', branch: 'main', files: [{ path: 'src/App.tsx', status: 'M', added: 12, deleted: 4 }, { path: 'src/theme.css', status: 'M', added: 28, deleted: 8 }, { path: 'src/components/Workspace.tsx', status: '?', added: 86, deleted: 0 }] });
      if (route.endsWith('/diff')) return json(response, 200, { path: url.searchParams.get('path'), before: original, after: content });
      if (route.endsWith('/chat')) return json(response, 200, { bound: !['startup', 'streaming', 'trust', 'trust-moved', 'trust-native', 'status-native'].includes(mode), sourceId: route.split('/')[3], title: '优化工作台的移动端体验', data: chatRows.map(row => JSON.stringify(row)).join('\n') + '\n', cursor: chatRows.length, history_cursor: 0, has_older: false, revision: String(chatRows.length), append: false, prepend: false, unchanged: url.searchParams.get('revision') === String(chatRows.length) });
      const id = route.split('/')[3];
      if (route.endsWith('/images')) {
        const failure = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain' }); response.end(text); };
        const key = `${id}:${payload.id}`;
        if (payload.action === 'list') return json(response, 200, { images: imageList() });
        let item = imageUploads.get(key);
        if (payload.action === 'upload') {
          if (!item) { item = { data: Buffer.alloc(0), image: null }; imageUploads.set(key, item); imageUploads.set(payload.id, item); }
          const data = Buffer.from(payload.data_base64, 'base64');
          if (payload.offset === item.data.length) item.data = Buffer.concat([item.data, data]);
          if (item.data.length === payload.total) item.image = { id: payload.id, name: payload.name, reference: `C:/Temp/sinos-mobile-images/fixture/${payload.id}.png`, size: item.data.length, width: 256, height: 256 };
          if (mode === 'upload-failure') return failure(503, 'COMPUTER_OFFLINE');
          return json(response, 200, { received: item.data.length, image: item.image });
        }
        if (!item) return failure(404, 'IMAGE_NOT_FOUND');
        if (payload.action === 'status') return json(response, 200, { received: item.data.length, image: item.image });
        if (payload.action === 'preview') return json(response, 200, { data_base64: item.data.toString('base64') });
        if (payload.action === 'read') { const part = item.data.subarray(payload.offset, payload.offset + 256 * 1024); return json(response, 200, { data_base64: part.toString('base64'), next: payload.offset + part.length, total: item.data.length }); }
        if (payload.action === 'remove') { imageUploads.delete(key); imageUploads.delete(payload.id); return json(response, 200, { removed: true }); }
      }
      if (route.endsWith('/queue')) {
        const items = queueFor(id);
        if (request.method === 'POST') {
          const item = items.find(v => v.id === payload.id);
          if (payload.action === 'enqueue') {
            if (!item && !receipts.has(payload.id)) items.push({ id: payload.id, text: payload.text, revision: 1, status: 'queued', attachments: (payload.attachments || []).map(id => imageUploads.get(id)?.image) });
          } else {
            if (!item || item.revision !== payload.expected_revision) return json(response, 409, 'QUEUE_CONFLICT');
            if (payload.action === 'edit') { item.text = payload.text; item.revision++; item.status = 'queued'; }
            if (payload.action === 'hold' || payload.action === 'release') { item.status = payload.action === 'hold' ? 'editing' : 'queued'; item.revision++; }
            if (payload.action === 'remove' || payload.action === 'send') {
              if (payload.action === 'send' && activity().state !== 'idle') return json(response, 409, 'SESSION_BUSY');
              items.splice(items.indexOf(item), 1); receipts.add(item.id);
              if (payload.action === 'send') { queueHeld = false; mode = 'streaming'; activityRevision++; chatRows.push({ type: 'user', message: { role: 'user', content: withImages(item.text, item.attachments?.map(image => image.id)) } }); broadcastScreen(); }
            }
          }
        }
        return json(response, 200, queueSnapshot(id));
      }
      if (route.endsWith('/answer')) {
        if (payload.expected_output !== outputSequence) return json(response, 409, 'STALE_INTERACTION');
        if (mode === 'trust' || mode === 'trust-moved') console.log('Trust menu fixture answer:', JSON.stringify({ data: payload.data, expected_output: payload.expected_output }));
        mode = 'normal'; activityRevision++;
        chatRows.push({ type: 'assistant', message: { role: 'assistant', content: '已收到你的选择。这是本地模拟流程，没有运行真实命令。' } });
        broadcastScreen();
      }
      if (route.endsWith('/prompt')) {
        mode = 'normal'; queueHeld = false; activityRevision++;
        const text = withImages(payload.data, payload.attachments);
        chatRows.push({ type: 'user', message: { role: 'user', content: text } }, { type: 'assistant', message: { role: 'assistant', content: '已收到测试消息。这是本地 UI 验证数据，不会运行真实 AI 或修改项目。' } });
        broadcastScreen();
      }
      if (route.endsWith('/input')) { if (payload.data.includes('\x03')) { queueHeld = true; mode = 'normal'; activityRevision++; broadcastScreen(); } }
      if (route.endsWith('/pause')) sessions = sessions.map(s => s.id === id ? { ...s, paused: payload.paused } : s);
      if (route.endsWith('/kill')) sessions = sessions.filter(s => s.id !== id);
      response.writeHead(204); return response.end();
    }
    const relative = route === '/remote' || route === '/remote/' ? 'index.html' : decodeURIComponent(route.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root)) { response.writeHead(403); return response.end(); }
    const bytes = await fs.readFile(file);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
    // Match production's script policy while allowing this local preview iframe.
    const security = type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; object-src 'none'" } : {};
    response.writeHead(200, { 'Content-Type': type, ...security }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
const wss = new WebSocketServer({ noServer: true });
const claudeAnimation = setInterval(() => {
  if (mode !== 'claude-spinner') return;
  claudeFrame = (claudeFrame + 1) % claudeFrames.length; outputSequence++;
  for (const ws of wss.clients) ws.send(JSON.stringify({ type: 'output', session_id: ws.sessionId, data: `\r\x1b[2K${claudeFrames[claudeFrame]} Synthesizing… (12s · ↓ 180 tokens)`, sequence: outputSequence }));
}, 250);
server.on('close', () => clearInterval(claudeAnimation));
server.on('upgrade', (request, socket, head) => {
  if (mode === 'offline' || mode === 'unauthorized') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, ws => {
    ws.sessionId = new URL(request.url, 'http://localhost').searchParams.get('session_id');
    ws.send(JSON.stringify({ type: 'output', session_id: ws.sessionId, data: screenOutput(), sequence: outputSequence }));
    const timer = setInterval(() => ws.send(JSON.stringify({ type: 'status', session_id: ws.sessionId, running: sessions.some(s => s.id === ws.sessionId), paused: false })), 2000);
    ws.on('close', () => clearInterval(timer));
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Local mobile UI fixtures: http://127.0.0.1:${port}/preview.html`));
