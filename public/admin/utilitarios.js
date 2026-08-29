// Modal de novo projeto, cópia para a área de transferência e utilidades de formatação.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Novo projeto ----------------
function openNewModal() { $('#modalNew').classList.add('open'); $('#npName').focus(); }
function closeNewModal() { $('#modalNew').classList.remove('open'); $('#newProjectForm').reset(); }

async function createProject(e) {
  e.preventDefault();
  const name = $('#npName').value.trim();
  const domain = $('#npDomain').value.trim();
  try {
    const created = await api('/projects', { method: 'POST', body: { name, domain } });
    closeNewModal();
    await loadProjects();
    selectProject(created.id);
    toast('Projeto criado! Configure o Pixel na aba Meta e depois volte aqui.', 'ok');
  } catch (err) {
    toast('Erro ao criar projeto: ' + err.message, 'err');
  }
}

// ---------------- Copiar ----------------
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(okMsg, 'ok'); }
    catch { toast('Copie manualmente (Ctrl+C).', 'warn'); }
    ta.remove();
  }
}

// ---------------- Utils ----------------
function td(text) { const c = document.createElement('td'); c.textContent = text; return c; }
// Escapa texto que vai para innerHTML (hostname, mensagem de erro do DNS etc.).
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function shorten(s) { s = String(s || ''); return s.length > 14 ? s.slice(0, 14) + '…' : s; }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('pt-BR');
}
function objToJson(obj) {
  if (!obj || !Object.keys(obj).length) return '';
  return JSON.stringify(obj, null, 2);
}
// Le um textarea que deve conter JSON de objeto. Retorna {} se vazio, objeto se valido,
// ou undefined (+ toast) se invalido — o chamador aborta o submit nesse caso.
function parseJsonField(sel) {
  const raw = $(sel).value.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      throw new Error('deve ser um objeto');
    }
    return parsed;
  } catch (err) {
    toast('Mapeamento de eventos inválido (JSON): ' + err.message, 'err');
    return undefined;
  }
}
