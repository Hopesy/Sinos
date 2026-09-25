export type ActivityPhase = 'unknown' | 'working' | 'waiting' | 'idle' | 'failed';
export interface ActivitySnapshot { state: ActivityPhase; source: string; revision: number; auto_send_ready: boolean }
export type QueueAction = 'enqueue' | 'edit' | 'remove' | 'send' | 'hold' | 'release';
export interface ImageAttachment { id: string; name: string; reference: string; size: number; width: number; height: number }
export interface ImageUpload { received: number; image: ImageAttachment | null }
export interface QueuedPrompt { id: string; text: string; revision: number; status: 'queued' | 'uncertain' | 'editing'; attachments?: ImageAttachment[] }
export interface QueueSnapshot { messages: QueuedPrompt[]; activity: ActivitySnapshot; held?: boolean }
export interface RemoteSession { id: string; tool: string | null; cwd: string; running: boolean; paused: boolean; output_chunks: number; cols: number; rows: number; activity?: ActivitySnapshot; queued_count?: number }
export interface RemoteTool { id: string; displayName: string }
export interface RemoteState { sessions: RemoteSession[]; device_name: string; capabilities?: string[] }
export type Connection = 'connecting' | 'online' | 'offline' | 'unauthorized' | 'replaced' | 'paused';
export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'ended';
export type ServerMessage = { type: 'reset' } | { type: 'codex' | 'claude'; session_id: string; page: import('./CodexEventStream').CodexPage } | { type: 'output'; session_id: string; data: string; sequence?: number } | { type: 'status'; session_id: string; running: boolean; paused: boolean } | { type: 'error'; message: string };
export interface FileEntry { name: string; path: string; is_dir: boolean; size: number }
export interface FileSnapshot { content: string; revision: string; line_ending: string; has_utf8_bom: boolean; size: number }
export interface ChangeFile { path: string; status: string; added: number; deleted: number }
export interface Changes { state: 'ok' | 'not_repo' | 'no_git'; branch?: string; files: ChangeFile[] }
export interface FileDiff { before: string; after: string; path: string }
