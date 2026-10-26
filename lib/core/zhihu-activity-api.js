import crypto from 'node:crypto';
import { htmlText } from './zhihu-content-evidence.js';
const ORIGIN = 'https://www.zhihu.com';
const VERBS = new Map([['MEMBER_VOTEUP_ANSWER', 'answer'], ['ANSWER_VOTE_UP', 'answer'], ['MEMBER_VOTEUP_ARTICLE', 'article'], ['MEMBER_VOTE_PIN', 'pin']]);
export function profileToken(profileUrl) {
  const u = new URL(profileUrl);
  const m = u.pathname.match(/^\/people\/([A-Za-z0-9_-]+)$/);
  if (u.origin !== ORIGIN || u.username || u.password || u.port || u.search || u.hash || !m) throw new Error('目标主页配置无效');
  return m[1];
}
export function activityPath(profileUrl) { return `/api/v3/moments/${profileToken(profileUrl)}/activities?limit=20&desktop=true`; }
function id(value, raw, kind) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  try { const u = new URL(raw); if (u.protocol === 'https:' && !u.port && !u.username && !u.password && ['www.zhihu.com','api.zhihu.com','zhuanlan.zhihu.com'].includes(u.hostname)) return u.pathname.match(new RegExp(`/(?:${kind}/|p/)([1-9]\\d*)$`))?.[1]; } catch {}
  return null;
}
export function normalizeApiActivities(body, profileUrl) {
  const token = profileToken(profileUrl);
  if (!Array.isArray(body?.data) || !body.paging || typeof body.paging.is_end !== 'boolean') throw new Error('知乎动态接口未返回有效分页，不把异常空数组当成没有点赞');
  const out = [], seen = new Set();
  for (const row of body.data) {
    if (row?.actor?.url_token !== token) throw new Error('知乎动态接口返回的用户身份不符，停止读取');
    const kind = VERBS.get(row.verb), target = row.target;
    if (!kind) continue;
    if (target?.type !== kind) throw new Error('知乎点赞动作与内容类型不符');
    const tid = id(target.id, target.url, kind === 'answer' ? 'answers' : kind === 'article' ? 'articles' : 'pins');
    const qid = kind === 'answer' ? id(target.question?.id, target.question?.url, 'questions') : null;
    if (!tid || kind === 'answer' && !qid) throw new Error('知乎点赞内容缺少精确标识，停止读取');
    const url = kind === 'answer' ? `${ORIGIN}/question/${qid}/answer/${tid}` : kind === 'article' ? `https://zhuanlan.zhihu.com/p/${tid}` : `${ORIGIN}/pin/${tid}`;
    const key = crypto.createHash('sha256').update(profileUrl + '\nlike\n' + url).digest('hex');
    if (seen.has(key)) continue; seen.add(key);
    const created = Number(row.created_time), at = Number.isSafeInteger(created) && created > 0 ? new Date(created * 1000).toISOString() : '';
    const pinText = kind === 'pin' && Array.isArray(target.content) ? target.content.map(x => x.content || x.text || '').join('\n') : '';
    out.push({ id: key, action: kind === 'pin' ? '点赞' : '赞同', contentType: kind, url,
      title: htmlText(target.question?.title || target.title || target.excerpt_title || '').slice(0,500),
      summary: htmlText(target.excerpt || target.preview_text || pinText || (typeof target.content === 'string' ? target.content : '')).slice(0,3000),
      timeLabel: at, ...(at ? { actedAt: created * 1000 } : {}), profileUrl });
  }
  return out;
}
export function nextActivityPath(raw, profileUrl) {
  const u = new URL(raw), token = profileToken(profileUrl);
  if (u.origin !== ORIGIN || u.port || u.username || u.password || u.hash || u.pathname !== `/api/v3/moments/${token}/activities`) throw new Error('知乎动态分页地址越界，停止读取');
  const allowed = new Set(['offset','page_num','limit','desktop','after_id']);
  if ([...u.searchParams.keys()].some(k => !allowed.has(k)) || u.search.length > 2048 || [...u.searchParams.values()].some(v => !/^[A-Za-z0-9_.:-]{1,512}$/.test(v))) throw new Error('知乎动态分页参数异常，停止读取');
  return u.pathname + u.search;
}
