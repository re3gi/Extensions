/**
 * background.js — Service worker.
 * Stores opponent data in chrome.storage.local so the popup can display it.
 * Maintains a history of opponents seen in the current session.
 */

// Track opponents
let opponentHistory = [];
let playersDatabase = {}; // Local database of all seen players, keyed by firebaseUid

// Create an initialization promise that resolves once storage is loaded
const initPromise = new Promise(resolve => {
  chrome.storage.local.get(['opponentHistory', 'playersDatabase'], (result) => {
    if (result.opponentHistory) {
      opponentHistory = result.opponentHistory;
    }
    if (result.playersDatabase) {
      playersDatabase = result.playersDatabase;
    }
    resolve();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPPONENT_DETECTED') {
    // Wait for the DB to be fully loaded into memory before processing
    initPromise.then(() => {
      const opponent = message.data;
      opponent.timestamp = Date.now();

      // Update persistent player database
      if (opponent.firebaseUid) {
        if (playersDatabase[opponent.firebaseUid]) {
          // Update existing entry
          const existing = playersDatabase[opponent.firebaseUid];
          const modeStats = existing.modeStats || {};
          
          if (opponent.gameMode) {
             const currentMode = modeStats[opponent.gameMode] || {};
             const newStats = {
               rating: opponent.rating !== undefined ? opponent.rating : currentMode.rating,
               rd: opponent.ratingDeviation !== undefined ? opponent.ratingDeviation : currentMode.rd,
               vo: opponent.volatility !== undefined ? opponent.volatility : currentMode.vo
             };
             if (newStats.rating === undefined) delete newStats.rating;
             if (newStats.rd === undefined) delete newStats.rd;
             if (newStats.vo === undefined) delete newStats.vo;
             
             // Even if rating is undefined, record that they played this mode
             if (Object.keys(newStats).length === 0) {
               newStats.unranked = true;
             }
             modeStats[opponent.gameMode] = newStats;
          }

          playersDatabase[opponent.firebaseUid] = {
            ...existing,
            name: (opponent.name !== undefined && opponent.name !== 'Player') ? opponent.name : (existing.name || opponent.name),
            body: opponent.body !== undefined ? opponent.body : existing.body,
            modeStats: modeStats,
            lastSeen: opponent.timestamp,
            timesSeen: (existing.timesSeen || 1) + 1
          };
          
          // Clean up obsolete fields if they exist from older versions
          delete playersDatabase[opponent.firebaseUid].lastGameMode;
          delete playersDatabase[opponent.firebaseUid].rating;
          delete playersDatabase[opponent.firebaseUid].ratingDeviation;
          delete playersDatabase[opponent.firebaseUid].volatility;
          delete playersDatabase[opponent.firebaseUid].allRatings;
        } else {
          // New entry
          const modeStats = {};
          if (opponent.gameMode) {
             const newStats = {
               rating: opponent.rating,
               rd: opponent.ratingDeviation,
               vo: opponent.volatility
             };
             if (newStats.rating === undefined) delete newStats.rating;
             if (newStats.rd === undefined) delete newStats.rd;
             if (newStats.vo === undefined) delete newStats.vo;
             
             // Even if rating is undefined, record that they played this mode
             if (Object.keys(newStats).length === 0) {
               newStats.unranked = true;
             }
             modeStats[opponent.gameMode] = newStats;
          }

          playersDatabase[opponent.firebaseUid] = {
            firebaseUid: opponent.firebaseUid,
            name: opponent.name,
            body: opponent.body,
            modeStats: modeStats,
            firstSeen: opponent.timestamp,
            lastSeen: opponent.timestamp,
            timesSeen: 1
          };
        }
      }

      // Add to history (newest first), cap at 50
      opponentHistory.unshift(opponent);
      if (opponentHistory.length > 50) opponentHistory.pop();

      // Store for popup
      chrome.storage.local.set({
        currentOpponent: opponent,
        opponentHistory: opponentHistory,
        playersDatabase: playersDatabase,
        lastUpdate: Date.now()
      });

      // Notify popup if open
      chrome.runtime.sendMessage({
        type: 'OPPONENT_UPDATE',
        data: opponent
      }).catch(() => { /* popup not open, ignore */ });

      console.log('[RatingSniffer BG] Stored opponent:', opponent.name, 'Rating:', opponent.rating);
    });
  }

  if (message.type === 'GET_HISTORY') {
    initPromise.then(() => {
      sendResponse({ history: opponentHistory });
    });
    return true;
  }

  if (message.type === 'CLEAR_HISTORY') {
    initPromise.then(() => {
      opponentHistory = [];
      chrome.storage.local.set({
        currentOpponent: null,
        opponentHistory: [],
        lastUpdate: Date.now()
      });
      sendResponse({ ok: true });
    });
    return true;
  }
});

// When the user clicks the extension icon in the toolbar, tell the active tab to toggle the menu
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && (tab.url.includes('rocketball.io') || tab.url.includes('rocketgoal.io'))) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_LEADERBOARD' }).catch(() => {
      console.warn("[RatingSniffer] Failed to send TOGGLE_LEADERBOARD to tab. Is the content script running?");
    });
  }
});
