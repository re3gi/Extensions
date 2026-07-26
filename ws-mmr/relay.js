/**
 * relay.js — Content script running in ISOLATED world.
 * Bridges postMessage events from the page context (ws_hook.js)
 * to the extension background via chrome.runtime.sendMessage.
 */

// Send the extension base URL to the MAIN world so it can load assets
window.postMessage({ type: 'ROCKETBALL_EXT_URL', url: chrome.runtime.getURL('') }, '*');

chrome.storage.local.get({ showCars: false }, (res) => {
  window.postMessage({ type: 'ROCKETBALL_SHOW_CARS', show: res.showCars }, '*');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.showCars) {
    window.postMessage({ type: 'ROCKETBALL_SHOW_CARS', show: changes.showCars.newValue }, '*');
  }
});

window.addEventListener('message', function (event) {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'ROCKETBALL_OPPONENT_DETECTED') return;

  // Guard: chrome.runtime becomes undefined if the extension was reloaded
  // but this content script is still running in the old tab context.
  // In that case, silently bail — user must hard-refresh the tab.
  if (!chrome || !chrome.runtime || !chrome.runtime.id) {
    console.warn('[RatingSniffer] ⚠️ Extension context invalidated. Hard-refresh this tab (Ctrl+Shift+R) to reconnect.');
    return;
  }

  // Forward to background service worker
  chrome.runtime.sendMessage({
    type: 'OPPONENT_DETECTED',
    data: event.data.data
  }).catch(() => {});
});

// Handle CLOSE_LEADERBOARD from the iframe
window.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CLOSE_LEADERBOARD') {
    if (leaderboardIframe) {
      leaderboardIframe.style.display = 'none';
    }
  }
});

let leaderboardIframe = null;

function toggleLeaderboard() {
  if (leaderboardIframe) {
    leaderboardIframe.style.display = leaderboardIframe.style.display === 'none' ? 'block' : 'none';
  } else {
    leaderboardIframe = document.createElement('iframe');
    leaderboardIframe.src = chrome.runtime.getURL('leaderboard.html');
    Object.assign(leaderboardIframe.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      border: 'none',
      zIndex: '9999999',
      background: 'rgba(0,0,0,0.5)' // Dim the game behind the window
    });
    document.body.appendChild(leaderboardIframe);
  }
}

// Listen for TOGGLE_LEADERBOARD from background.js
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOGGLE_LEADERBOARD') {
      toggleLeaderboard();
    }
  });
}
