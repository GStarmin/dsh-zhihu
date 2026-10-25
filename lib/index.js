import { defineTool } from '@deepseek-ai/dsh-tools';
import { createClient } from './client.js';
import { homeDir, settings } from './paths.js';
import { DESCRIPTION, parameters } from './actions.js';

export const name = 'dsh-zhihu';
export const inject = ['tools'];
export function nativeDefinition({ stateDir = homeDir(), call = createClient({ stateDir }) } = {}) {
  return {
    name: 'zhihu_browse', description: DESCRIPTION, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ action, ...args }, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId || !settings(stateDir).allowedSessionIds?.includes(sessionId)) throw new Error('此 DSH 会话尚未获得知乎授权，请由管理员在知乎管理页添加真实会话 ID');
      exec?.signal?.throwIfAborted();
      return call(action, args, exec?.signal);
    },
  };
}
export function apply(ctx) { ctx.tools.register(defineTool(nativeDefinition())); }
