import { defineTool } from '@deepseek-ai/dsh-tools';
import { createClient } from './client.js';
import { homeDir, settings } from './paths.js';
import { DESCRIPTION, parameters } from './actions.js';
import { zhihuToolContent } from './tool-content.js';

export const name = 'dsh-zhihu';
export const inject = ['tools', 'attachments'];
export function nativeDefinition({ stateDir = homeDir(), call = createClient({ stateDir }), attachments } = {}) {
  return {
    name: 'zhihu_browse', description: DESCRIPTION, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => zhihuToolContent(value) },
    async execute({ action, ...args }, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId || !settings(stateDir).allowedSessionIds?.includes(sessionId)) throw new Error('此 DSH 会话尚未获得知乎授权，请由管理员在知乎管理页添加真实会话 ID');
      exec?.signal?.throwIfAborted();
      const data = await call(action, args, exec?.signal);
      const { imageContent = [], ...rest } = data;
      if (!imageContent.length) return rest;
      if (!attachments?.saveImages) return { ...rest, imagePage: { ...rest.imagePage, loaded: 0 },
        images: (rest.images || []).map(image => ({ ...image, loaded: false, error: 'DSH 附件服务不可用，未交付图像' })),
        imageNote: 'DSH 附件服务不可用，本次仅返回文字，不可声称看过图片。' };
      try {
        const refs = await attachments.saveImages(imageContent.map(image => ({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType, name: `zhihu-image-${image.index}` })));
        exec?.signal?.throwIfAborted();
        return { ...rest, imageAttachments: refs.map((attachment, i) => ({ index: imageContent[i].index, attachment })) };
      } catch (error) {
        exec?.signal?.throwIfAborted();
        return { ...rest, imagePage: { ...rest.imagePage, loaded: 0 },
          images: (rest.images || []).map(image => ({ ...image, loaded: false, error: 'DSH 图片附件接收失败' })),
          imageNote: '图片未被 DSH 接收，本次仅有正文文字，不可声称看过图片。' };
      }
    },
  };
}
export function apply(ctx) { ctx.tools.register(defineTool(nativeDefinition({ attachments: ctx.attachments }))); }
