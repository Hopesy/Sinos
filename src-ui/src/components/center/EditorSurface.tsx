import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import { commands } from '../../tauri';
import type { EditorFileSnapshot } from '../../tauri';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './EditorSurface.css';

type MonacoEnvironment = {
  getWorker: (_moduleId: string, _label: string) => Worker;
};

(globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment }).MonacoEnvironment = {
  getWorker: (_moduleId, label) => label === 'json' ? new JsonWorker() : new EditorWorker(),
};
loader.config({ monaco });

interface EditorSurfaceProps {
  tabId: string;
  path: string;
  workspaceRoot: string;
  isActive: boolean;
}

interface EditorDocument {
  snapshot: EditorFileSnapshot;
  model: monaco.editor.ITextModel;
  viewState?: monaco.editor.ICodeEditorViewState | null;
}

const documents = new Map<string, EditorDocument>();
const loadedLanguages = new Set<string>();

// Monaco 0.56's narrow editor API does not register language definitions.
// Load only the definition needed by the opened file so the common terminal
// startup path does not pay for every grammar in the package.
const languageLoaders: Record<string, () => Promise<unknown>> = {
  json: () => import('monaco-editor/languages/features/json/register'),
  typescript: () => import('monaco-editor/languages/definitions/typescript/register'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/register'),
  rust: () => import('monaco-editor/languages/definitions/rust/register'),
  python: () => import('monaco-editor/languages/definitions/python/register'),
  go: () => import('monaco-editor/languages/definitions/go/register'),
  java: () => import('monaco-editor/languages/definitions/java/register'),
  c: () => import('monaco-editor/languages/definitions/cpp/register'),
  cpp: () => import('monaco-editor/languages/definitions/cpp/register'),
  csharp: () => import('monaco-editor/languages/definitions/csharp/register'),
  css: () => import('monaco-editor/languages/definitions/css/register'),
  scss: () => import('monaco-editor/languages/definitions/scss/register'),
  html: () => import('monaco-editor/languages/definitions/html/register'),
  xml: () => import('monaco-editor/languages/definitions/xml/register'),
  markdown: () => import('monaco-editor/languages/definitions/markdown/register'),
  yaml: () => import('monaco-editor/languages/definitions/yaml/register'),
  ini: () => import('monaco-editor/languages/definitions/ini/register'),
  shell: () => import('monaco-editor/languages/definitions/shell/register'),
  powershell: () => import('monaco-editor/languages/definitions/powershell/register'),
  sql: () => import('monaco-editor/languages/definitions/sql/register'),
  graphql: () => import('monaco-editor/languages/definitions/graphql/register'),
};

async function ensureLanguage(language: string): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const load = languageLoaders[language];
  if (!load) return;
  await load();
  loadedLanguages.add(language);
}

function editorKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function languageForPath(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  const languages: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', jsonc: 'json', rs: 'rust', py: 'python', go: 'go',
    java: 'java', c: 'c', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml', md: 'markdown',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', sh: 'shell', ps1: 'powershell',
    sql: 'sql', graphql: 'graphql', vue: 'html', svelte: 'html',
  };
  return languages[ext] ?? 'plaintext';
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function isPathInside(path: string, directory: string): boolean {
  const normalizedPath = editorKey(path);
  const normalizedDirectory = editorKey(directory);
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function formatError(error: unknown, t: ReturnType<typeof useT>): string {
  const message = String(error);
  if (message.includes('EDITOR_BINARY_FILE')) return t('editor.binary');
  if (message.includes('EDITOR_UNSUPPORTED_ENCODING')) return t('editor.encoding');
  if (message.includes('EDITOR_FILE_TOO_LARGE')) return t('editor.too_large');
  if (message.includes('EDITOR_PATH_OUTSIDE_WORKSPACE')) return t('editor.outside_workspace');
  if (message.includes('EDITOR_FILE_UNAVAILABLE')) return t('editor.file_unavailable');
  if (message.includes('EDITOR_WORKSPACE_UNAVAILABLE')) return t('editor.workspace_unavailable');
  if (message.includes('EDITOR_NOT_A_FILE')) return t('editor.not_a_file');
  if (message.includes('EDITOR_REPLACE_FAILED')) return t('editor.replace_failed');
  if (message.includes('EDITOR_PERMISSION_COPY_FAILED')) return t('editor.permission_copy_failed');
  if (message.includes('EDITOR_PARENT_UNAVAILABLE')) return t('editor.parent_unavailable');
  if (message.includes('EDITOR_TEMP_CREATE_FAILED')) return t('editor.temp_create_failed');
  if (message.includes('EDITOR_WRITE_FAILED')) return t('editor.write_failed');
  if (message.includes('EDITOR_FLUSH_FAILED')) return t('editor.flush_failed');
  if (message.includes('EDITOR_READ_FAILED')) return t('editor.read_failed');
  return message.replace(/^Error:\s*/, '') || t('editor.read_failed');
}

export function EditorSurface({ tabId, path, workspaceRoot, isActive }: EditorSurfaceProps) {
  const { state, dispatch } = useAppState();
  const t = useT();
  const tab = state.editorTabs.find(item => item.id === tabId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const documentRef = useRef<EditorDocument | null>(null);
  const savingRef = useRef(false);
  const revisionRef = useRef('');
  const lineEndingRef = useRef<'lf' | 'crlf' | 'mixed'>('lf');
  const bomRef = useRef(false);
  const externalChangedRef = useRef(false);
  const applyingSnapshotRef = useRef(false);
  const mountedRef = useRef(true);
  const isActiveRef = useRef(isActive);
  const loadGenerationRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const pathKey = useMemo(() => editorKey(path), [path]);

  const setDirty = useCallback((dirty: boolean) => {
    dispatch({ type: 'SET_EDITOR_DIRTY', id: tabId, dirty });
  }, [dispatch, tabId]);

  const loadFile = useCallback(async (editor: monaco.editor.IStandaloneCodeEditor, monacoApi: typeof monaco) => {
    const loadGeneration = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await commands.readEditorFile(path, workspaceRoot);
      const language = languageForPath(path);
      await ensureLanguage(language);
      if (!mountedRef.current || loadGeneration !== loadGenerationRef.current) return;
      const existing = documents.get(pathKey);
      const previousModel = editor.getModel();
      const model = existing?.model ?? monacoApi.editor.createModel(
        snapshot.content,
        language,
        monacoApi.Uri.file(path),
      );
      if (existing?.model && existing.snapshot.revision !== snapshot.revision && !tab?.dirty) {
        applyingSnapshotRef.current = true;
        try {
          existing.model.setValue(snapshot.content);
        } finally {
          applyingSnapshotRef.current = false;
        }
      }
      const keepLocalDocument = Boolean(existing && tab?.dirty);
      const effectiveSnapshot = keepLocalDocument
        ? existing!.snapshot
        : { ...snapshot, content: model.getValue() };
      const document: EditorDocument = {
        snapshot: effectiveSnapshot,
        model,
        viewState: existing?.viewState ?? null,
      };
      documents.set(pathKey, document);
      documentRef.current = document;
      revisionRef.current = effectiveSnapshot.revision;
      lineEndingRef.current = effectiveSnapshot.line_ending;
      bomRef.current = effectiveSnapshot.has_utf8_bom;
      externalChangedRef.current = Boolean(tab?.externalChanged);
      if (!keepLocalDocument) dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: false });
      setDirty(model.getValue() !== effectiveSnapshot.content);
      setNotice(effectiveSnapshot.line_ending === 'mixed' ? t('editor.mixed_line_endings') : null);
      editor.setModel(model);
      if (previousModel && previousModel !== model) previousModel.dispose();
      if (document.viewState) editor.restoreViewState(document.viewState);
      if (isActiveRef.current) editor.focus();
    } catch (loadError) {
      if (mountedRef.current && loadGeneration === loadGenerationRef.current) {
        setError(formatError(loadError, t));
      }
    } finally {
      if (mountedRef.current && loadGeneration === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [dispatch, path, pathKey, setDirty, t, tab?.dirty, tab?.externalChanged, tabId, workspaceRoot]);

  const handleMount: OnMount = useCallback((editor, monacoApi) => {
    editorRef.current = editor;
    monacoRef.current = monacoApi;
    void loadFile(editor, monacoApi);
  }, [loadFile]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    const document = documentRef.current;
    if (!editor || !document || savingRef.current) return;
    if (externalChangedRef.current) {
      setNotice(t('editor.external_save_blocked'));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    const savedContent = document.model.getValue();
    try {
      const response = await commands.writeEditorFile(
        path,
        workspaceRoot,
        savedContent,
        revisionRef.current,
        lineEndingRef.current,
        bomRef.current,
      );
      if (response.status === 'conflict') {
        externalChangedRef.current = true;
        if (mountedRef.current) {
          dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: true });
          setNotice(t('editor.external_conflict'));
        }
        return;
      }
      revisionRef.current = response.revision;
      const savedLineEnding = lineEndingRef.current === 'mixed' ? 'lf' : lineEndingRef.current;
      lineEndingRef.current = savedLineEnding;
      document.snapshot = {
        ...document.snapshot,
        content: savedContent,
        revision: response.revision,
        line_ending: savedLineEnding,
        size: response.size,
      };
      if (mountedRef.current && !document.model.isDisposed()) {
        setDirty(document.model.getValue() !== savedContent);
      }
      const parentDir = path.replace(/[\\/][^\\/]+$/, '') || workspaceRoot;
      window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath: parentDir } }));
      if (mountedRef.current) {
        setNotice(t('editor.saved'));
        window.setTimeout(() => {
          if (mountedRef.current) {
            setNotice(current => current === t('editor.saved') ? null : current);
          }
        }, 1400);
      }
    } catch (saveError) {
      if (mountedRef.current) setNotice(formatError(saveError, t));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [dispatch, path, setDirty, t, tabId, workspaceRoot]);

  const reloadFromDisk = useCallback(async () => {
    const document = documentRef.current;
    if (!document) return;
    if (tab?.dirty && !window.confirm(t('editor.reload_confirm'))) return;
    setNotice(null);
    try {
      const snapshot = await commands.readEditorFile(path, workspaceRoot);
      if (!mountedRef.current || document.model.isDisposed()) return;
      applyingSnapshotRef.current = true;
      try {
        document.model.setValue(snapshot.content);
      } finally {
        applyingSnapshotRef.current = false;
      }
      document.snapshot = { ...snapshot, content: document.model.getValue() };
      revisionRef.current = snapshot.revision;
      lineEndingRef.current = snapshot.line_ending;
      bomRef.current = snapshot.has_utf8_bom;
      externalChangedRef.current = false;
      dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: false });
      setDirty(false);
      setNotice(snapshot.line_ending === 'mixed' ? t('editor.mixed_line_endings') : null);
    } catch (reloadError) {
      setNotice(formatError(reloadError, t));
    }
  }, [dispatch, path, setDirty, t, tab?.dirty, tabId, workspaceRoot]);

  useEffect(() => {
    if (!isActive) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isActive, save]);

  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) editorRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ dirPath?: string }>).detail;
      if (!detail?.dirPath || !isPathInside(path, detail.dirPath)) return;
      if (savingRef.current) return;
      if (!documentRef.current) return;
      const refreshGeneration = ++refreshGenerationRef.current;
      void commands.readEditorFile(path, workspaceRoot).then(snapshot => {
        if (!mountedRef.current || refreshGeneration !== refreshGenerationRef.current) return;
        if (snapshot.revision === revisionRef.current) return;
        const document = documentRef.current;
        if (document && !document.model.isDisposed() && document.model.getValue() === document.snapshot.content) {
          applyingSnapshotRef.current = true;
          try {
            document.model.setValue(snapshot.content);
          } finally {
            applyingSnapshotRef.current = false;
          }
          revisionRef.current = snapshot.revision;
          document.snapshot = { ...snapshot, content: document.model.getValue() };
          lineEndingRef.current = snapshot.line_ending;
          bomRef.current = snapshot.has_utf8_bom;
          externalChangedRef.current = false;
          dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: false });
          setNotice(snapshot.line_ending === 'mixed' ? t('editor.mixed_line_endings') : null);
          setDirty(false);
          return;
        }
        externalChangedRef.current = true;
        dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: true });
        setNotice(t('editor.external_changed'));
      }).catch(error => {
        if (!mountedRef.current || refreshGeneration !== refreshGenerationRef.current) return;
        externalChangedRef.current = true;
        dispatch({ type: 'SET_EDITOR_EXTERNAL_CHANGED', id: tabId, externalChanged: true });
        setNotice(formatError(error, t));
      });
    };
    window.addEventListener('fs-refresh', onRefresh);
    return () => window.removeEventListener('fs-refresh', onRefresh);
  }, [dispatch, path, setDirty, t, tabId, workspaceRoot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      refreshGenerationRef.current += 1;
      const document = documentRef.current;
      const editor = editorRef.current;
      if (document && editor && !document.model.isDisposed()) {
        document.viewState = editor.saveViewState();
      }
      document?.model.dispose();
      documents.delete(pathKey);
    };
  }, [pathKey]);

  if (!tab) return null;
  return (
    <div className="editor-surface">
      <div className="editor-toolbar">
        <div className="editor-file-meta">
          <span className="editor-file-name">{basename(path)}</span>
          <span className="editor-file-path">{path}</span>
          {tab.dirty && <span className="editor-dirty-dot" title={t('editor.unsaved')} />}
        </div>
        <div className="editor-toolbar-actions">
          {notice && <span className={`editor-notice${tab.externalChanged || notice === t('editor.external_save_blocked') || notice === t('editor.external_conflict') ? ' editor-notice-warning' : ''}`}>{notice}</span>}
          {tab.externalChanged && (
             <button type="button" className="editor-reload-btn" onClick={() => void reloadFromDisk()}>{t('editor.reload')}</button>
          )}
           <button type="button" className="editor-save-btn" onClick={() => void save()} disabled={saving || !tab.dirty}>
             {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </div>
      </div>
      <div className="editor-body">
        <Editor
          theme={state.currentTheme === 'light' ? 'vs' : 'vs-dark'}
          defaultLanguage="plaintext"
          defaultValue=""
          onMount={handleMount}
          onChange={(value) => {
            if (applyingSnapshotRef.current) return;
            const document = documentRef.current;
            setDirty(Boolean(document && value !== document.snapshot.content));
          }}
          options={{
            automaticLayout: true,
            fontFamily: state.termFont || 'Cascadia Code, Cascadia Mono, Consolas, monospace',
            fontSize: 13,
            minimap: { enabled: false },
            padding: { top: 12, bottom: 18 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            wordWrap: 'off',
          }}
        />
        {loading && <div className="editor-overlay">{t('editor.reading')}</div>}
        {error && (
          <div className="editor-error">
            <div>{error}</div>
            <button type="button" onClick={() => {
              const editor = editorRef.current;
              const monaco = monacoRef.current;
              if (editor && monaco) void loadFile(editor, monaco);
             }}>{t('editor.retry')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
