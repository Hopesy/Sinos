export function defaultDeviceName(userAgent: string, native: boolean) {
  if (native) return 'Android · Sinos App';
  const device = /iPad/.test(userAgent) ? 'iPad' : /iPhone/.test(userAgent) ? 'iPhone' : /Android/.test(userAgent) ? 'Android' : '我的设备';
  const browser = /Edg(?:A|iOS)?\//.test(userAgent) ? 'Edge' : /SamsungBrowser\//.test(userAgent) ? '三星浏览器' : /Firefox\/|FxiOS\//.test(userAgent) ? 'Firefox' : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '浏览器';
  return `${device} · ${browser}`;
}
