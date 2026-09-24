import { useEffect, useRef, useState } from 'react';
import { RemoteClient, RemoteError, type RemoteSocket } from './client';
import { multiChoiceInput, type ConversationProjection } from './conversationProjection';
import type { RemoteSession, ServerMessage, StreamState } from './types';
import type { TerminalConversation } from './TerminalConversation';

const empty: ConversationProjection = { events: [], question: null };
export function useConversationStream(client: RemoteClient, session: RemoteSession, online: boolean) {
  const [projection, setProjection] = useState(empty);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<string | null>(null);
  const [canAnswer, setCanAnswer] = useState(false);
  const [answerUnsupported, setAnswerUnsupported] = useState(false);
  const decoder = useRef<TerminalConversation | null>(null);
  const current = useRef({ projection: empty, sequence: undefined as number | undefined });
  const sessionRef = useRef(session);
  const answerBusy = useRef(false);
  const answeredRef = useRef<string | null>(null);
  useEffect(() => { sessionRef.current = session; decoder.current?.resize(session.cols || 120, session.rows || 30); }, [session]);

  useEffect(() => {
    if (!online) return;
    let disposed = false, ended = false, attempt = 0, generation = 0, lastFrame = Date.now();
    let socket: RemoteSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout>;
    let model: TerminalConversation | null = null;
    function connect() {
      if (disposed || ended || document.hidden || (socket && socket.readyState <= 1)) return;
      clearTimeout(reconnect);
      lastFrame = Date.now();
      setStream(attempt ? 'reconnecting' : 'connecting');
      const ws = socket = client.socket(session.id);
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        model?.dispose();
        model = decoder.current = new Decoder(sessionRef.current.cols || 120, sessionRef.current.rows || 30, sessionRef.current.tool);
        current.current.sequence = undefined;
        setCanAnswer(false);
        generation++; attempt = 0; lastFrame = Date.now(); setStream('live');
      };
      ws.onmessage = event => {
        if (disposed || socket !== ws) return;
        lastFrame = Date.now();
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === 'output' && model) {
            const version = ++generation;
            current.current.sequence = undefined;
            setCanAnswer(false);
            void model.write(message.data).then(next => {
              if (disposed || socket !== ws || generation !== version) return;
              current.current = { projection: next, sequence: ended ? undefined : message.sequence };
              setProjection(next);
              setCanAnswer(!ended && Boolean(next.question) && message.sequence !== undefined);
              setAnswerUnsupported(message.sequence === undefined);
              if (answeredRef.current !== next.question?.id) answeredRef.current = null;
              setAnswered(previous => previous === next.question?.id ? previous : null);
            });
          } else if (message.type === 'reset') {
            generation++; model?.dispose();
            model = decoder.current = new Decoder(sessionRef.current.cols || 120, sessionRef.current.rows || 30, sessionRef.current.tool);
            current.current.sequence = undefined;
            setCanAnswer(false);
          } else if (message.type === 'status' && !message.running) {
            ended = true; current.current.sequence = undefined; setCanAnswer(false); setStream('ended');
          } else if (message.type === 'error') ws.close();
        } catch { /* A malformed transport frame never becomes a chat message. */ }
      };
      ws.onclose = () => {
        if (disposed || ended || socket !== ws) return;
        generation++; current.current.sequence = undefined; setCanAnswer(false); setStream('reconnecting');
        reconnect = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
      };
      ws.onerror = () => ws.close();
    }
    let Decoder: typeof TerminalConversation;
    void import('./TerminalConversation').then(module => { if (!disposed) { Decoder = module.TerminalConversation; connect(); } }).catch(() => { if (!disposed) setStream('reconnecting'); });
    const wake = () => {
      if (!Decoder || document.hidden) return;
      if (socket && socket.readyState <= 1 && Date.now() - lastFrame > 10000) socket.close();
      else connect();
    };
    const watchdog = setInterval(wake, 5000);
    document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; generation++; current.current.sequence = undefined;
      clearTimeout(reconnect); clearInterval(watchdog); socket?.close(); model?.dispose(); decoder.current = null;
      document.removeEventListener('visibilitychange', wake);
    };
  }, [client, session.id, online]);

  async function answer(questionId: string, choiceIndex: number | number[] | string) {
    const { projection: latest, sequence } = current.current;
    if (!online || !sessionRef.current.running || sessionRef.current.paused || answerBusy.current || answeredRef.current === questionId || latest.question?.id !== questionId || sequence === undefined) throw new RemoteError(409, 'STALE_INTERACTION');
    const question = latest.question;
    let data: string, kind: 'text' | undefined;
    if (typeof choiceIndex === 'string' && question.kind === 'text') { data = choiceIndex; kind = 'text'; if (!data.trim()) return; }
    else if (Array.isArray(choiceIndex) && question.kind === 'multi') data = multiChoiceInput(question, choiceIndex);
    else if (typeof choiceIndex === 'number' && (!question.kind || question.kind === 'choice')) { const choice = question.choices[choiceIndex]; if (!choice) return; data = choice.input; }
    else throw new RemoteError(409, 'STALE_INTERACTION');
    answerBusy.current = true; setAnswering(true);
    try {
      if (kind) await client.answer(session.id, data, sequence, kind);
      else await client.answer(session.id, data, sequence);
      if (current.current.sequence === sequence && current.current.projection.question?.id === questionId) { answeredRef.current = questionId; setAnswered(questionId); }
    }
    finally { answerBusy.current = false; setAnswering(false); }
  }
  return { projection, stream, answer, answering, answered, answerUnsupported, canAnswer: online && canAnswer };
}
