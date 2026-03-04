/**
 * app.js — Shared UI initialisation for all pages.
 *
 * Injects: settings modal, toast container, loading overlay, account section.
 * Wires:   hamburger nav, API-key management, data management, user account.
 *
 * Usage in every page:
 *   import { initCommonUI } from './js/app.js';
 *   initCommonUI();
 */

import { getGeminiKey, setGeminiKey, testGeminiKey, getGeminiModel, setGeminiModel, GEMINI_MODELS } from './api-gemini.js';
import { IMAGE_MODELS, getImageModel, setImageModel, getHFKey, setHFKey } from './api-image.js';
import {
  getStorageStats, clearIconCache, clearAllData,
  exportAllData, importData,
} from './db.js';
import { showToast } from './utils.js';
import { getCurrentUser, logout } from './auth.js';

// ── Public entry point ────────────────────────────────────────

export function initCommonUI() {
  ensureToastContainer();
  ensureLoadingOverlay();
  initHamburger();
  injectSettingsModal();
  initSettingsModal();
  initUserDisplay();
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

// ── User display in navbar ────────────────────────────────────

function initUserDisplay() {
  const user = getCurrentUser();
  if (!user) return;

  // Inject username + logout into navbar-actions
  const actionsEl = document.querySelector('.navbar-actions');
  if (actionsEl) {
    const userSpan = document.createElement('span');
    userSpan.style.cssText = 'font-family:var(--font-ui);font-size:0.8rem;color:var(--color-text-muted);';
    userSpan.textContent = `👤 ${user.username}`;

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn btn-ghost btn-sm';
    logoutBtn.textContent = 'Sign Out';
    logoutBtn.title = 'Sign out of your account';
    logoutBtn.addEventListener('click', () => {
      if (confirm('Sign out of DND AI?')) logout();
    });

    actionsEl.insertBefore(logoutBtn, actionsEl.firstChild);
    actionsEl.insertBefore(userSpan, actionsEl.firstChild);
  }
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

  const user = getCurrentUser();

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

        <!-- Account info -->
        ${user ? `
        <div style="margin-bottom:1.5rem;">
          <h3 style="font-size:0.95rem;color:var(--color-primary);margin-bottom:1rem;font-family:var(--font-display);">
            👤 Account
          </h3>
          <div style="font-family:var(--font-ui);font-size:0.88rem;color:var(--color-text-muted);margin-bottom:0.75rem;">
            Signed in as <strong style="color:var(--color-text);">${user.username}</strong> &nbsp;(${user.email})
          </div>
          <button class="btn btn-ghost btn-sm" id="settings-logout-btn">🚪 Sign Out</button>
        </div>
        <hr class="divider" />
        ` : ''}

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
              Saved securely to your account.
            </div>
          </div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="save-key-btn">💾 Save Key</button>
            <button class="btn btn-ghost btn-sm"   id="test-key-btn">🧪 Test Key</button>
          </div>
          <div id="key-status" style="margin-top:0.75rem;font-family:var(--font-ui);font-size:0.8rem;"></div>
        </div>

        <hr class="divider" />

        <!-- Model selection -->
        <div style="margin-bottom:1.5rem;">
          <h3 style="font-size:0.95rem;color:var(--color-primary);margin-bottom:1rem;font-family:var(--font-display);">
            🤖 AI Model
          </h3>
          <div class="form-group">
            <label for="model-select">Gemini Model</label>
            <select id="model-select" style="width:100%;background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:var(--radius);color:var(--color-text);font-family:var(--font-ui);font-size:0.88rem;padding:0.55rem 0.75rem;cursor:pointer;">
            </select>
            <div class="form-hint">Affects all AI text generation. Preview models may have rate limits.</div>
          </div>
          <button class="btn btn-primary btn-sm" id="save-model-btn">💾 Save Model</button>
          <div id="model-status" style="margin-top:0.75rem;font-family:var(--font-ui);font-size:0.8rem;"></div>
        </div>

        <hr class="divider" />

        <!-- Image model selection -->
        <div style="margin-bottom:1.5rem;">
          <h3 style="font-size:0.95rem;color:var(--color-primary);margin-bottom:1rem;font-family:var(--font-display);">
            🎨 Image Model
          </h3>
          <div class="form-group">
            <label for="image-model-select">Image Provider</label>
            <select id="image-model-select" style="width:100%;background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:var(--radius);color:var(--color-text);font-family:var(--font-ui);font-size:0.88rem;padding:0.55rem 0.75rem;cursor:pointer;">
            </select>
            <div class="form-hint">Pollinations is free with no key. HuggingFace models require a free HF API key. Google Imagen requires the Gemini API key above.</div>
          </div>
          <button class="btn btn-primary btn-sm" id="save-image-model-btn">💾 Save Image Model</button>
          <div id="image-model-status" style="margin-top:0.75rem;font-family:var(--font-ui);font-size:0.8rem;"></div>

          <!-- HuggingFace API key (shown only for HF models) -->
          <div id="hf-key-section" style="margin-top:1.25rem;">
            <div class="form-group">
              <label for="hf-key-input">HuggingFace API Key</label>
              <div style="display:flex;gap:0.5rem;">
                <input type="password" id="hf-key-input" placeholder="hf_…" autocomplete="off" style="flex:1;" />
                <button class="btn btn-ghost btn-sm" id="toggle-hf-key-visibility"
                        aria-label="Toggle HF key visibility" style="flex-shrink:0;">👁</button>
              </div>
              <div class="form-hint">
                Get a free token at
                <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a>
                (free account, no credit card). Saved securely to your account.
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="save-hf-key-btn">💾 Save HF Key</button>
            <div id="hf-key-status" style="margin-top:0.75rem;font-family:var(--font-ui);font-size:0.8rem;"></div>
          </div>
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
          <strong style="color:var(--color-text-muted);">APIs used:</strong><br/>
          🤖 <a href="https://ai.google.dev" target="_blank" rel="noopener">Google Gemini Flash</a> — AI text generation<br/>
          🎨 <a href="https://pollinations.ai" target="_blank" rel="noopener">Pollinations.ai</a> — Image generation (no key needed)<br/>
          🖼️ <a href="https://huggingface.co" target="_blank" rel="noopener">HuggingFace</a> — FLUX.1-schnell / SDXL (free HF key)<br/>
          🖼️ <a href="https://ai.google.dev" target="_blank" rel="noopener">Google Imagen 4</a> — Higher quality images (Gemini key required)
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

  // Populate Gemini model dropdown
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    const currentModel = getGeminiModel();
    GEMINI_MODELS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === currentModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  // Populate image model dropdown
  const imageModelSelect = document.getElementById('image-model-select');
  if (imageModelSelect) {
    const currentImageModel = getImageModel();
    IMAGE_MODELS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === currentImageModel) opt.selected = true;
      imageModelSelect.appendChild(opt);
    });
  }

  const hfKeyInput = document.getElementById('hf-key-input');

  const open = () => {
    if (apiInput)   apiInput.value   = getGeminiKey();
    if (hfKeyInput) hfKeyInput.value = getHFKey();
    // Sync model selectors to current values
    if (modelSelect)      modelSelect.value      = getGeminiModel();
    if (imageModelSelect) imageModelSelect.value = getImageModel();
    refreshStorageInfo();
    modal.classList.remove('hidden');
    apiInput?.focus();
  };
  const close = () => modal.classList.add('hidden');

  document.getElementById('settings-btn')?.addEventListener('click', open);
  document.getElementById('settings-close')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  // Account logout from settings modal
  document.getElementById('settings-logout-btn')?.addEventListener('click', () => {
    if (confirm('Sign out of DND AI?')) logout();
  });

  document.getElementById('toggle-key-visibility')?.addEventListener('click', () => {
    if (apiInput) apiInput.type = apiInput.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('save-key-btn')?.addEventListener('click', () => {
    const key = apiInput?.value.trim();
    if (!key) { showToast('Please enter an API key.', 'error'); return; }
    setGeminiKey(key);
    showToast('API key saved!', 'success');
    const status = document.getElementById('key-status');
    if (status) status.innerHTML = '<span style="color:var(--color-success)">✓ Key saved to your account</span>';
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

  document.getElementById('save-model-btn')?.addEventListener('click', () => {
    const selected = modelSelect?.value;
    if (!selected) { showToast('Select a model first.', 'error'); return; }
    setGeminiModel(selected);
    const status = document.getElementById('model-status');
    const label = GEMINI_MODELS.find(m => m.id === selected)?.label || selected;
    if (status) status.innerHTML = `<span style="color:var(--color-success)">✓ Model set to ${label}</span>`;
    showToast('Model saved!', 'success');
  });

  document.getElementById('toggle-hf-key-visibility')?.addEventListener('click', () => {
    if (hfKeyInput) hfKeyInput.type = hfKeyInput.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('save-hf-key-btn')?.addEventListener('click', () => {
    const key = hfKeyInput?.value.trim();
    if (!key) { showToast('Please enter a HuggingFace API key.', 'error'); return; }
    setHFKey(key);
    showToast('HF API key saved!', 'success');
    const status = document.getElementById('hf-key-status');
    if (status) status.innerHTML = '<span style="color:var(--color-success)">✓ HF key saved to your account</span>';
  });

  document.getElementById('save-image-model-btn')?.addEventListener('click', () => {
    const selected = imageModelSelect?.value;
    if (!selected) { showToast('Select an image model first.', 'error'); return; }
    const modelDef = IMAGE_MODELS.find(m => m.id === selected);
    if (modelDef?.requiresKey) {
      if (modelDef.keyType === 'hf' && !getHFKey()) {
        showToast('This model requires a HuggingFace API key — save one below first.', 'error');
        return;
      }
      if (modelDef.keyType === 'gemini' && !getGeminiKey()) {
        showToast('This model requires a Gemini API key — save one above first.', 'error');
        return;
      }
    }
    setImageModel(selected);
    const status = document.getElementById('image-model-status');
    if (status) status.innerHTML = `<span style="color:var(--color-success)">✓ Image model set to ${modelDef?.label || selected}</span>`;
    showToast('Image model saved!', 'success');
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
      refreshStorageInfo();
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
    refreshStorageInfo();
  });
}

function refreshStorageInfo() {
  const el = document.getElementById('storage-info');
  if (!el) return;
  const stats = getStorageStats();
  const fmt   = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(2)} MB`;
  el.textContent = `Data size: ${fmt(stats.total)} (Characters: ${fmt(stats.characters)}, Items: ${fmt(stats.items)}, Stories: ${fmt(stats.stories)})`;
}
