import type { FilePreview } from '../shared/types';

type ImageSource = { kind: 'direct'; url: string } | { kind: 'local'; path: string } | { kind: 'unsupported' };
const imageData = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[a-z\d+/]+={0,2}$/i;

export function markdownImageSource(value: string): ImageSource {
  const source = value.trim();
  if (!source || /[\x00-\x1f]/.test(source)) return { kind: 'unsupported' };
  if (imageData.test(source)) return { kind: 'direct', url: source };
  if (/^https?:\/\//i.test(source)) {
    try { return { kind: 'direct', url: new URL(source).href }; } catch { return { kind: 'unsupported' }; }
  }
  if (/^[\\/]{2}/.test(source) || /^[a-z][a-z\d+.-]*:/i.test(source) && !/^(file:|[a-z]:[/\\])/i.test(source)) return { kind: 'unsupported' };
  return { kind: 'local', path: source };
}

export async function loadMarkdownImage(source: string, sessionId: string | undefined, preview: (id: string, path: string) => Promise<FilePreview>) {
  const image = markdownImageSource(source);
  if (image.kind === 'direct') return image.url;
  if (image.kind === 'unsupported') throw new Error('图片地址为空或不受支持');
  if (!sessionId) throw new Error('请在所属会话中查看本机图片');
  const file = await preview(sessionId, image.path);
  if (file.size > 5 * 1024 * 1024) throw new Error('图片超过 5 MB，请从会话文件中打开');
  if (file.type !== 'image' || file.truncated || !imageData.test(file.content)) throw new Error('此文件不是可预览的图片，支持 PNG、JPEG、GIF、WebP 和 SVG');
  return file.content;
}
