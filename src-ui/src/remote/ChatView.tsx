import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CircleCheck, CircleDashed, ListPlus, Sparkles, Square, X } from 'lucide-react';
import { RemoteClient, RemoteError, errorMessage, storageRead, storageWrite, type ChatRead } from './client';
import { updateChatTranscript, normalizePrompt, type ChatTranscriptState } from '../lib/chat-transcript';
import type { RemoteSession } from './types';
import { mergeConversationTimeline } from './conversationProjection';
import { useConversationStream } from './useConversationStream';
import { ConversationTool } from './ConversationTool';
import { ConversationQuestion } from './ConversationQuestion';
import { ConversationStatus } from './ConversationStatus';
import { ConversationMarkdown } from './ConversationMarkdown';
import { ConversationToolGroup } from './ConversationToolGroup';
import { groupConversation } from './groupConversation';
import { useMessageQueue } from './useMessageQueue';
import { MessageQueue } from './MessageQueue';
import type { QueuedPrompt } from './types';
import { useImageAttachments } from './useImageAttachments';
import { DraftImages, ImagePicker, MessageImages } from './ImageAttachments';
import { imageError, imageMessage, imagePrompt, imageProjection } from './images';

interface SentPrompt { id: number; text: string; seen: Set<string> }
function remainingPrompts(prompts: SentPrompt[], transcript: ChatTranscriptState) {
  const acknowledged = new Set<string>();
  return prompts.filter(prompt => {
    const match = transcript.messages.find(message => message.role === 'user' && !prompt.seen.has(message.id) && !acknowledged.has(message.id) && normalizePrompt(message.content) === normalizePrompt(prompt.text));
    if (match) { acknowledged.add(match.id); return false; }
    return true;
  }).map(prompt => ({ ...prompt, seen: new Set([...prompt.seen, ...acknowledged]) }));
}

