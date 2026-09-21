// popup.js — Lyri-X v1.3
// Handle launch button dan custom hotkey setup

document.getElementById('popup-launch-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });

  if (tabs.length === 0) {
    const msgEl = document.getElementById('popup-msg');
    msgEl.textContent = "Buka music.youtube.com dan putar lagu terlebih dahulu!";
    msgEl.style.display = 'block';
    return;
  }

  chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-pip" });
  window.close();
});

// Load saved hotkey dari localStorage dan display di popup
function loadSavedHotkey() {
  const saved = localStorage.getItem('lyrix-custom-hotkey');
  if (saved) {
    document.getElementById('hotkey-input').value = saved;
    updateHotkeyDisplay(saved);
  }
}

function updateHotkeyDisplay(hotkeyStr) {
  // Parse "Alt+L" → display individual keys
  const parts = hotkeyStr.split('+').map(p => p.trim());
  // For now, just show the string as-is (UI can be improved later)
  const display = document.getElementById('hotkey-display');
  if (display) display.textContent = parts[parts.length - 1] || 'L';
}

// Hotkey save button
document.getElementById('hotkey-save-btn').addEventListener('click', () => {
  const input = document.getElementById('hotkey-input').value.trim();
  if (!input) {
    showStatus("Hotkey cannot be empty!", false);
    return;
  }

  // Basic validation: should contain + and be like "Alt+L" or "Ctrl+Shift+E"
  if (!input.includes('+')) {
    showStatus("Format: Alt+L or Ctrl+Shift+K", false);
    return;
  }

  // Save to localStorage
  localStorage.setItem('lyrix-custom-hotkey', input);
  
  // Update display
  updateHotkeyDisplay(input);
  
  // Show confirmation
  showStatus("Hotkey saved! Refresh YT Music tab.", true);
  
  // Notify content script about hotkey change
  chrome.tabs.query({ url: "https://music.youtube.com/*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { 
        action: "update-hotkey", 
        hotkey: input 
      }).catch(() => {
        // Ignore errors — tab might not have content script ready
      });
    }
  });
});

function showStatus(msg, isSuccess) {
  const statusEl = document.getElementById('hotkey-status');
  statusEl.textContent = msg;
  statusEl.style.color = isSuccess ? '#D0FF41' : '#ff3333';
  statusEl.style.display = 'block';
  
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}

// On popup load, load saved hotkey
loadSavedHotkey();
