export type NotificationPreference = 'done' | 'wait' | 'badge' | 'backgroundOnly';
const settingsListeners = new Set<() => void>();
export function notificationEnabled(key: NotificationPreference): boolean {
  try { return localStorage.getItem(`sinos-notify-${key}`) !== 'false'; } catch { return true; }
}
export function setNotificationPreference(key: NotificationPreference, enabled: boolean) {
  localStorage.setItem(`sinos-notify-${key}`, String(enabled));
  settingsListeners.forEach(listener => listener());
}
export const notificationCopy = {
  'zh-CN': { heading: '桌面通知', done: '任务完成时弹出通知', wait: '需要回答或授权时弹出通知', badge: '任务栏显示未读完成数量', backgroundOnly: '仅提醒当前未查看的会话', on: '开启', off: '关闭', test: '测试 Windows 通知', clear: '清除完成计数', sent: '测试通知已提交给 Windows', blocked: '请在 Windows 通知设置中允许 Sinos CLI 通知', failed: '操作失败，请重试', complete: '任务完成', question: '需要你的回答', detail: '点击返回对应会话', badgeHint: '后台会话完成后累加计数，查看对应会话后清除。', hint: '后台会话完成后累加计数，查看对应会话后清除。系统弹窗使用 Windows 通知设置。', preview: 'Sinos CLI 通知已准备就绪' },
  'zh-TW': { heading: '桌面通知', done: '工作完成時彈出通知', wait: '需要回答或授權時彈出通知', badge: '工作列顯示未讀完成數量', backgroundOnly: '僅提醒目前未查看的工作階段', on: '開啟', off: '關閉', test: '測試 Windows 通知', clear: '清除完成計數', sent: '測試通知已提交給 Windows', blocked: '請在 Windows 通知設定中允許 Sinos CLI 通知', failed: '操作失敗，請重試', complete: '工作完成', question: '需要你的回答', detail: '點擊返回對應工作階段', badgeHint: '背景工作完成後累加計數，查看對應工作階段後清除。', hint: '背景工作完成後累加計數，查看對應工作階段後清除。系統彈窗使用 Windows 通知設定。', preview: 'Sinos CLI 通知已準備就緒' },
  en: { heading: 'Desktop notifications', done: 'Notify when a task completes', wait: 'Notify when an answer or approval is needed', badge: 'Show unread completions on the taskbar', backgroundOnly: 'Only notify for conversations outside your current view', on: 'On', off: 'Off', test: 'Test Windows notification', clear: 'Clear completion count', sent: 'Test notification submitted to Windows', blocked: 'Allow Sinos CLI notifications in Windows settings', failed: 'Operation failed. Please retry.', complete: 'Task completed', question: 'Your answer is needed', detail: 'Click to return to the conversation', badgeHint: 'Background completions increase the count. Viewing a conversation clears its count.', hint: 'Background completions increase the count. Viewing a conversation clears its count. Popups follow Windows notification settings.', preview: 'Sinos CLI notifications are ready' },
  ja: { heading: 'デスクトップ通知', done: 'タスク完了時に通知', wait: '回答や承認が必要なときに通知', badge: 'タスクバーに未読の完了件数を表示', backgroundOnly: '現在表示していない会話のみ通知', on: 'オン', off: 'オフ', test: 'Windows 通知をテスト', clear: '完了件数をクリア', sent: 'テスト通知を Windows に送信しました', blocked: 'Windows の設定で Sinos CLI の通知を許可してください', failed: '操作に失敗しました。再試行してください。', complete: 'タスクが完了しました', question: '回答が必要です', detail: 'クリックして会話に戻る', badgeHint: '背景で完了した件数を表示し、会話を開くとクリアします。', hint: '背景で完了した件数を表示し、会話を開くとクリアします。通知は Windows の設定に従います。', preview: 'Sinos CLI の通知の準備ができました' },
  ko: { heading: '데스크톱 알림', done: '작업 완료 시 알림', wait: '답변이나 승인이 필요할 때 알림', badge: '작업 표시줄에 읽지 않은 완료 수 표시', backgroundOnly: '현재 보고 있지 않은 대화만 알림', on: '켜기', off: '끄기', test: 'Windows 알림 테스트', clear: '완료 수 지우기', sent: '테스트 알림을 Windows에 전송했습니다', blocked: 'Windows 설정에서 Sinos CLI 알림을 허용하세요', failed: '작업에 실패했습니다. 다시 시도하세요.', complete: '작업 완료', question: '답변이 필요합니다', detail: '클릭하여 해당 대화로 돌아가기', badgeHint: '백그라운드 완료 수를 표시하며 해당 대화를 열면 지워집니다.', hint: '백그라운드 완료 수를 표시하며 해당 대화를 열면 지워집니다. 팝업은 Windows 알림 설정을 따릅니다.', preview: 'Sinos CLI 알림이 준비되었습니다' },
};
export const desktopCopy = (language: string) => notificationCopy[language as keyof typeof notificationCopy] ?? notificationCopy.en;


export function subscribeNotificationPreferences(listener: () => void) { settingsListeners.add(listener); return () => { settingsListeners.delete(listener); }; }