export function ChatView({ client, session, online, toolName, onTitle, insert, onInserted, capabilities = [] }: {
  client: RemoteClient; session: RemoteSession; online: boolean; toolName: string;
  onTitle: (title: string) => void; insert: string; onInserted: () => void;
  capabilities?: string[];
}) {
  const [transcript, setTranscript] = useState<ChatTranscriptState>({ messages: [], remainder: '', nextLineIndex: 0 });
  const [draft, setDraft] = useState(() => {
    const chat = storageRead(`chat-draft-${session.id}`), terminal = storageRead(`draft-${session.id}`);
    return [chat, terminal !== chat ? terminal : ''].filter(Boolean).join('\n');
  });
  const [read, setRead] = useState<ChatRead | null>(null);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [following, setFollowing] = useState(true);
  const [pending, setPending] = useState<SentPrompt[]>([]);
  const [stopping, setStopping] = useState(false);
  const live = useConversationStream(client, session, online);
  const queueEnabled = capabilities.includes('message_queue');
  const autoQueueSupported = session.tool === 'claude' || session.tool === 'codex';
  const queue = useMessageQueue(client, session.id, queueEnabled, online);
  const imageEnabled = capabilities.includes('image_attachments_v1') && (session.tool === 'claude' || session.tool === 'codex');
  const images = useImageAttachments(client, session.id, imageEnabled, online);
  const hasContent = Boolean(draft.trim() || images.items.length);
  const preparingImages = images.preparing || (imageEnabled && !images.loaded);
  const knownImages = useMemo(() => [...new Map([...images.known, ...(queue.snapshot?.messages.flatMap(item => item.attachments || []) || [])].map(image => [image.id, image])).values()], [images.known, queue.snapshot]);
  const timeline = useMemo(() => {
    const messages = [...transcript.messages, ...pending.map(prompt => ({ id: `pending-${prompt.id}`, role: 'user' as const, content: prompt.text }))];
    return mergeConversationTimeline(imageProjection(live.projection, messages.filter(message => message.role === 'user').map(message => message.content), knownImages), messages);
  }, [live.projection, transcript.messages, pending, knownImages]);
  const displayTimeline = useMemo(() => groupConversation(timeline), [timeline]);
  const lastSpoken = transcript.messages.reduce((last, message, index) => message.role === 'user' || message.role === 'assistant' ? index : last, -1);
  const activeTools = new Set(transcript.messages.slice(lastSpoken + 1).map(message => message.id));
  const question = session.running && live.stream !== 'ended' ? live.projection.question : null;
  const nativeActivity = queue.snapshot && queue.snapshot.activity.revision >= (session.activity?.revision ?? 0) ? queue.snapshot.activity : session.activity;
  const observedPhase = nativeActivity?.source === 'unknown' ? live.projection.activity || nativeActivity.state : nativeActivity?.state || live.projection.activity || 'unknown';
  const phase = question ? 'waiting' : !session.running || live.stream === 'ended' ? 'ended' : session.paused ? 'paused' : observedPhase;
  const working = phase === 'working';
  const phaseLabel = { working: '正在生成', waiting: '等待回答', idle: '就绪', paused: '已暂停', ended: '已结束', failed: '本轮已停止', unknown: '状态同步中' }[phase];
  const scroll = useRef<HTMLDivElement>(null);
  const timelineElement = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const poll = useRef<() => void>(() => {});
  const latest = useRef<ChatRead | null>(null);
  const raw = useRef('');
  const transcriptRef = useRef(transcript);
  const busy = useRef(false);
  const titleRef = useRef(onTitle); titleRef.current = onTitle;
  const sendState = useRef({ phase, online }); sendState.current = { phase, online };
  const pendingRef = useRef<SentPrompt[]>([]);
  const nextPrompt = useRef(0);
  const updatePending = (prompts: SentPrompt[]) => { pendingRef.current = prompts; setPending(prompts); };
  useEffect(() => {
    if (insert) { setDraft(value => `${value}${value ? '\n' : ''}${insert}`); onInserted(); requestAnimationFrame(() => textarea.current?.focus()); }
  }, [insert, onInserted]);
  useEffect(() => {
    storageWrite(`chat-draft-${session.id}`, draft);
    // Both former entry points now share this one composer, including old drafts.
    storageWrite(`draft-${session.id}`, '');
    if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(180, textarea.current.scrollHeight)}px`; }
  }, [draft, session.id]);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (disposed) return;
      if (busy.current || !online || document.hidden) { timer = setTimeout(refresh, 1500); return; }
      busy.current = true;
      try {
        const previous = latest.current;
        let next = await client.chat(session.id, previous?.cursor, previous?.revision);
        if (!disposed && next.bound && ((!previous?.bound && (next.append || next.unchanged)) || (previous?.sourceId && previous.sourceId !== next.sourceId))) {
          // A newly bound native transcript must start at its own snapshot,
          // never at an offset belonging to the previous file.
          next = await client.chat(session.id);
        }
        if (disposed) return;
        const retainHistory = previous?.sourceId === next.sourceId && (next.append || next.unchanged);
        const current = retainHistory && previous ? { ...next, history_cursor: previous.history_cursor, has_older: previous.has_older } : next;
        latest.current = current;
        setRead(current);
        if (next.title) titleRef.current(next.title);
        if (next.bound && !next.unchanged) {
          const changedSource = previous?.sourceId && previous.sourceId !== next.sourceId;
          const append = next.append && !changedSource;
          raw.current = append ? raw.current + next.data : next.data;
          const parsed = updateChatTranscript(next.data, append ? transcriptRef.current : undefined);
          transcriptRef.current = parsed; setTranscript(parsed);
          // A new native snapshot is the source of truth after submission.
          updatePending(remainingPrompts(pendingRef.current, parsed));
        }
        setSyncError('');
      } catch (cause) { if (!disposed) setSyncError(errorMessage(cause)); }
      finally { busy.current = false; if (!disposed) timer = setTimeout(refresh, 1200); }
    }
    poll.current = () => { clearTimeout(timer); void refresh(); };
    const wake = () => { if (!document.hidden) poll.current(); };
    void refresh(); document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [client, session.id, online]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const anchor = historyAnchor.current;
    if (anchor) { el.scrollTop = anchor.top + el.scrollHeight - anchor.height; historyAnchor.current = null; }
    else if (followingRef.current) el.scrollTop = el.scrollHeight;
  }, [timeline, following]);
  useEffect(() => {
    if (!timelineElement.current || typeof ResizeObserver === 'undefined') return;
    // Markdown images, tool expansion and the software keyboard can change
    // height without adding a message. Only follow while already at the end.
    const observer = new ResizeObserver(() => { if (followingRef.current && scroll.current && !historyAnchor.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    observer.observe(timelineElement.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  function follow(value: boolean) { followingRef.current = value; setFollowing(value); }
  async function older() {
    if (busy.current || loadingOlder || read?.history_cursor == null) return;
    busy.current = true; setLoadingOlder(true);
    try {
      const next = await client.chat(session.id, null, undefined, read.history_cursor);
      if (next.sourceId !== latest.current?.sourceId) { poll.current(); return; }
      if (scroll.current) historyAnchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      follow(false);
      raw.current = next.data + raw.current;
      transcriptRef.current = updateChatTranscript(raw.current); setTranscript(transcriptRef.current);
      const current = latest.current;
      if (current) { latest.current = { ...current, history_cursor: next.history_cursor, has_older: next.has_older }; setRead(latest.current); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setLoadingOlder(false); }
  }
  async function send(enqueue = working && queueEnabled) {
    if (!hasContent || preparingImages || sending || !online || session.paused || !session.running || ((question || phase === 'waiting') && !enqueue)) return;
    const text = draft;
    const selected = images.items.map(image => image.id);
    const seen = new Set(transcriptRef.current.messages.map(message => message.id));
    let uploading = selected.length > 0;
    setSending(true); setError('');
    try {
      const uploaded = selected.length ? await images.ensureUploaded() : [];
      uploading = false;
      if (enqueue && queueEnabled) {
        if (await queue.add(text, uploaded.length ? uploaded.map(image => image.id) : undefined)) { setDraft(value => value === text ? '' : value); if (selected.length) images.clear(selected); follow(true); }
        return;
      }
      // CLI terminal paste is one prompt; embedded line breaks never become
      // separate Enter presses. No retry on timeout (the CLI may have it).
      if (uploaded.length && (!sendState.current.online || ['working', 'waiting', 'paused', 'ended'].includes(sendState.current.phase))) throw new RemoteError(409, 'SESSION_BUSY');
      if (uploaded.length) await client.prompt(session.id, text, uploaded.map(image => image.id));
      else await client.prompt(session.id, text);
      setDraft(value => value === text ? '' : value);
      if (selected.length) images.clear(selected);
      updatePending(remainingPrompts([...pendingRef.current, { id: nextPrompt.current++, text: imagePrompt(text, uploaded), seen }], transcriptRef.current));
      follow(true); poll.current();
    } catch (cause) { setError(uploading || (cause instanceof Error && cause.message.startsWith('IMAGE_')) ? imageError(cause) : `${errorMessage(cause)} 草稿已保留，请查看最新消息后再决定是否重发。`); }
    finally { setSending(false); }
  }
  async function queueAction(action: 'edit' | 'remove' | 'send' | 'hold' | 'release', item: QueuedPrompt, text?: string) {
    setError('');
    try { if (!await queue.mutate(action, item, text)) throw new RemoteError(409, 'QUEUE_CONFLICT'); }
    catch (cause) { setError(errorMessage(cause)); throw cause; }
  }
  async function stop() {
    if (!online || !session.running || session.paused || stopping || phase === 'idle') return;
    setStopping(true); setError('');
    try { await client.input(session.id, '\x03'); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setStopping(false); }
  }
  return <div className="phone-chat">
    <div className="chat-reading-pane">
    <div className="chat-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow(el.scrollHeight - el.scrollTop - el.clientHeight < 90); }}>
      <div className="chat-timeline" ref={timelineElement} onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) follow(false); }}>
        {read?.has_older && <button className="load-history" onClick={() => void older()} disabled={loadingOlder}>{loadingOlder ? '载入中…' : '查看更早的消息'}</button>}
        {!timeline.length && !question && <div className="chat-empty"><div className="coffee-glyph">✳</div><h2>{read?.bound ? '从一个想法开始' : '继续你的创作'}</h2><p>{read === null ? '正在同步电脑上的会话…' : read.bound ? '告诉 AI 你想构建什么。' : '正在接续会话，消息和执行进度会显示在这里。'}</p></div>}
        {displayTimeline.map((row, index) => {
          if (row.source === 'tools') return <ConversationToolGroup key={row.id} messages={row.messages} cwd={session.cwd} activeIds={activeTools} active={online && (working || phase === 'unknown')} />;
          if (row.source === 'message' && (row.message.role === 'tool' || row.message.role === 'reasoning')) return <ConversationTool key={`native-${row.message.id}`} message={row.message} cwd={session.cwd} active={online && (working || phase === 'unknown') && activeTools.has(row.message.id)} />;
          if (row.source === 'projection' && (row.event.kind === 'activity' || row.event.kind === 'error')) {
            const event = row.event, running = event.status === 'running' && online && (working || phase === 'unknown') && live.stream === 'live';
            return <div className={`conversation-activity ${event.status || ''}`} key={event.id}>{event.status === 'running' ? <CircleDashed size={16} className={running ? 'spin' : ''} /> : event.status === 'failed' ? <X size={16} /> : <CircleCheck size={16} />}<span>{event.text}</span></div>;
          }
          const role = row.source === 'message' ? row.message.role : row.event.kind;
          const text = row.source === 'message' ? row.message.content : row.event.text;
          const key = row.source === 'message' ? `native-${row.message.id}` : row.event.id;
          const sent = row.source === 'message' && row.message.id.startsWith('pending-');
          const message = role === 'user' ? imageMessage(text, knownImages) : null;
          const previous = displayTimeline[index - 1];
          const start = !previous || (previous.source === 'message' ? previous.message.role === 'user' : previous.source === 'projection' && previous.event.kind === 'user');
          return <article className={`chat-message ${role}`} key={key}>{message ? <div className="user-bubble">{message.text}<MessageImages client={client} session={session.id} images={message.images} />{sent && <small>已发送</small>}</div> : <>{start && <div className="assistant-label"><Sparkles size={14} /><span>{toolName}</span></div>}<ConversationMarkdown text={text} /></>}</article>;
        })}
        {online && live.stream === 'reconnecting' && <p className="conversation-sync" role="status">正在恢复会话同步…</p>}
      </div>
    </div>
    {!following && !question && <button className="jump-latest" onClick={() => follow(true)} aria-label="回到最新消息"><ArrowDown size={17} /></button>}
    </div>
    {(error || images.error || syncError) && <div className="chat-error" role="alert">{error || images.error || syncError}<button aria-label="关闭提示" onClick={() => { setError(''); setSyncError(''); images.dismissError(); }}><X size={15} /></button></div>}
    <div className="chat-compose-wrap">
      <div className="chat-interactions">
      {queueEnabled && <MessageQueue messages={queue.snapshot?.messages || []} disabled={!online || queue.busy} canSend={!question && !working && phase !== 'waiting' && !session.paused && session.running} held={Boolean(queue.snapshot?.held)} onAction={queueAction} />}
      {question && <ConversationQuestion key={question.id} question={question} disabled={!online || live.stream !== 'live' || live.canAnswer === false || session.paused} unsupported={live.answerUnsupported || (question.kind === 'text' && !capabilities.includes('answer_text')) || (question.kind === 'multi' && !capabilities.includes('answer_multiselect'))} answering={live.answering} answered={live.answered === question.id} disconnected={!online || live.stream !== 'live'} onAnswer={async value => { setError(''); try { await live.answer(question.id, value); } catch (cause) { setError(errorMessage(cause)); throw cause; } }} />}
      </div><div className="chat-compose">
      {live.projection.terminalStatus && !question && <ConversationStatus status={live.projection.terminalStatus} cwd={session.cwd} />}
      {images.items.length > 0 && <DraftImages items={images.items} disabled={sending || images.preparing} onRemove={images.remove} />}
      {(images.progress || images.preparing) && <div className="image-upload-status" role="status"><span>{images.progress || '正在处理图片…'}</span>{images.progress && <button onClick={images.cancel}>取消上传</button>}</div>}
      {images.notice && images.items.length > 0 && <p className="image-draft-notice">{images.notice}</p>}
      <textarea ref={textarea} aria-label="发送消息" placeholder={!online ? '电脑离线，仍可继续写下想法…' : question ? '先完成上方确认，也可以继续写草稿…' : '你想构建什么？'} value={draft} onChange={e => setDraft(e.target.value)} rows={2} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="chat-compose-tools">{imageEnabled && <ImagePicker disabled={sending || preparingImages || images.items.length >= 4} onSelect={files => void images.select(files)} />}<span className="composer-cli"><span className={`status-dot ${online ? 'is-online' : ''}`} /><span className="cli-name">{toolName}</span></span><span className={`composer-hint phase-${phase}`}>{working && <CircleDashed size={12} className="spin" />}{phaseLabel}</span>{queueEnabled && !working && <button className="composer-queue" aria-label="加入待发送队列" title="加入待发送队列" disabled={!hasContent || preparingImages || sending || !online || !session.running || queue.busy} onClick={() => void send(true)}><ListPlus size={17} /></button>}<button className="composer-stop" aria-label="停止当前生成" title="停止当前生成" disabled={!online || session.paused || !session.running || stopping || phase === 'idle'} onClick={() => void stop()}><Square size={14} /></button><button className="send-hit" aria-label={working && queueEnabled ? "加入队列" : "发送"} title={working && queueEnabled ? autoQueueSupported ? "确认本轮结束后发送" : "加入待发送队列" : "发送"} disabled={!hasContent || preparingImages || sending || !online || session.paused || !session.running || Boolean(question) || phase === 'waiting'} onClick={() => void send()}><span>{working && queueEnabled ? <ListPlus size={19} /> : <ArrowUp size={19} />}</span></button></div>
    </div><p className="composer-caption">{!online ? '等待电脑连接 · 草稿自动保存' : working && queueEnabled ? autoQueueSupported ? '新消息会加入队列，确认本轮结束后继续' : '新消息会加入队列，空闲后可选择发送' : '与桌面同步 · 同一个会话'}</p></div>
  </div>;
}
