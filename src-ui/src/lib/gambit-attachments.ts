export interface GambitAttachment {
  path: string;
  start: number;
  end: number;
  image: boolean;
}

// Quoted paths include spaces; bare paths must end in a file extension.
// Keep source ranges so removing a chip also removes its actual prompt token.
export function gambitAttachments(draft: string): GambitAttachment[] {
  const pattern = /"((?:[A-Za-z]:[\\/]|\/|\\\\)[^"\r\n]+)"|'((?:[A-Za-z]:[\\/]|\/|\\\\)[^'\r\n]+)'|(?:(?<!\w)[A-Za-z]:[\\/]|(?<![\w:/])\/|\\\\)[^\s<>"'`]+?\.[\w]+(?=$|[\s<>"'`])/g;
  return Array.from(draft.matchAll(pattern), match => {
    const path = match[1] ?? match[2] ?? match[0];
    return { path, start: match.index, end: match.index + match[0].length, image: /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) };
  });
}

export function removeGambitAttachment(draft: string, path: string): string {
  for (const item of gambitAttachments(draft).reverse()) {
    if (item.path === path) draft = draft.slice(0, item.start) + draft.slice(item.end);
  }
  return draft;
}
