const $ = id => document.getElementById(id);
let adminToken = '', poll;
async function api(path, data) {
  const r = await fetch(path, { method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + adminToken, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const out = await r.json(); if (!r.ok || !out.ok) throw new Error(out.error || '请求失败'); return out;
}
async function refresh() {
  clearTimeout(poll);
  const s = await api('/api/status'), web = s.web || {};
  $('status').textContent = JSON.stringify({ officialApi: s.configured, webAccount: web.account, savedLogin: web.saved, loginState: web.loginState, loginError: web.error, websiteApiAccess: web.apiAccess, accessScopes: web.accessScopes, browserRequired: web.browserRequired, transports: web.transports, voteChecks: web.voteChecks, mediaStorage: web.mediaStorage, ownerWatch: s.ownerWatch, activityWatch: s.activityWatch }, null, 2);
  const storage = web.mediaStorage;
  const size = bytes => (Number(bytes || 0) / 1024 / 1024).toFixed(2) + ' MiB';
  $('mediaStorage').textContent = storage
    ? '知乎临时文件：' + size(storage.temporary.bytes) + (storage.temporary.partial ? '（部分统计）' : '')
      + '；DSH 共享聊天附件：' + (storage.attachments.error ? '暂不可统计' : size(storage.attachments.bytes)) + (storage.attachments.partial ? '（部分统计）' : '')
      + '。正常处理后清理临时文件；启动和读图时清理超过 24 小时的遗留工作目录。共享附件仍可能被历史引用，不自动删除。'
      + (storage.temporary.error ? ' 临时清理提示：' + storage.temporary.error : '')
    : '当前服务尚未报告图片存储占用。';
  $('sessions').value = (s.settings.allowedSessionIds || []).join('\n');
  $('upvote').checked = s.settings.upvote?.enabled === true;
  if (!$('profileUrl').value) $('profileUrl').value = s.activityWatch.profileUrl || s.ownerWatch.profileUrl || '';
  $('qr').hidden = !/^data:image\/png;base64,/.test(web.qrImage || '');
  if (!$('qr').hidden) $('qr').src = web.qrImage; else $('qr').removeAttribute('src');
  if (['starting', 'waiting_for_scan'].includes(web.loginState)) poll = setTimeout(() => refresh().catch(showError), 3000);
  return s;
}
function showError(e) { $('message').textContent = e.message; }
async function admin(action, args = {}) { const r = await api('/api/admin', { action, args }); $('message').textContent = r.note || '操作成功'; await refresh(); }
function bind(id, fn) { $(id).addEventListener('click', async () => { const b = $(id); b.disabled = true; try { await fn(); } catch (e) { showError(e); } finally { b.disabled = false; } }); }
bind('login', async () => { adminToken = $('adminToken').value.trim(); $('adminToken').value = ''; await refresh(); $('message').textContent = '管理页已连接'; });
bind('refresh', refresh);
for (const b of document.querySelectorAll('[data-action]')) b.addEventListener('click', async () => { b.disabled = true; try { await admin(b.dataset.action); } catch (e) { showError(e); } finally { b.disabled = false; } });
bind('saveBot', async () => { const accessSecret = $('botSecret').value; try { await admin('configure_api', { accessSecret }); } finally { $('botSecret').value = ''; } });
bind('saveTarget', () => admin('configure_target', { profileUrl: $('profileUrl').value.trim() }));
bind('saveOwner', async () => { const accessSecret = $('ownerSecret').value; try { await admin('configure_owner', { profileUrl: $('profileUrl').value.trim(), accessSecret, confirmAccount: $('confirmOwner').checked }); } finally { $('ownerSecret').value = ''; } });
bind('saveSettings', async () => {
  try { await admin('settings', { allowedSessionIds: $('sessions').value.split(/\s+/).filter(Boolean), upvoteEnabled: $('upvote').checked }); }
  catch (e) { await refresh().catch(() => {}); throw e; }
});
