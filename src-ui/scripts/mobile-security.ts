// Shared by the deployed website and its local fixture server. Image decoding
// and attachment previews both use object URLs, so blob: is required here.
export const phoneCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' data:; font-src 'self'; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
export const previewCsp = phoneCsp.replace("connect-src 'self' wss:", "connect-src 'self' ws: wss:").replace("; frame-ancestors 'none'", '');
