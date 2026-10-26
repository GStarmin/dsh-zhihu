// Zhihu HTTP sessions, QR login and activity reading. No browser implementation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { http } from './zhihu-http.js';
import { makeZhihuSelfBrowse } from './zhihu-self-browse.js';
import { makeZhihuAccessGate, savePrivateJson, ZhihuAccessError } from './zhihu-access.js';
import { makeZhihuDirectAPI } from './zhihu-direct-api.js';
import { makeZhihuMediaStorage } from './zhihu-media-storage.js';
export { normalizeApiActivities } from './zhihu-activity-api.js';
const ORIGIN = 'https://www.zhihu.com', QR = '/api/v3/account/api/login/qrcode';
export function makeZhihuActivityReader({ stateDir, now = Date.now, interactionPolicy = () => ({ enabled: false }), requestFactory = http, voteConfirmation = {}, imageLoader } = {}) {
  const media = makeZhihuMediaStorage({ stateDir, now });
  const sessionFile = path.join(stateDir, 'zhihu-activity-session.json'), metaFile = path.join(stateDir, 'zhihu-activity-login.json');
  const loginAccess = makeZhihuAccessGate({ stateDir, now, fileName: 'zhihu-login-api-access.json', channel: '登录接口' });
  const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('知乎登录状态不可读'); } };
  let login = null, cache = null, closed = false;
  const api = makeZhihuDirectAPI({ ...voteConfirmation, stateDir, now, requestFactory, unavailable: () => !!login && ['starting','waiting_for_scan'].includes(login.state) });
  async function fail(current, error) {
    if (login !== current) return;
    current.cancelled = true; current.state = 'failed'; current.error = error instanceof ZhihuAccessError ? error.message : '登录接口暂不可用，请查看账号状态后再试';
    if (error instanceof ZhihuAccessError) loginAccess.record(error);
    delete current.qrImage; clearTimeout(current.timer); await current.context?.dispose().catch(() => {});
  }
  async function closeLogin() {
    const old = login; login = null;
    if (old) { old.cancelled = true; clearTimeout(old.timer); await old.context?.dispose().catch(() => {}); }
  }
  async function loginSend(current, endpoint, method = 'GET') {
    if (login !== current || current.cancelled || closed) throw new Error('登录流程已取消');
    loginAccess.assertAllowed();
    const state = await current.context.storageState(), xsrf = state.cookies?.find(x => x.name === '_xsrf')?.value;
    const response = await current.context.fetch(ORIGIN + endpoint, { method, ...(method === 'POST' ? { data: {} } : {}), headers: xsrf ? { 'x-xsrftoken': xsrf } : {}, timeout: 10000, maxRedirects: 0, maxRetries: 0 });
    const status = response.status(); let body; try { body = JSON.parse(await response.text()); } catch {}
    if ([401,403,429].includes(status) || [40362,62].includes(Number(body?.error?.code))) {
      throw new ZhihuAccessError(status === 401 ? 'LOGIN_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'ACCESS_DENIED', `知乎登录接口拒绝本次请求（HTTP ${status}${body?.error?.code ? `，错误码 ${body.error.code}` : ''}），已暂停；不会自动重试`, { httpStatus: status, businessCode: body?.error?.code ?? null });
    }
    if (status < 200 || status >= 300 || body?.error) throw new Error('登录接口返回异常');
    return body;
  }
  async function pollLogin(current) {
    if (current.polling || now() - current.lastPollAt < 3000) return;
    current.lastPollAt = now(); current.polling = true;
    try {
      const info = await loginSend(current, QR + '/' + encodeURIComponent(current.token) + '/scan_info');
      if (login !== current) return;
      let state = await current.context.storageState();
      if (!state.cookies?.some(x => x.name === 'z_c0') && (info?.z_c0 || typeof info?.cookie === 'string')) {
        const cookies = info.z_c0 ? [{ name: 'z_c0', value: String(info.z_c0) }] : info.cookie.split(';').map(x => { const n=x.indexOf('='); return { name:x.slice(0,n).trim(),value:x.slice(n+1).trim() }; }).filter(x=>['z_c0','_xsrf','d_c0','q_c1'].includes(x.name));
        if (current.context.addCookies) await current.context.addCookies(cookies.map(x => ({...x,domain:'.zhihu.com',path:'/',secure:true,httpOnly:true})));
        state = await current.context.storageState();
      }
      if (!state.cookies?.some(x => x.name === 'z_c0')) {
        if ([0,1].includes(info?.status)) { current.scanned = info.status === 1; return; }
        if (info?.status === 4 || /EXPIRED|INVALID/.test(String(info?.login_status || ''))) throw new Error('二维码已过期');
        if (!info?.access_token && !info?.user_id && info?.success !== true) throw new Error('扫码接口返回格式异常');
        return;
      }
      const me = await loginSend(current, '/api/v4/me');
      if (!/^[A-Za-z0-9_-]+$/.test(me?.url_token || '')) throw new Error('未核实登录账号');
      if (login !== current) return;
      state = await current.context.storageState();
      savePrivateJson(sessionFile, state);
      savePrivateJson(metaFile, { saved:true,account:{name:String(me.name || ''),profileUrl:ORIGIN+'/people/'+me.url_token},savedAt:now(),sessionId:crypto.randomUUID() });
      api.verifiedLogin(); cache = null; await closeLogin();
    } catch (error) { await fail(current,error); }
    finally { current.polling = false; }
  }
  async function status() {
    if (login?.state === 'waiting_for_scan') await pollLogin(login);
    const meta = json(metaFile);
    return { ok:true,mediaStorage:media.status(),saved:fs.existsSync(sessionFile)&&meta?.saved===true,account:meta?.account||null,savedAt:meta?.savedAt||null,
      loginState:login?.state||'idle',error:login?.error||null,scanned:login?.scanned||false,browserRequired:false,
      access:{blocked:false,retired:true},apiAccess:api.status(),accessScopes:{...api.scopedStatus(),login:loginAccess.status()},voteChecks:api.voteStatus(),
      transports:{login:'website-api',homeFeed:'website-api',answerBody:'website-api',answerUpvote:'website-api',articleBody:'website-api',articleUpvote:'website-api',ownerActivity:'website-api'},
      ...(login?.qrImage?{qrImage:login.qrImage}:{}) };
  }
  async function startLogin() {
    if (closed || api.busy) throw new Error('知乎会话正在使用，请稍后登录');
    loginAccess.assertAllowed(); await closeLogin();
    const current={state:'starting',context:null,lastPollAt:now()-3000}; login=current;
    current.timer=setTimeout(()=>fail(current,new Error('二维码已过期')).catch(()=>{}),240000); current.timer.unref();
    (async()=>{
      try {
        current.context=await requestFactory.newContext({timeout:10000,maxRedirects:0,userAgent:'dsh-zhihu/0.1',extraHTTPHeaders:{accept:'application/json',origin:ORIGIN,referer:ORIGIN+'/signin'}});
        if (login!==current || current.cancelled || closed) {await current.context.dispose();return;}
        await loginSend(current,'/signin');
        await loginSend(current,'/udid','POST');
        const challenge = await loginSend(current,'/api/v3/oauth/captcha/v2?type=captcha_sign_in');
        if (challenge?.show_captcha === true || challenge?.showCaptcha === true) throw new ZhihuAccessError('VERIFICATION_REQUIRED','知乎要求本人完成登录验证，已暂停扫码接口；不会代解验证码');
        const data=await loginSend(current,QR,'POST'), token=data?.token||data?.qrcode_token;
        if (!/^[A-Za-z0-9_-]{8,512}$/.test(token||'')) throw new Error('二维码凭证无效');
        const link=new URL(data.link);
        if (link.protocol!=='https:'||link.hostname!=='www.zhihu.com'||link.username||link.password||link.port) throw new Error('二维码来源异常');
        current.token=token; const qr=await QRCode.toDataURL(link.href,{type:'image/png',width:256,margin:2});
        if(login!==current)return;
        current.qrImage=qr;current.state='waiting_for_scan';
      }catch(error){await fail(current,error)}
    })();
    return {ok:true,loginState:'starting'};
  }
  async function read(profileUrl) {
    const meta=json(metaFile); api.status('activity');
    if(api.scopedStatus().account.blocked||api.status('activity').blocked) return api.activity(profileUrl);
    if(cache&&cache.profileUrl===profileUrl&&cache.sessionId===meta?.sessionId&&now()-cache.at<120000)return {...cache.value,cached:true};
    const value=await api.activity(profileUrl);cache={profileUrl,sessionId:meta.sessionId,at:now(),value};return {...value,cached:false};
  }
  const self=makeZhihuSelfBrowse({stateDir,now,currentSession:()=>json(metaFile),interactionPolicy,answerAPI:api,imageLoader:imageLoader||media.loadImages});
  async function logout(){if(api.busy)throw new Error('知乎会话正在使用，请稍后退出');await closeLogin();cache=null;fs.rmSync(sessionFile,{force:true});fs.rmSync(metaFile,{force:true});return {ok:true,saved:false};}
  async function resumeAccess(){if(api.busy||login?.polling)throw new Error('知乎会话正在使用，请稍后恢复');loginAccess.resume();const r=api.resume();return {...r,access:{blocked:false,retired:true},note:'仅恢复程序访问权限，不代表知乎服务器限制解除。'};}
  return {status,startLogin,read,logout,self,resumeAccess,reconcileVotes:options=>api.reconcile(options),close:async()=>{closed=true;await closeLogin();await api.close();}};
}
