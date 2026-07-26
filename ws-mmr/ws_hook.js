/**
 * ws_hook.js — Injected into the PAGE context (not the extension context).
 * Monkey-patches the native WebSocket to intercept binary frames on
 * Photon exitgames connections, parses player data packets, and
 * posts opponent data back to the content script via window.postMessage.
 *
 * Photon packet types containing player data:
 *   f3 04 ff  → Event 255 (Join) — sent when a new player joins the room
 *   f3 03     → OperationResponse — sent with room state (existing players)
 *
 * Both use identical TLV (Type-Length-Value) serialization for player props:
 *   Name:        03 ff 07 NN <N bytes>         (param 0xFF → string)
 *   Float key:   07 02 XX XX 05 <4 bytes LE>   (string key → float value)
 *   Body/Skin:   07 01 53 07 NN <N bytes>      (key "S" → string value)
 *   Firebase UID: 03 fd 07 NN <N bytes>        (param 0xFD → variable-length string)
 *   Matchmaking:  07 0c 4d617463686d616b696e6754 (key "MatchmakingT")
 */

(function () {
  'use strict';

  const OriginalWebSocket = window.WebSocket;

  function isPhotonUrl(url) {
    // Match any exitgames.com WebSocket: gcams1224, gcams5678, etc.
    // Also catch variations like ws:// or wss://
    return url && (url.includes('exitgames.com') || url.includes('photon'));
  }

  // ─── IEEE 754 Little-Endian float reader ───
  function readFloat32LE(bytes, offset) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, bytes[offset]);
    view.setUint8(1, bytes[offset + 1]);
    view.setUint8(2, bytes[offset + 2]);
    view.setUint8(3, bytes[offset + 3]);
    return view.getFloat32(0, true);
  }

  // ─── Read ASCII string of given length ───
  function readAscii(bytes, offset, len) {
    let str = '';
    for (let j = 0; j < len && offset + j < bytes.length; j++) {
      str += String.fromCharCode(bytes[offset + j]);
    }
    return str;
  }

  // ─── Main packet parser ───
  // Uses pattern-matching against known TLV byte signatures
  // Scans any Photon packet (f3 magic byte) for player data patterns.
  // Supports multiple players in a single packet (e.g. f3 03 OperationResponse)
  function parsePhotonPacket(bytes) {
    if (bytes.length < 10) return [];

    // Must start with Photon magic byte f3
    if (bytes[0] !== 0xf3) return [];

    // Accept Event messages (04), OperationResponse (03), and OperationRequest (02)
    if (bytes[1] !== 0x04 && bytes[1] !== 0x03 && bytes[1] !== 0x02) return [];

    let items = [];

    // ── 1. Find player name: 03 ff 07 NN <N bytes> ──
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x03 && bytes[i + 1] === 0xff && bytes[i + 2] === 0x07) {
        const nameLen = bytes[i + 3];
        if (nameLen === 0) {
          items.push({ key: 'name', value: 'Player', offset: i });
        } else if (i + 4 + nameLen <= bytes.length) {
          const nameStr = readAscii(bytes, i + 4, nameLen);
          // basic printable check
          if (/^[\x20-\x7e]*$/.test(nameStr)) {
            items.push({ key: 'name', value: nameStr, offset: i });
          }
        }
      }
    }

    // ── 2. Find float key-value pairs: 07 02 XX XX 05 <4 bytes LE> ──
    for (let i = 0; i < bytes.length - 8; i++) {
      if (bytes[i] === 0x07 && bytes[i + 1] === 0x02 && bytes[i + 4] === 0x05) {
        const key = String.fromCharCode(bytes[i + 2]) + String.fromCharCode(bytes[i + 3]);
        const floatVal = readFloat32LE(bytes, i + 5);

        if (key === 'RA') items.push({ key: 'rating', value: Math.round(floatVal * 100) / 100, offset: i });
        if (key === 'RD') items.push({ key: 'ratingDeviation', value: Math.round(floatVal * 100) / 100, offset: i });
        if (key === 'VO') items.push({ key: 'volatility', value: floatVal, offset: i });
      }
    }

    // ── 3. Find body/skin: 07 01 53 07 NN <N bytes> ──
    for (let i = 0; i < bytes.length - 5; i++) {
      if (bytes[i] === 0x07 && bytes[i + 1] === 0x01 &&
          bytes[i + 2] === 0x53 && bytes[i + 3] === 0x07) {
        const bodyLen = bytes[i + 4];
        if (bodyLen > 0 && i + 5 + bodyLen <= bytes.length) {
          items.push({ key: 'body', value: readAscii(bytes, i + 5, bodyLen), offset: i });
        }
      }
    }

    // ── 4. Find Firebase UID: 03 fd 07 NN <N bytes> (variable length) ──
    for (let i = 0; i < bytes.length - 6; i++) {
      if (bytes[i] === 0x03 && bytes[i + 1] === 0xfd && bytes[i + 2] === 0x07) {
        const uidLen = bytes[i + 3];
        if (uidLen >= 10 && uidLen <= 50 && i + 4 + uidLen <= bytes.length) {
          const uid = readAscii(bytes, i + 4, uidLen);
          if (/^[a-zA-Z0-9_-]+$/.test(uid)) {
            items.push({ key: 'firebaseUid', value: uid, offset: i });
          }
        }
      }
    }

    // ── 5. Group items into players ──
    // Photon OperationResponse (f3 03) uses `0b [actorNr] 15 [propCount]`
    // markers to delimit each player's property hashtable.  Detect these
    // boundaries and assign items to the correct player based on offset ranges.

    items.sort((a, b) => a.offset - b.offset);

    // Find player boundary markers: 0b XX 15 YY (XX=actor, YY=prop count, both > 0)
    const boundaries = [];
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x0b && bytes[i + 2] === 0x15 &&
          bytes[i + 1] > 0 && bytes[i + 1] <= 20 &&
          bytes[i + 3] > 0 && bytes[i + 3] <= 30) {
        boundaries.push(i);
      }
    }

    const players = [];

    if (boundaries.length >= 2) {
      // Use boundary-aware grouping — build offset ranges per player slot
      const slots = [];
      for (let b = 0; b < boundaries.length; b++) {
        const start = boundaries[b];
        const end = (b + 1 < boundaries.length) ? boundaries[b + 1] : bytes.length;
        slots.push({ start, end });
      }

      for (const slot of slots) {
        const player = {};
        for (const item of items) {
          if (item.offset >= slot.start && item.offset < slot.end) {
            player[item.key] = item.value;
          }
        }
        if (player.firebaseUid || player.name) {
          players.push(player);
        }
      }
    } else {
      // Fallback: duplicate-key split (works for Event packets with 1-2 players)
      let currentPlayer = {};
      for (const item of items) {
        if (currentPlayer[item.key] !== undefined) {
          if (currentPlayer.firebaseUid || currentPlayer.name) {
            players.push(currentPlayer);
          }
          currentPlayer = {};
        }
        currentPlayer[item.key] = item.value;
      }
      if (Object.keys(currentPlayer).length > 0 && (currentPlayer.firebaseUid || currentPlayer.name)) {
        players.push(currentPlayer);
      }
    }

    // ── 6. Extract GameMode (Room Property) and attach to all players ──
    // "GameMode" string signature: 07 08 47 61 6d 65 4d 6f 64 65
    let rawGameMode = null;
    const gmBytes = [0x47, 0x61, 0x6d, 0x65, 0x4d, 0x6f, 0x64, 0x65];
    for (let i = 0; i < bytes.length - 12; i++) {
      if (bytes[i] === 0x07 && bytes[i + 1] === 0x08) {
        let match = true;
        for (let j = 0; j < 8; j++) {
          if (bytes[i + 2 + j] !== gmBytes[j]) { match = false; break; }
        }
        if (match) {
          // Extract the next 4 bytes as a raw hex string since the exact type is unknown
          const hexVals = [];
          for (let j = 0; j < 4; j++) {
             hexVals.push(bytes[i + 10 + j].toString(16).padStart(2, '0'));
          }
          rawGameMode = hexVals.join(' ');
          break;
        }
      }
    }

    if (rawGameMode) {
      players.forEach(p => p.gameMode = rawGameMode);
    }

    return players;
  }

  let currentGameMode = "Unknown";

  function processOutgoingFrame(bytes) {
    // ── 0. Extract GameMode from outgoing f3 02 Join/Create Room Request ──
    if (bytes[0] === 0xf3 && bytes[1] === 0x02) {
      
      // Photon Operation Codes for joining rooms:
      // 227 = CreateGame / JoinOrCreate
      // 226 = JoinGame
      // 225 = JoinRandomGame
      if (bytes[2] === 227 || bytes[2] === 226 || bytes[2] === 225) {
        window.postMessage({ type: 'ROCKETBALL_NEW_ROOM' }, '*');
      }
      
      for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xd5 && bytes[i+1] === 0x07) {
          const len = bytes[i+2];
          if (len > 0 && i + 3 + len <= bytes.length) {
            let str = readAscii(bytes, i+3, len);
            if (/^[a-zA-Z0-9]+$/.test(str)) {
              currentGameMode = str;
              console.log('[RatingSniffer] 🎮 Outgoing Game Mode set to:', currentGameMode);
            }
          }
        }
      }
    }

    // Process local player stats embedded in the outgoing request
    const players = parsePhotonPacket(bytes);
    if (players && players.length > 0) {
      players.forEach(p => {
        if (p.name !== undefined || p.rating !== undefined) {
          p.gameMode = currentGameMode;
          console.log('[RatingSniffer] 🏓 Local Player detected (outgoing):', JSON.stringify(p));
          window.postMessage({
            type: 'ROCKETBALL_OPPONENT_DETECTED',
            data: p
          }, '*');
        }
      });
    }
  }

  function processFrame(bytes) {
    const players = parsePhotonPacket(bytes);
    if (players && players.length > 0) {
      players.forEach(p => {
        if (p.name !== undefined || p.rating !== undefined) {
          p.gameMode = currentGameMode;
          console.log('[RatingSniffer] 🏓 Opponent detected:', JSON.stringify(p));
          window.postMessage({
            type: 'ROCKETBALL_OPPONENT_DETECTED',
            data: p
          }, '*');
        }
      });
    }
  }

  // ─── WebSocket Monkey-patch ───
  function PatchedWebSocket(url, protocols) {
    const ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    if (isPhotonUrl(url)) {
      console.log('[RatingSniffer] 🎯 Hooked Photon WebSocket:', url);

      ws.addEventListener('message', function (event) {
        if (event.data instanceof ArrayBuffer) {
          processFrame(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          event.data.arrayBuffer().then(buf => {
            processFrame(new Uint8Array(buf));
          });
        }
      });

      const originalSend = ws.send;
      ws.send = function (data) {
        try {
          if (data instanceof ArrayBuffer) {
            processOutgoingFrame(new Uint8Array(data));
          } else if (data instanceof Uint8Array) {
            processOutgoingFrame(data);
          } else if (data instanceof Blob) {
            data.arrayBuffer().then(buf => {
              processOutgoingFrame(new Uint8Array(buf));
            }).catch(()=>{});
          }
        } catch (e) {
          // Ignore parse errors on send
        }
        return originalSend.apply(this, arguments);
      };
    }

    return ws;
  }

  // Preserve WebSocket API surface
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;

  console.log('[RatingSniffer] ✅ WebSocket hook installed');
})();
