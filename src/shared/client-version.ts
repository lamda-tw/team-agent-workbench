import { version } from '../../package.json';

// Bundled with the client, so an already-open window keeps its own version.
export const clientVersion = version;
export const clientWindowTitle = (edition: '用户版' | '管理员版') => `团队工作台 · ${edition} · v${clientVersion}`;
