/**
 * app.js — Shared UI initialisation for all pages.
 *
 * Injects: settings modal, toast container, loading overlay.
 * Wires:   hamburger nav, API-key management, data management.
 *
 * Usage in every page:
 *   import { initCommonUI } from './js/app.js';
 *   initCommonUI();
 */

import { getGeminiKey, setGeminiKey, testGeminiKey } from './api-gemini.js';
import {
  getStorageStats, clearIconCache, clearAllData,
  exportAllData, importData,
} from './db.js';
import { showToast } from './utils.js';

// ── Public entry point ────────────────────────────────────────

export function initCommonUI() {
  ensureToastContainer();
  ensureLoadingOverlay();
  initHamburger();
  injectSettingsModal();
  initSettingsModal();
}

// ── Infrastructure ────────────────────────────────────────────

function ensureToastContainer() {
  if (document.getElementById('toast-container')) return;
  const el = document.createElement('div');
  el.id = 'toast-container';
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
}

function ensureLoadingOverlay() {
  if (document.getElementById('loading-overlay')) return;
  const el = document.createElement('div');
  el.id = 'loading-overlay';
  el.className = 'hidden';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="loading-rune" aria-hidden="true">✦</div>
    <div class="loading-message" id="loading-message">Loading…</div>
  `;
  document.body.appendChild(el);
}

// ── Hamburger nav ─────────────────────────────────────────────

function initHamburger() {
  const btn     = document.getElementById('hamburger-btn');
  const drawer  = document.getElementById('nav-drawer');
  const overlay = document.getElementById('nav-overlay');
  if (!btn || !drawer) return;

  btn.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    overlay?.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
  });

  overlay?.addEventListener('click', () => {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  });
}

// ── Settings modal ────────────────────────────────────────────

function injectSettingsModal() {
  if (document.getElementById('settings-modal')) return;

  const modal = document.createElement('div');
  modal.id        = 'settings-modal';
  modal.className = 'modal-overlay hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'settings-title');

  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title" id="settings-title">⚙️ Settings</span>
        <button class="modal-close" id="settings-close" aria-label="Close settings">✕</button>
      </div>
      <div class="modal-body">

        <!-- API Key -->
        <div style="margin-bottom:1.5rem;">
          <h3 style="font-size:0.95rem;color:var(--color-primary);margin-bottom:1rem;font-family:var(--font-display);">
            🔑 Gemini API Key
          </h3>
          <div class="form-group">
            <label for="api-key-input">API Key</label>
            <div style="display:flex;gap:0.5rem;">
              <input type="password" id="api-key-input" placeholder="AIza…" autocomplete="off" />
              <button class="btn btn-ghost btn-sm" id="toggle-key-visibility"
                      aria-label="Toggle key visibility" style="flex-shrink:0;">👁</button>
            </div>
            <div class="form-hint">
              Get a free key at
              <a href="https://ai.google.dev" target="_blank" rel="noopener">ai.google.dev</a>.
              Stored only in your browser.
            </div>
          </div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="save-key-btn">💾 Save Key</button>
            <button class="btn btn-ghost btn-sm"   id="test-key-btn">🧪 Test Key</button>
          </div>
          <div id="key-status" style="margin-top:0.75rem;font-family:var(--font-ui);font-size:0.8rem;"></div>
        </div>

        <hr class="divider" />

        <!-- Data management -->
        <div>
          <h3 style="font-size:0.95rem;color:var(--color-primary);margin-bottom:1rem;font-family:var(--font-display);">
            💾 Data Management
          </h3>
          <div id="storage-info"
               style="font-family:var(--font-ui);font-size:0.8rem;color:var(--color-text-muted);margin-bottom:1rem;"></div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm"  id="export-btn">📤 Export Data</button>
            <button class="btn btn-ghost btn-sm"  id="import-btn">📥 Import Data</button>
            <input type="file" id="import-file" accept=".json" class="hidden" />
            <button class="btn btn-ghost btn-sm"  id="clear-icons-btn">🖼️ Clear Icon Cache</button>
            <button class="btn btn-danger btn-sm" id="clear-all-btn">🗑️ Clear All Data</button>
          </div>
        </div>

        <hr class="divider" />

        <!-- Credits -->
        <div style="font-family:var(--font-ui);font-size:0.8rem;color:var(--color-text-faint);line-height:1.8;">
          <strong style="color:var(--color-text-muted);">Free APIs used:</strong><br/>
          🤖 <a href="https://ai.google.dev" target="_blank" rel="noopener">Google Gemini Flash</a> — AI text generation<br/>
          🎨 <a href="https://pollinations.ai" target="_blank" rel="noopener">Pollinations.ai</a> — Image generation (no key needed)
        </div>

      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function initSettingsModal() {
  const modal      = document.getElementById('settings-modal');
  const apiInput   = document.getElementById('api-key-input');
  if (!modal) return;

  const open = () => {
    if (apiInput) apiInput.value = getGeminiKey();
    refreshStorageInfo();
    modal.classList.remove('hidden');
    apiInput?.focus();
  };
  const close = () => modal.classList.add('hidden');

  document.getElementById('settings-btn')?.addEventListener('click', open);
  document.getElementById('settings-close')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('toggle-key-visibility')?.addEventListener('click', () => {
    if (apiInput) apiInput.type = apiInput.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('save-key-btn')?.addEventListener('click', () => {
    const key = apiInput?.value.trim();
    if (!key) { showToast('Please enter an API key.', 'error'); return; }
    setGeminiKey(key);
    showToast('API key saved!', 'success');
    const status = document.getElementById('key-status');
    if (status) status.innerHTML = '<span style="color:var(--color-success)">✓ Key saved</span>';
  });

  document.getElementById('test-key-btn')?.addEventListener('click', async () => {
    const key = apiInput?.value.trim();
    if (!key) { showToast('Enter a key first.', 'error'); return; }
    const prev = getGeminiKey();
    setGeminiKey(key);
    const status = document.getElementById('key-status');
    if (status) status.innerHTML = '<span style="color:var(--color-text-muted)">Testing…</span>';
    const ok = await testGeminiKey();
    if (ok) {
      if (status) status.innerHTML = '<span style="color:var(--color-success)">✓ Key is valid!</span>';
      showToast('API key works!', 'success');
    } else {
      setGeminiKey(prev);
      if (status) status.innerHTML = '<span style="color:var(--color-danger)">✕ Test failed. Check your key.</span>';
      showToast('API key test failed.', 'error');
    }
  });

  document.getElementById('export-btn')?.addEventListener('click', () => {
    const data = exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `dnd-ai-export-${new Date().toISOString().slice(0,10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported!', 'success');
  });

  document.getElementById('import-btn')?.addEventListener('click', () => {
    document.getElementById('import-file')?.click();
  });

  document.getElementById('import-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      importData(JSON.parse(await file.text()));
      showToast('Data imported successfully!', 'success');
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
    e.target.value = '';
  });

  document.getElementById('clear-icons-btn')?.addEventListener('click', () => {
    if (!confirm('Clear all cached item icons? They can be regenerated on demand.')) return;
    clearIconCache();
    showToast('Icon cache cleared.', 'success');
    refreshStorageInfo();
  });

  document.getElementById('clear-all-btn')?.addEventListener('click', () => {
    if (!confirm('⚠️ Delete ALL characters, items, and campaigns? This cannot be undone.')) return;
    clearAllData();
    showToast('All data cleared.', 'info');
  });
}

function refreshStorageInfo() {
  const el = document.getElementById('storage-info');
  if (!el) return;
  const stats = getStorageStats();
  const fmt   = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`;
  el.textContent = `Storage used: ${fmt(stats.total)} (Characters: ${fmt(stats.characters)}, Items: ${fmt(stats.items)}, Stories: ${fmt(stats.stories)})`;
}
