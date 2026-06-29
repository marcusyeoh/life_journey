import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Helper to determine if we are in admin mode
function checkAdminMode() {
  return window.location.pathname.includes('/admin') ||
    window.location.pathname.endsWith('admin.html') ||
    window.location.search.includes('admin=true') ||
    window.location.hash.includes('admin');
}

// Firebase Configuration (freedomrent-proo)
const firebaseConfig = {
  apiKey: "AIzaSyDjnMhOBc3fMKVXJMigSzcdSm1-nvBL7lg",
  authDomain: "freedomrent-proo.firebaseapp.com",
  projectId: "freedomrent-proo",
  storageBucket: "freedomrent-proo.appspot.com",
  messagingSenderId: "48447167796",
  appId: "1:48447167796:web:4947bd5b46a15f11225961"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Check if we are loading a specific history game from the URL path (e.g. /1717233959)
const pathIdMatch = window.location.pathname.match(/^\/(\d+)\/?$/);
const urlParams = new URLSearchParams(window.location.search);
const activeGameId = (pathIdMatch ? pathIdMatch[1] : null) || urlParams.get('game_id');

// Initialize the document reference based on URL
let mixerDocRef;
if (activeGameId) {
  mixerDocRef = doc(db, "mixers_history", activeGameId);
} else {
  mixerDocRef = doc(db, "mixers", "current_mixer");
}

// Application State
const appState = {
  isAdmin: checkAdminMode(),
  currentView: checkAdminMode() ? 'court-setup' : 'user-landing',
  currentStage: 1, // 1: Qualifying, 2: Final Stage
  stage1Courts: null,
  draftingStyle: 'snake', // 'snake' | 'skill-grouped'
  stage2ViewingQualifying: false,
  stage2PreviewTiers: [],
  leaderboardViewMode: 'cumulative', // 'cumulative' | 'stage2' | 'stage1'

  // List of 6 Courts
  courts: Array.from({ length: 6 }, (_, i) => ({
    courtNumber: i + 1,
    courtName: '',
    isActive: false,
    players: [], // Array of Player objects: { name, totalScore, initialIndex }
    matches: [], // Array of Match objects
    activeRound: 1
  })),

  // Selection States
  selectedCourtNumber: 1, // Currently selected court in Entry & Dashboard
  viewingRound: 1, // Currently viewed round in Dashboard

  // Temporary Entry state to preserve progress during court tab switching
  entryState: {
    // courtNumber -> { names: ['...', '...'], count: 4|5|6 }
  },

  avatars: {}, // Global player name -> base64Avatar map

  // Modal Scoring State
  modal: {
    open: false,
    courtNumber: 1,
    matchIndex: 0,
    score1: 15,
    score2: 10
  }
};

let confirmCallback = null;
let editingCourtNumber = null;
let debounceTimer = null;
let editingPlayerKey = null; // Format: "courtNumber-idx"
let unsubscribeMixer = null;
let reconnectTimeout = null;
let lastSyncTime = 0;

function showCourtNameModal(courtNumber) {
  editingCourtNumber = courtNumber;
  const modal = document.getElementById('court-name-modal');
  if (!modal) return;

  const titleEl = document.getElementById('court-name-modal-title');
  const inputEl = document.getElementById('court-name-modal-input');

  if (titleEl) {
    titleEl.textContent = `Rename Court ${courtNumber}`;
  }

  const court = appState.courts.find(c => c.courtNumber === courtNumber);
  const currentName = court && court.courtName ? court.courtName : `Court ${courtNumber}`;
  if (inputEl) {
    inputEl.value = currentName;
  }

  modal.classList.remove('view-hidden');
  setTimeout(() => {
    document.body.classList.add('modal-open');
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }, 50);
}

function hideCourtNameModal() {
  const modal = document.getElementById('court-name-modal');
  if (modal) {
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
  }
  editingCourtNumber = null;
}

function saveCourtNameFromModal() {
  if (!editingCourtNumber) return;
  const inputEl = document.getElementById('court-name-modal-input');
  if (!inputEl) return;

  let finalName = (inputEl.value || '').trim();
  if (!finalName) {
    finalName = `Court ${editingCourtNumber}`;
  }

  const court = appState.courts.find(c => c.courtNumber === editingCourtNumber);
  if (court) {
    court.courtName = finalName;
    saveStateToCloud();
  }

  hideCourtNameModal();
  render();
}

function showCustomConfirm(title, message, icon, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) return;

  const titleEl = document.getElementById('confirm-modal-title');
  const messageEl = document.getElementById('confirm-modal-message');
  const iconEl = document.getElementById('confirm-modal-icon');

  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (iconEl) iconEl.textContent = icon || 'warning';

  confirmCallback = onConfirm;

  modal.classList.remove('view-hidden');
  setTimeout(() => {
    document.body.classList.add('modal-open');
  }, 10);
}

function hideCustomConfirm() {
  const modal = document.getElementById('confirm-modal');
  if (modal) {
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
  }
}


// Match Model Class
class Match {
  constructor(team1Player1, team1Player2, team2Player1, team2Player2) {
    this.team1Player1 = team1Player1;
    this.team1Player2 = team1Player2;
    this.team2Player1 = team2Player1;
    this.team2Player2 = team2Player2;
    this.team1Score = null;
    this.team2Score = null;
    this.isCompleted = false;
  }
}

// Player Model Class
class Player {
  constructor(name, initialIndex) {
    this.name = name;
    this.totalScore = 0;
    this.pointsPlayed = 0;
    this.initialIndex = initialIndex;
  }
}

function getCourtName(courtNumber, stage = 1) {
  if (!courtNumber) return 'N/A';
  const courtsSource = (stage === 1) ? (appState.stage1Courts || appState.courts) : appState.courts;
  if (!courtsSource) return `Court ${courtNumber}`;
  const court = courtsSource.find(c => c.courtNumber === courtNumber);
  return court && court.courtName ? court.courtName : `Court ${courtNumber}`;
}

function recalculateScoresForCourt(court) {
  if (!court || !court.players) return;

  // 1. Reset all players scores to 0
  court.players.forEach(p => {
    p.totalScore = 0;
    p.pointsPlayed = 0;
  });

  // 2. Iterate through all completed matches and add the point differentials to players
  if (court.matches) {
    court.matches.forEach(match => {
      if (match.isCompleted && match.team1Score !== null && match.team2Score !== null &&
          match.team1Player1 && match.team1Player2 && match.team2Player1 && match.team2Player2) {
        const diff1 = match.team1Score - match.team2Score;
        const diff2 = match.team2Score - match.team1Score;

        // Safely find player in court.players and increment
        const p1 = court.players.find(p => p.name === match.team1Player1.name);
        if (p1) { p1.totalScore += diff1; p1.pointsPlayed += match.team1Score; }

        const p2 = court.players.find(p => p.name === match.team1Player2.name);
        if (p2) { p2.totalScore += diff1; p2.pointsPlayed += match.team1Score; }

        const p3 = court.players.find(p => p.name === match.team2Player1.name);
        if (p3) { p3.totalScore += diff2; p3.pointsPlayed += match.team2Score; }

        const p4 = court.players.find(p => p.name === match.team2Player2.name);
        if (p4) { p4.totalScore += diff2; p4.pointsPlayed += match.team2Score; }
      }
    });
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const COURT_SCHEDULES = {
  4: [
    { t1: [0, 1], t2: [2, 3] },
    { t1: [0, 2], t2: [1, 3] },
    { t1: [0, 3], t2: [1, 2] }
  ],
  5: [
    { t1: [0, 3], t2: [1, 2] },
    { t1: [1, 4], t2: [2, 3] },
    { t1: [2, 0], t2: [3, 4] },
    { t1: [3, 1], t2: [4, 0] },
    { t1: [4, 2], t2: [0, 1] }
  ],
  6: [
    { t1: [0, 1], t2: [2, 3] },
    { t1: [0, 4], t2: [1, 5] },
    { t1: [0, 2], t2: [3, 4] },
    { t1: [1, 2], t2: [3, 5] },
    { t1: [0, 5], t2: [2, 4] },
    { t1: [1, 3], t2: [4, 5] }
  ],
  7: [
    { t1: [0, 1], t2: [2, 3] },
    { t1: [0, 4], t2: [5, 6] },
    { t1: [1, 2], t2: [3, 4] },
    { t1: [0, 5], t2: [1, 6] },
    { t1: [2, 4], t2: [3, 5] },
    { t1: [0, 6], t2: [1, 3] },
    { t1: [2, 6], t2: [4, 5] }
  ]
};

const permutationsCache = {};
function getPermutations(n) {
  if (permutationsCache[n]) return permutationsCache[n];
  const results = [];
  const arr = Array.from({ length: n }, (_, i) => i);

  function permute(temp, remaining) {
    if (remaining.length === 0) {
      results.push(temp);
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      permute([...temp, remaining[i]], remaining.filter((_, idx) => idx !== i));
    }
  }

  permute([], arr);
  permutationsCache[n] = results;
  return results;
}

function getPlayerRating(player) {
  if (!player || !player.name) return 2.50;
  const match = player.name.match(/\((\d+(?:\.\d+)?)\)/);
  return match ? parseFloat(match[1]) : 2.50;
}

function buildStage1History() {
  const opponentRepeats = {};
  const partnerRepeats = {};

  if (appState.stage1Courts) {
    appState.stage1Courts.forEach(court => {
      if (court.matches) {
        court.matches.forEach(match => {
          if (!match.team1Player1 || !match.team1Player2 || !match.team2Player1 || !match.team2Player2) return;
          const p1 = match.team1Player1.name;
          const p2 = match.team1Player2.name;
          const p3 = match.team2Player1.name;
          const p4 = match.team2Player2.name;

          const increment = (map, n1, n2) => {
            if (!map[n1]) map[n1] = {};
            if (!map[n2]) map[n2] = {};
            map[n1][n2] = (map[n1][n2] || 0) + 1;
            map[n2][n1] = (map[n2][n1] || 0) + 1;
          };

          // Partners
          increment(partnerRepeats, p1, p2);
          increment(partnerRepeats, p3, p4);

          // Opponents
          increment(opponentRepeats, p1, p3);
          increment(opponentRepeats, p1, p4);
          increment(opponentRepeats, p2, p3);
          increment(opponentRepeats, p2, p4);
        });
      }
    });
  }

  return { opponentRepeats, partnerRepeats };
}

function evaluatePermutation(P, players, schedule, history) {
  let imbalanceCost = 0;
  let repeatCost = 0;

  const { opponentRepeats, partnerRepeats } = history;

  schedule.forEach(match => {
    const p1 = players[P[match.t1[0]]];
    const p2 = players[P[match.t1[1]]];
    const p3 = players[P[match.t2[0]]];
    const p4 = players[P[match.t2[1]]];

    const r1 = getPlayerRating(p1);
    const r2 = getPlayerRating(p2);
    const r3 = getPlayerRating(p3);
    const r4 = getPlayerRating(p4);

    const team1Rating = r1 + r2;
    const team2Rating = r3 + r4;
    const diff = Math.abs(team1Rating - team2Rating);

    // Sum of squared differences for imbalance cost
    imbalanceCost += diff * diff;

    // Check repeat matchups from Stage 1
    const checkOpponents = (n1, n2) => {
      if (opponentRepeats[n1] && opponentRepeats[n1][n2]) {
        repeatCost += opponentRepeats[n1][n2] * 10.0;
      }
    };
    const checkPartners = (n1, n2) => {
      if (partnerRepeats[n1] && partnerRepeats[n1][n2]) {
        repeatCost += partnerRepeats[n1][n2] * 5.0;
      }
    };

    checkOpponents(p1.name, p3.name);
    checkOpponents(p1.name, p4.name);
    checkOpponents(p2.name, p3.name);
    checkOpponents(p2.name, p4.name);

    checkPartners(p1.name, p2.name);
    checkPartners(p3.name, p4.name);
  });

  return imbalanceCost + repeatCost;
}

function selectOptimalPermutation(players, history) {
  const n = players.length;
  const schedule = COURT_SCHEDULES[n];
  if (!schedule) return Array.from({ length: n }, (_, i) => i);

  const permutations = getPermutations(n);
  let minCost = Infinity;
  let bestPermutations = [];

  permutations.forEach(P => {
    const cost = evaluatePermutation(P, players, schedule, history);
    if (cost < minCost) {
      minCost = cost;
      bestPermutations = [P];
    } else if (Math.abs(cost - minCost) < 0.0001) {
      bestPermutations.push(P);
    }
  });

  const randomIndex = Math.floor(Math.random() * bestPermutations.length);
  return bestPermutations[randomIndex];
}

function generatePairingsForCourt(court) {
  court.matches = [];
  // Reset all players scores to 0 for a fresh start
  court.players.forEach(p => p.totalScore = 0);
  court.activeRound = 1;

  const n = court.players.length;
  if (n < 4 || n > 7) return; // Supported sizes are 4, 5, 6, 7

  // Build Stage 1 history of repeat matchups
  const history = buildStage1History();

  // Find the optimal permutation of players
  const optimalP = selectOptimalPermutation(court.players, history);

  // Map the players to the optimal permutation
  const p = optimalP.map(idx => court.players[idx]);

  // Now build matches using the mapped players array `p`
  const schedule = COURT_SCHEDULES[n];
  schedule.forEach(match => {
    const p1 = p[match.t1[0]];
    const p2 = p[match.t1[1]];
    const p3 = p[match.t2[0]];
    const p4 = p[match.t2[1]];
    court.matches.push(new Match(p1, p2, p3, p4));
  });

  // Update the court's players array to match the optimized order
  court.players = p;
}

// ----------------------------------------------------
// INTEGER PARTITIONING ALGORITHM
// ----------------------------------------------------
function findOptimalPartition(playerCount, maxCourts = 6) {
  if (playerCount < 4 || playerCount > 42) return null; // Supported up to 6 courts * 7 players = 42

  const results = [];

  function backtrack(remaining, currentPartition) {
    if (remaining === 0) {
      if (currentPartition.length <= maxCourts) {
        results.push([...currentPartition]);
      }
      return;
    }
    if (currentPartition.length >= maxCourts) return;

    // Try sizes 7, 6, 5, 4 (prefer larger group sizes first as possibilities)
    for (let size of [7, 6, 5, 4]) {
      if (remaining >= size) {
        currentPartition.push(size);
        backtrack(remaining - size, currentPartition);
        currentPartition.pop();
      }
    }
  }

  backtrack(playerCount, []);

  if (results.length === 0) return null;

  // Sort partitions:
  // 1. Maximize number of groups/courts (parts length descending) to minimize byes
  // 2. Minimize spread difference (max - min ascending) to keep cohorts balanced
  // 3. Prefer larger min group size (descending) as a final tie-breaker
  results.sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }

    const diffA = Math.max(...a) - Math.min(...a);
    const diffB = Math.max(...b) - Math.min(...b);
    if (diffA !== diffB) {
      return diffA - diffB;
    }

    const minA = Math.min(...a);
    const minB = Math.min(...b);
    return minB - minA;
  });

  return results[0];
}

// ----------------------------------------------------
// INITIALIZATION AND ROUTER NAVIGATION
// ----------------------------------------------------

async function startApp() {
  // Initialize Entry State Cache for all 6 courts
  for (let i = 1; i <= 6; i++) {
    let initialNames = ['', '', '', ''];
    appState.entryState[i] = {
      names: initialNames,
      count: 4
    };
  }

  // Initialize Reserves Bench Staging Zone as empty
  appState.entryState.bench = {
    names: [],
    count: 0
  };


  // Set Admin Mode state (re-confirming if dynamic hash/params changed during parsing)
  appState.isAdmin = checkAdminMode();
  appState.currentView = appState.isAdmin ? 'court-setup' : 'user-landing';
  console.log("App loaded in", appState.isAdmin ? "ADMIN" : "USER", "mode");

  // Show correct initial screen immediately before network load
  navigateTo(appState.currentView);

  // Set up Event Listeners
  setupEventListeners();

  // Load & Sync from Firebase in Real-Time
  function subscribeToMixerUpdates() {
    if (unsubscribeMixer) {
      try {
        unsubscribeMixer();
      } catch (err) {
        console.error("Error unsubscribing:", err);
      }
    }
    clearTimeout(reconnectTimeout);

    updateSyncStatus('connecting');

    unsubscribeMixer = onSnapshot(mixerDocRef, (docSnap) => {
      lastSyncTime = Date.now();
      if (docSnap.exists()) {
        const data = docSnap.data();
        console.log("Real-time cloud update received!");

        // 1. Capture old state to dynamically advance the viewer
        const oldStage = appState.currentStage;
        const oldCourt = appState.courts ? appState.courts.find(c => c && c.courtNumber === appState.selectedCourtNumber) : null;
        const oldActiveRound = oldCourt ? oldCourt.activeRound : null;
        const wasViewingActive = oldActiveRound !== null && appState.viewingRound === oldActiveRound;

        // 2. Overwrite current state with database data
        appState.currentStage = data.currentStage || 1;
        appState.stage1Courts = data.stage1Courts || null;
        appState.draftingStyle = data.draftingStyle || 'snake';
        appState.stage2ViewingQualifying = data.stage2ViewingQualifying || false;
        appState.stage2PreviewTiers = data.stage2PreviewTiers || [];

        if (data.courts) {
          appState.courts = data.courts;
        }
        if (data.entryState) {
          appState.entryState = data.entryState;
        }
        appState.avatars = data.avatars || {};

        // SELF-HEALING AUTOMATIC RE-SEED IN FINAL STAGE
        if (appState.currentStage === 2) {
          const activeStage1Courts = (appState.stage1Courts || []).filter(c => c && c.isActive);
          const maxCourts = activeStage1Courts.length > 0 ? activeStage1Courts.length : 4;
          const currentActiveCourtsCount = appState.courts.filter(c => c && c.isActive).length;
          if (currentActiveCourtsCount > maxCourts) {
            console.log("Self-healing: Seeding mismatch detected. Automatically re-seeding to exactly " + maxCourts + " courts...");
            launchFinalStageAutomatically();
            return;
          }
        }

        // Determine navigation dynamically based on role and mixer activity
        const hasActiveMixer = appState.courts && appState.courts.some(c => c && c.isActive && c.matches && c.matches.length > 0);

        let targetView = appState.currentView || 'user-landing';
        if (appState.isAdmin) {
          // Only force admin navigation if they are just loading, or if tournament was reset
          if (!appState.currentView || appState.currentView === 'user-landing') {
            targetView = 'court-setup';
          } else if (!hasActiveMixer && appState.currentView !== 'court-setup' && appState.currentView !== 'player-entry') {
            targetView = 'court-setup';
          } else if (appState.currentView === 'dashboard') {
            targetView = 'court-setup'; // Admins use the player link to view dashboard
          }
        } else {
          // Players (User Mode) are automatically locked to active screens
          if (hasActiveMixer) {
            targetView = 'dashboard';
          } else {
            targetView = 'user-landing';
          }
        }

        // 3. Ensure selections are valid inside the active courts list and match activeRound changes
        const sourceCourts = (appState.currentStage === 2 && appState.stage2ViewingQualifying)
          ? appState.stage1Courts
          : appState.courts;

        const activeCourts = sourceCourts ? sourceCourts.filter(c => c && c.isActive) : [];
        if (activeCourts.length > 0) {
          const stageChanged = oldStage !== appState.currentStage;

          // If the selected court is no longer active, select the first active court and its activeRound
          if (!activeCourts.some(c => c && c.courtNumber === appState.selectedCourtNumber)) {
            appState.selectedCourtNumber = activeCourts[0].courtNumber;
            appState.viewingRound = activeCourts[0].activeRound;
          } else {
            const currentCourt = activeCourts.find(c => c && c.courtNumber === appState.selectedCourtNumber);
            if (currentCourt) {
              if (stageChanged ||
                  oldActiveRound === null ||
                  wasViewingActive ||
                  (currentCourt.matches && appState.viewingRound > currentCourt.matches.length)) {
                appState.viewingRound = currentCourt.activeRound;
              }
            }
          }
        }

        if (appState.currentView !== targetView) {
          navigateTo(targetView);
        }

        updateSyncStatus('saved');
      } else {
        console.log("No existing mixer in Cloud. Ready for new setup.");
        updateSyncStatus('new');
        const targetView = appState.isAdmin ? 'court-setup' : 'user-landing';
        if (appState.currentView !== targetView) {
          navigateTo(targetView);
        }
      }

      // Trigger render
      render();
    }, (error) => {
      console.error("Firebase real-time sync failed, retrying in 5 seconds...", error);
      updateSyncStatus('error');
      render();
      reconnectTimeout = setTimeout(subscribeToMixerUpdates, 5000);
    });
  }

  // Initial subscription
  subscribeToMixerUpdates();

  // Re-subscribe when returning online or switching back to the tab
  window.addEventListener('online', () => {
    console.log("Device back online, re-subscribing...");
    subscribeToMixerUpdates();
  });

  document.addEventListener('visibilitychange', () => {
    // Only force reconnect if visibility changes to visible, and we haven't synced in the last 3 seconds
    if (document.visibilityState === 'visible' && Date.now() - lastSyncTime > 3000) {
      console.log("App active/visible, refreshing Firestore subscription...");
      subscribeToMixerUpdates();
    }
  });
}

// Robust execution listener that runs under HMR, deferred load, and normal DOM parsing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  // Execute immediately if DOM is already interactive or complete
  startApp();
}

function navigateTo(viewName) {
  // Save state to cloud when navigating away from edit screens to commit any unsaved text inputs (like court or player names)
  if (appState.isAdmin && appState.currentView !== viewName && (appState.currentView === 'court-setup' || appState.currentView === 'player-entry')) {
    saveStateToCloud();
  }

  if (appState.currentView !== viewName) {
    editingPlayerKey = null;
  }
  appState.currentView = viewName;

  // Hide all screens
  const screens = ['view-user-landing', 'view-court-setup', 'view-player-entry', 'view-dashboard', 'view-stage2-review', 'view-admin-success', 'view-global-leaderboard'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('view-hidden');
  });

  // Show active screen
  let activeId = '';
  if (viewName === 'user-landing') activeId = 'view-user-landing';
  else if (viewName === 'court-setup') activeId = 'view-court-setup';
  else if (viewName === 'player-entry') activeId = 'view-player-entry';
  else if (viewName === 'dashboard') activeId = 'view-dashboard';
  else if (viewName === 'stage2-review') activeId = 'view-stage2-review';
  else if (viewName === 'admin-success') activeId = 'view-admin-success';
  else if (viewName === 'global-leaderboard') activeId = 'view-global-leaderboard';

  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.classList.remove('view-hidden');

  render();
}

// ----------------------------------------------------
// DOM RENDERING PIPELINES
// ----------------------------------------------------

function render() {
  // Recalculate scores for all courts dynamically to ensure 100% synchronization on render
  if (appState.courts) {
    appState.courts.forEach(recalculateScoresForCourt);
  }
  if (appState.stage1Courts) {
    appState.stage1Courts.forEach(recalculateScoresForCourt);
  }

  const sourceCourts = (appState.currentStage === 2 && appState.stage2ViewingQualifying)
    ? appState.stage1Courts
    : appState.courts;

  const activeCourts = sourceCourts ? sourceCourts.filter(c => c.isActive) : [];

  // 1. App Bar Updates
  const backBtn = document.getElementById('app-back-btn');
  const barTitle = document.getElementById('app-bar-title');
  const cloudSaveBtn = document.getElementById('btn-cloud-save');
  const syncStatusEl = document.getElementById('cloud-sync-status');

  // Determine if back button and cloud save should be visible based on role and view
  if (!appState.isAdmin) {
    // User Mode (Player) has back button and save button always hidden
    if (backBtn) backBtn.style.visibility = 'hidden';
    if (cloudSaveBtn) cloudSaveBtn.style.display = 'none';
    if (syncStatusEl) syncStatusEl.style.display = 'inline-flex'; // Reassure sync is active
    barTitle.textContent = appState.currentView === 'user-landing'
      ? 'Life Journey Pickleball'
      : '';
  } else {
    // Admin Mode behavior
    if (appState.currentView === 'court-setup') {
      if (backBtn) backBtn.style.visibility = 'hidden';
      barTitle.textContent = 'Life Journey Pickleball';
      if (cloudSaveBtn) cloudSaveBtn.style.display = 'none';
      if (syncStatusEl) syncStatusEl.style.display = 'none';
    } else if (appState.currentView === 'player-entry') {
      if (backBtn) backBtn.style.visibility = 'visible';
      barTitle.textContent = 'Life Journey Pickleball';
      if (cloudSaveBtn) cloudSaveBtn.style.display = 'inline-flex';
      if (syncStatusEl) syncStatusEl.style.display = 'inline-flex';
    } else if (appState.currentView === 'dashboard') {
      if (backBtn) backBtn.style.visibility = 'visible';
      barTitle.textContent = '';
      if (cloudSaveBtn) cloudSaveBtn.style.display = 'inline-flex';
      if (syncStatusEl) syncStatusEl.style.display = 'inline-flex';
    } else if (appState.currentView === 'stage2-review') {
      if (backBtn) backBtn.style.visibility = 'visible';
      barTitle.textContent = 'Seeding Preview';
      if (cloudSaveBtn) cloudSaveBtn.style.display = 'none';
      if (syncStatusEl) syncStatusEl.style.display = 'none';
    } else if (appState.currentView === 'admin-success') {
      if (backBtn) backBtn.style.visibility = 'hidden';
      barTitle.textContent = '';
      if (cloudSaveBtn) cloudSaveBtn.style.display = 'none';
      if (syncStatusEl) syncStatusEl.style.display = 'inline-flex';
    }
  }

  // 2. Render Screen Specific views
  if (appState.currentView === 'user-landing') {
    // Nothing special to render dynamically for landing standby view
  } else if (appState.currentView === 'court-setup') {
    renderCourtSetup();
  } else if (appState.currentView === 'player-entry') {
    renderPlayerEntry(activeCourts);
  } else if (appState.currentView === 'dashboard') {
    renderDashboard(activeCourts);
  } else if (appState.currentView === 'stage2-review') {
    renderStage2Review();
  } else if (appState.currentView === 'admin-success') {
    renderAdminSuccess();
  } else if (appState.currentView === 'global-leaderboard') {
    renderGlobalLeaderboard(sourceCourts);
  }

  // 3. Render Modal if open
  renderScoreModal();

  // 4. Toggle premium bottom navigation visibility & active tab states
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) {
    const shouldShow = (appState.currentView === 'dashboard' || appState.currentView === 'global-leaderboard') && !appState.modal.open;
    bottomNav.style.display = shouldShow ? 'flex' : 'none';

    if (shouldShow) {
      const btnRound1 = document.getElementById('nav-round1');
      const btnRound2 = document.getElementById('nav-round2');
      const btnLeaderboard = document.getElementById('nav-leaderboard');
      const btnSetup = document.getElementById('nav-setup');

      const isLeaderboardActive = appState.currentView === 'global-leaderboard';
      const isRound1Active = !isLeaderboardActive && (appState.currentStage === 1 || (appState.currentStage === 2 && appState.stage2ViewingQualifying));
      const isRound2Active = !isLeaderboardActive && !isRound1Active;

      if (btnRound1) btnRound1.classList.toggle('active', isRound1Active);
      if (btnRound2) btnRound2.classList.toggle('active', isRound2Active);
      if (btnLeaderboard) btnLeaderboard.classList.toggle('active', isLeaderboardActive);

      if (btnSetup) {
        btnSetup.style.display = appState.isAdmin ? 'flex' : 'none';
        btnSetup.classList.remove('active');
      }
    }
  }
}

// --- SCREEN 1: COURT SETUP RENDER ---
function renderCourtSetup() {
  const container = document.getElementById('court-list-container');
  container.innerHTML = '';

  appState.courts.forEach(court => {
    const courtNumber = court.courtNumber;
    const isActive = court.isActive;

    const card = document.createElement('div');
    card.className = `card court-card ${isActive ? 'active' : ''}`;
    card.setAttribute('data-court-number', courtNumber);

    card.innerHTML = `
      <div class="court-card-header">
        <div class="court-title-area">
          <span class="material-symbols-outlined">grid_view</span>
          <div class="court-name-wrapper">
            <span class="court-name-text">${court.courtName || `Court ${courtNumber}`}</span>
            <button class="court-name-edit-btn" aria-label="Edit court name">
              <span class="material-symbols-outlined" style="font-size: 16px;">edit</span>
            </button>
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" class="court-toggle" ${isActive ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
      ${isActive ? `
        <button class="add-players-btn neon-glow-active">
          <span class="material-symbols-outlined">person_add</span>
          Add Players
        </button>
      ` : ''}
    `;

    // Switch Toggles listener
    const toggle = card.querySelector('.court-toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        const activeCourt = appState.courts.find(c => c.courtNumber === courtNumber);
        if (activeCourt) {
          activeCourt.isActive = toggle.checked;
        }
        saveStateToCloud(); // Save instantly to Cloud to sync all views and prevent race conditions!
        render();
      });
    }

    // Court Name Edit Button listener
    const editBtn = card.querySelector('.court-name-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCourtNameModal(courtNumber);
      });
    }

    // Add players button listener
    if (isActive) {
      const btn = card.querySelector('.add-players-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          // Select this court as the active input court
          appState.selectedCourtNumber = courtNumber;
          navigateTo('player-entry');
        });
      }
    }

    container.appendChild(card);
  });

  // Dynamic UI state based on active mixer
  const hasActiveMixer = (appState.courts && appState.courts.some(c => c.isActive && c.matches && c.matches.length > 0)) || appState.currentStage > 1;
  const title = document.getElementById('setup-title');
  const subtitle = document.getElementById('setup-subtitle');
  const warningBanner = document.getElementById('setup-active-warning');
  const resumeBtn = document.getElementById('btn-resume-dashboard');
  const historyZone = document.getElementById('setup-history-zone');

  if (hasActiveMixer) {
    if (title) title.textContent = 'Tournament Settings';
    if (subtitle) subtitle.textContent = 'Modify active courts or players. Warning: Editing active courts may require match regeneration.';
    if (warningBanner) warningBanner.style.display = 'flex';
    if (resumeBtn) resumeBtn.style.display = 'flex';
    if (historyZone) historyZone.style.display = 'block';
  } else {
    if (title) title.textContent = 'New Mixer Setup';
    if (subtitle) subtitle.textContent = 'Select the courts available for this tournament block. Add designated players if required.';
    if (warningBanner) warningBanner.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (historyZone) historyZone.style.display = 'none';
  }

  // Next button activation & label
  const hasActive = appState.courts.some(c => c.isActive);
  const nextBtn = document.getElementById('setup-next-btn');
  if (nextBtn) {
    nextBtn.disabled = !hasActive;
    nextBtn.innerHTML = hasActiveMixer
      ? `Edit Players & Regenerate <span class="material-symbols-outlined">refresh</span>`
      : `Next: Enter Players <span class="material-symbols-outlined">arrow_forward</span>`;
  }
}

// Helper to find the best player name match in a court (with fuzzy/DUPR fallback)
function findBestPlayerMatch(court, searchName) {
  if (!court.players || court.players.length === 0) return null;
  
  const target = searchName.trim().toLowerCase();
  const stripDupr = (name) => name.replace(/\s*\(\d+(?:\.\d+)?\)/g, '').trim().toLowerCase();
  const targetStripped = stripDupr(searchName);
  
  const getDuprString = (name) => {
    const m = name.match(/\((\d+(?:\.\d+)?)\)/);
    return m ? m[1] : null;
  };
  const targetDupr = getDuprString(searchName);
  
  // 1. Try exact match (case insensitive)
  let match = court.players.find(p => p.name.trim().toLowerCase() === target);
  if (match) return match;
  
  // 2. Try matching without DUPR rating exactly (e.g. "Chin Say Leong" vs "Chin Say Leong (2.529)")
  match = court.players.find(p => stripDupr(p.name) === targetStripped);
  if (match) return match;
  
  // 3. Try substring match but require DUPR rating match if both have it
  match = court.players.find(p => {
    const pStripped = stripDupr(p.name);
    const pDupr = getDuprString(p.name);
    
    const isSubstring = pStripped.includes(targetStripped) || targetStripped.includes(pStripped);
    if (isSubstring) {
      if (targetDupr && pDupr) {
        return targetDupr === pDupr; // Require DUPR to match if both specified it
      }
      return true;
    }
    return false;
  });
  if (match) return match;
  
  return null;
}

// Helper to propagate player name changes dynamically to live tournament players and matches
function propagatePlayerNameChange(courtNumber, oldName, newName) {
  if (!oldName || !newName) return;
  const targetOld = oldName.trim();
  const targetNew = newName.trim();
  if (targetOld === targetNew || targetOld === '') return;

  const updateList = (courtsList) => {
    if (!courtsList) return;
    courtsList.forEach(court => {
      // Find the player in this court using fuzzy matching
      const playerObj = findBestPlayerMatch(court, targetOld);
      if (playerObj) {
        const actualOldName = playerObj.name; // Keep the actual old name from the live game
        playerObj.name = targetNew;
        
        // Update in matches using the actual old name
        if (court.matches) {
          court.matches.forEach(match => {
            if (match.team1Player1 && match.team1Player1.name === actualOldName) match.team1Player1.name = targetNew;
            if (match.team1Player2 && match.team1Player2.name === actualOldName) match.team1Player2.name = targetNew;
            if (match.team2Player1 && match.team2Player1.name === actualOldName) match.team2Player1.name = targetNew;
            if (match.team2Player2 && match.team2Player2.name === actualOldName) match.team2Player2.name = targetNew;
          });
        }
      }
    });
  };

  updateList(appState.courts);
  updateList(appState.stage1Courts);
}

// --- SCREEN 2: PLAYER ENTRY RENDER ---
let listToFocus = null;

function renderPlayerEntry(activeCourts) {
  const container = document.getElementById('player-board-container');
  if (!container) return;
  container.innerHTML = '';

  // Defensive: Ensure appState.entryState exists
  if (!appState.entryState) {
    appState.entryState = {};
  }

  // 1. Render Court Columns
  activeCourts.forEach(court => {
    const courtNumber = court.courtNumber;
    const col = document.createElement('div');
    col.className = 'board-column';
    col.setAttribute('data-list-id', courtNumber.toString());

    // Defensive: Get court entry and ensure names exists
    let entry = appState.entryState[courtNumber];
    if (!entry) {
      entry = { names: [], count: 4 };
      appState.entryState[courtNumber] = entry;
    }
    if (!entry.names) {
      entry.names = [];
    }
    const filledCount = entry.names.filter(n => n && n.trim() !== '').length;

    // Capacity validation badge styling
    let badgeText = `${filledCount}/7 Players`;
    let badgeClass = 'valid';

    if (filledCount < 4) {
      badgeText = `Needs 4-7 Players`;
      badgeClass = 'invalid';
    } else if (filledCount === 7) {
      badgeText = `7/7 (Full)`;
      badgeClass = 'valid';
    }

    const avgDupr = getCourtAverageDUPR(entry.names);
    const avgBadgeHtml = avgDupr > 0
      ? `<span class="avg-dupr-badge" style="font-size: 11px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; color: var(--neon); background: rgba(255, 214, 10, 0.1); border: 1px solid rgba(255, 214, 10, 0.35); padding: 2px 8px; border-radius: 6px; box-shadow: 0 0 10px rgba(255, 214, 10, 0.15); display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;">Avg: ${avgDupr.toFixed(2)}</span>`
      : '';

    const colHeader = document.createElement('div');
    colHeader.className = 'board-column-header';
    colHeader.innerHTML = `
      <div class="board-column-title" style="display: flex; align-items: center;">
        <span class="material-symbols-outlined">grid_view</span>
        <span>${court.courtName || `Court ${courtNumber}`}</span>
        ${avgBadgeHtml}
      </div>
      <span class="capacity-badge ${badgeClass}">${badgeText}</span>
    `;
    col.appendChild(colHeader);

    const dragList = document.createElement('div');
    dragList.className = 'player-drag-list';
    dragList.setAttribute('data-list-id', courtNumber.toString());

    entry.names.forEach((name, idx) => {
      const item = document.createElement('div');
      item.className = 'player-drag-item';
      item.setAttribute('data-index', idx.toString());

      const isEditing = editingPlayerKey === `${courtNumber}-${idx}`;

      if (isEditing) {
        item.innerHTML = `
          <span class="material-symbols-outlined drag-handle">drag_indicator</span>
          <input type="text" placeholder="Player Name" class="player-drag-input" value="${name || ''}" data-idx="${idx}">
          <button class="save-player-btn" aria-label="Save player">
            <span class="material-symbols-outlined" style="font-size: 18px;">check</span>
          </button>
          <button class="cancel-player-btn" aria-label="Cancel editing">
            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
          </button>
        `;

        const input = item.querySelector('.player-drag-input');
        if (input) {
          setTimeout(() => {
            input.focus();
            if (input.value) {
              input.select();
            }
          }, 50);

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          });
        }

        const saveEdit = () => {
          const newName = input.value.trim();
          const oldName = name;

          const currentEntry = appState.entryState[courtNumber];
          if (currentEntry && currentEntry.names) {
            currentEntry.names[idx] = newName;
            propagatePlayerNameChange(courtNumber, oldName, newName);
          }

          editingPlayerKey = null;
          renderPlayerEntry(activeCourts);
          saveStateToCloud();
        };

        const cancelEdit = () => {
          const currentEntry = appState.entryState[courtNumber];
          if (currentEntry && currentEntry.names && !name) {
            currentEntry.names.splice(idx, 1);
          }
          editingPlayerKey = null;
          renderPlayerEntry(activeCourts);
        };

        const saveBtn = item.querySelector('.save-player-btn');
        if (saveBtn) saveBtn.addEventListener('click', saveEdit);

        const cancelBtn = item.querySelector('.cancel-player-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', cancelEdit);

      } else {
        item.innerHTML = `
          <span class="material-symbols-outlined drag-handle">drag_indicator</span>
          <span class="player-display-name">${name || 'New Player'}</span>
          <button class="edit-player-btn" aria-label="Edit player">
            <span class="material-symbols-outlined" style="font-size: 18px;">edit</span>
          </button>
          <button class="delete-player-btn" aria-label="Delete player">
            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
          </button>
        `;

        const editBtn = item.querySelector('.edit-player-btn');
        if (editBtn) {
          editBtn.addEventListener('click', () => {
            editingPlayerKey = `${courtNumber}-${idx}`;
            renderPlayerEntry(activeCourts);
          });
        }

        const deleteBtn = item.querySelector('.delete-player-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', () => {
            const currentEntry = appState.entryState[courtNumber];
            if (currentEntry && currentEntry.names) {
              currentEntry.names.splice(idx, 1);
            }
            editingPlayerKey = null;
            renderPlayerEntry(activeCourts);
            saveStateToCloud();
          });
        }
      }

      dragList.appendChild(item);
    });

    col.appendChild(dragList);

    // Inline + Add Player button at bottom of court list (max 7 players)
    if (entry.names.length < 7) {
      const addBtn = document.createElement('button');
      addBtn.className = 'inline-add-player-btn';
      addBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">add</span> Add Player`;
      addBtn.addEventListener('click', () => {
        const currentEntry = appState.entryState[courtNumber];
        if (currentEntry) {
          if (!currentEntry.names) currentEntry.names = [];
          currentEntry.names.push('');
          editingPlayerKey = `${courtNumber}-${currentEntry.names.length - 1}`;
        }
        renderPlayerEntry(activeCourts);
      });
      col.appendChild(addBtn);
    }

    container.appendChild(col);
  });

  // 4. Initialize PointerEvent Drag & Drop
  initDragAndDrop(activeCourts);

  // 5. Update validation button state
  validateEntryGeneration(activeCourts);
}

function validateEntryGeneration(activeCourts) {
  let allValid = true;

  for (let court of activeCourts) {
    const entry = appState.entryState[court.courtNumber];
    if (!entry) {
      allValid = false;
      break;
    }
    const filledCount = entry.names.filter(n => n.trim() !== '').length;
    // Each active court must have 4, 5, 6, or 7 players to generate pairings
    if (filledCount < 4 || filledCount > 7) {
      allValid = false;
      break;
    }
  }

  const generateBtn = document.getElementById('entry-generate-btn');
  if (generateBtn) {
    generateBtn.disabled = !allValid;
  }
}

function initDragAndDrop(activeCourts) {
  const handles = document.querySelectorAll('.drag-handle');

  handles.forEach(handle => {
    // Prevent default touch gestures so it doesn't scroll the screen while dragging
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', (e) => {
      // Only drag on left click
      if (e.button !== 0) return;

      const item = handle.closest('.player-drag-item');
      if (!item) return;

      const sourceListEl = item.closest('.player-drag-list');
      if (!sourceListEl) return;

      const sourceListId = sourceListEl.getAttribute('data-list-id');
      const sourceIndex = parseInt(item.getAttribute('data-index'), 10);
      if (!appState.entryState) appState.entryState = {};
      const entry = appState.entryState[sourceListId] || { names: [] };
      if (!entry.names) entry.names = [];
      const playerName = entry.names[sourceIndex] || '';

      // Prevent focus or text selection issues while dragging
      e.preventDefault();

      // Capture the pointer
      handle.setPointerCapture(e.pointerId);

      // Record coordinates and bounding boxes
      const startX = e.clientX;
      const startY = e.clientY;
      const itemRect = item.getBoundingClientRect();

      // Add dragging style to source item
      item.classList.add('is-dragging');

      // Create beautiful floating Drag Ghost
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.style.width = `${itemRect.width}px`;
      ghost.style.height = `${itemRect.height}px`;
      ghost.style.left = `${itemRect.left}px`;
      ghost.style.top = `${itemRect.top}px`;
      ghost.innerHTML = `
        <span class="material-symbols-outlined drag-handle">drag_indicator</span>
        <span>${playerName || 'New Player'}</span>
      `;
      document.body.appendChild(ghost);

      // Create or locate Drop Indicator Line
      let dropIndicator = document.querySelector('.drop-indicator');
      if (!dropIndicator) {
        dropIndicator = document.createElement('div');
        dropIndicator.className = 'drop-indicator';
      }

      let currentTargetList = null;
      let currentTargetColumn = null;

      const onPointerMove = (moveEv) => {
        const dx = moveEv.clientX - startX;
        const dy = moveEv.clientY - startY;

        // Position the ghost dynamically to follow pointer
        ghost.style.left = `${itemRect.left + dx}px`;
        ghost.style.top = `${itemRect.top + dy}px`;

        // Check which board column the pointer is currently hovering over
        let hoveredCol = null;
        const cols = document.querySelectorAll('.board-column');

        cols.forEach(col => {
          const rect = col.getBoundingClientRect();
          if (moveEv.clientX >= rect.left && moveEv.clientX <= rect.right &&
            moveEv.clientY >= rect.top && moveEv.clientY <= rect.bottom) {
            hoveredCol = col;
          }
        });

        // Clean up hover classes
        cols.forEach(col => col.classList.remove('active-drop-target'));

        if (hoveredCol) {
          currentTargetColumn = hoveredCol;
          currentTargetList = hoveredCol.querySelector('.player-drag-list');
          const targetListId = currentTargetList.getAttribute('data-list-id');

          // Enforce max 7 player slots on courts
          const targetCapacity = 7;
          const targetNames = appState.entryState[targetListId].names;
          const currentCount = targetNames.length;

          // Check if dragging from another list would overflow target capacity
          if (sourceListId !== targetListId && currentCount >= targetCapacity) {
            // Court is full, block dropping!
            currentTargetColumn.classList.remove('active-drop-target');
            if (dropIndicator.parentNode) dropIndicator.remove();
            return;
          }

          currentTargetColumn.classList.add('active-drop-target');

          // Find the insertion point (which sibling index inside list)
          const siblingItems = [...currentTargetList.querySelectorAll('.player-drag-item:not(.is-dragging)')];

          let nextSibling = siblingItems.find(sibling => {
            const siblingRect = sibling.getBoundingClientRect();
            return moveEv.clientY < siblingRect.top + siblingRect.height / 2;
          });

          if (nextSibling) {
            currentTargetList.insertBefore(dropIndicator, nextSibling);
          } else {
            currentTargetList.appendChild(dropIndicator);
          }
        } else {
          // Off-screen or not hovering over a drop board
          if (dropIndicator.parentNode) dropIndicator.remove();
          currentTargetList = null;
          currentTargetColumn = null;
        }
      };

      const onPointerUp = (upEv) => {
        // Clean up events
        handle.releasePointerCapture(upEv.pointerId);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);

        item.classList.remove('is-dragging');
        ghost.remove();

        document.querySelectorAll('.board-column').forEach(col => {
          col.classList.remove('active-drop-target');
        });

        // If dropped successfully inside a valid list insert slot
        if (currentTargetList && dropIndicator.parentNode) {
          const targetListId = currentTargetList.getAttribute('data-list-id');

          // Calculate drop placement index inside DOM children list
          const children = Array.from(currentTargetList.children);
          let finalIndex = children.indexOf(dropIndicator);

          dropIndicator.remove();

          // Mutate the app state (with defensive checks)
          if (!appState.entryState) appState.entryState = {};

          const sourceEntry = appState.entryState[sourceListId];
          if (!sourceEntry) return;
          if (!sourceEntry.names) sourceEntry.names = [];
          const sourceArray = sourceEntry.names;

          const targetEntry = appState.entryState[targetListId];
          if (!targetEntry) return;
          if (!targetEntry.names) targetEntry.names = [];
          const targetArray = targetEntry.names;

          // Remove from source array
          const [movedName] = sourceArray.splice(sourceIndex, 1);

          // If inserting into target array (compensating for the deletion index if in same array)
          let adjustedIndex = finalIndex;
          if (sourceListId === targetListId && finalIndex > sourceIndex) {
            adjustedIndex = finalIndex - 1;
          }

          // Insert into target list array
          targetArray.splice(adjustedIndex, 0, movedName);

          // Reset editing key on drag and drop reordering
          editingPlayerKey = null;

          // Trigger rendering update
          renderPlayerEntry(activeCourts);
          saveStateToCloud(); // Save dynamically to cloud!
        } else {
          // Dropped outside, clean up indicator
          if (dropIndicator.parentNode) dropIndicator.remove();
        }
      };

      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
    });
  });
}


// --- HELPER TO STRIP DUPR RATING FOR PLAYERS ---
function formatPlayerName(name) {
  const showDuprParam = new URLSearchParams(window.location.search).get('show_dupr') === 'true';
  if (!appState.isAdmin && !showDuprParam && name) {
    // Strips " (X.XX)" or " (X.X)"
    return name.replace(/\s*\(\d+\.\d+\)/, '');
  }
  return name;
}

// Helper to extract DUPR rating from player name
function getPlayerDupr(name) {
  if (!name) return 2.50;
  const match = name.match(/\((\d+(?:\.\d+)?)\)/);
  if (match && match[1]) {
    const val = parseFloat(match[1]);
    if (!isNaN(val)) return val;
  }
  return 2.50;
}

// Helper to clean rating suffix for matching
function getCleanPlayerName(name) {
  if (!name) return '';
  return name.replace(/\s*\(\d+(?:\.\d+)?\)/, '').trim();
}

// Get initials (up to 2 characters)
function getPlayerInitials(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]).substring(0, 2);
}

// Pick a beautiful color gradient based on player name hash
function getAvatarGradient(name) {
  const colors = [
    'linear-gradient(135deg, #FF5E3A 0%, #FF2A68 100%)', // red/pink
    'linear-gradient(135deg, #FF9500 0%, #FF5E3A 100%)', // orange
    'linear-gradient(135deg, #5AC8FA 0%, #34AADC 100%)', // light blue
    'linear-gradient(135deg, #4CD964 0%, #5AD8A6 100%)', // green
    'linear-gradient(135deg, #5856D6 0%, #C86DD7 100%)', // purple
    'linear-gradient(135deg, #1D62F0 0%, #1AD6FD 100%)', // cyan
  ];
  if (!name) return colors[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

// Render dynamic avatar or fallback initials
function renderPlayerAvatar(player, size = 28) {
  const cleanName = getCleanPlayerName(player.name);
  const avatar = appState.avatars && appState.avatars[cleanName];
  if (avatar) {
    return `<img src="${avatar}" class="player-avatar-circle" style="width: ${size}px; height: ${size}px;" alt="${cleanName}">`;
  }
  const initials = getPlayerInitials(cleanName);
  const gradient = getAvatarGradient(cleanName);
  return `
    <div class="player-avatar-initials" style="width: ${size}px; height: ${size}px; font-size: ${size * 0.4}px; background: ${gradient}">
      ${initials}
    </div>
  `;
}

// Helper to compute overall ranks map (playerName -> rank)
function getGlobalRanksMap() {
  const ranksMap = new Map();
  let allPlayers = [];
  
  const targetCourts = (appState.currentStage === 2 && appState.stage2ViewingQualifying)
    ? appState.stage1Courts
    : appState.courts;

  if (targetCourts && Array.isArray(targetCourts)) {
    targetCourts.forEach(court => {
      if (court.isActive && court.players && Array.isArray(court.players)) {
        court.players.forEach(p => {
          if (!allPlayers.some(existing => existing.name === p.name)) {
            allPlayers.push({
              name: p.name,
              totalScore: p.totalScore || 0,
              pointsPlayed: p.pointsPlayed || 0
            });
          }
        });
      }
    });
  }

  // Sort descending by total score, then by points played (tiebreaker)
  allPlayers.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return b.pointsPlayed - a.pointsPlayed;
  });

  allPlayers.forEach((p, index) => {
    ranksMap.set(p.name, index + 1);
  });

  return ranksMap;
}

// --- SCREEN 3: DASHBOARD RENDER ---
function renderDashboard(activeCourts) {
  // If no selected court, default to the first active court
  if (activeCourts.length > 0 && !activeCourts.some(c => c.courtNumber === appState.selectedCourtNumber)) {
    appState.selectedCourtNumber = activeCourts[0].courtNumber;
  }

  const court = activeCourts.find(c => c.courtNumber === appState.selectedCourtNumber) || activeCourts[0];
  const totalRounds = court ? court.matches.length : 0;

  const TIER_NAMES = ["Gold Tier", "Silver Tier", "Bronze Tier", "Copper Tier", "Iron Tier", "Slate Tier"];

  // Update Stage 2 UI layout and text
  const stageBadge = document.getElementById('dashboard-stage-badge');
  const advanceCard = document.getElementById('dashboard-advance-card');
  const backLinkContainer = document.getElementById('stage2-back-link-container');
  const dashboardTitle = document.getElementById('dashboard-title');
  const leaderboardTitleText = document.getElementById('leaderboard-title-text');

  if (appState.currentStage === 2) {
    if (stageBadge) stageBadge.style.display = appState.stage2ViewingQualifying ? 'none' : 'block';

    // Check if there is an active court mismatch (seeding exceeded available courts)
    const activeStage1Courts = appState.stage1Courts ? appState.stage1Courts.filter(c => c.isActive) : [];
    const maxCourts = activeStage1Courts.length > 0 ? activeStage1Courts.length : 4;
    const currentActiveCourtsCount = appState.courts.filter(c => c.isActive).length;

    if (currentActiveCourtsCount > maxCourts && appState.isAdmin) {
      if (advanceCard) {
        advanceCard.style.display = 'flex';
        const advanceIcon = document.getElementById('dashboard-advance-icon');
        const advanceTitle = document.getElementById('dashboard-advance-title');
        const advanceDesc = document.getElementById('dashboard-advance-desc');
        const advanceBtnText = document.getElementById('btn-dashboard-advance-text');

        if (advanceIcon) advanceIcon.textContent = 'build';
        if (advanceTitle) advanceTitle.textContent = 'Seeding Mismatch Detected';
        if (advanceDesc) advanceDesc.textContent = `Final Stage is running on ${currentActiveCourtsCount} courts, but you set up only ${maxCourts} courts in Group Stage. Click below to instantly re-seed into exactly ${maxCourts} tiers.`;
        if (advanceBtnText) advanceBtnText.textContent = 'Re-Seed Final Stage';
      }
    } else {
      if (advanceCard) advanceCard.style.display = 'none';
    }

    if (backLinkContainer) backLinkContainer.style.display = 'flex';

    const toggleText = appState.stage2ViewingQualifying ? 'Back to Final Stage Standings' : 'View Group Stage Standings';
    const btnToggleText = document.getElementById('btn-toggle-stage-text');
    if (btnToggleText) btnToggleText.textContent = toggleText;

    if (dashboardTitle) {
      dashboardTitle.textContent = appState.stage2ViewingQualifying ? 'Group Stage Dashboard' : 'Final Stage Dashboard';
    }
    if (leaderboardTitleText) {
      leaderboardTitleText.textContent = appState.stage2ViewingQualifying ? 'Live Leaderboard (Group Stage)' : 'Live Leaderboard (Final Stage)';
    }
  } else {
    if (stageBadge) stageBadge.style.display = 'none';
    if (backLinkContainer) backLinkContainer.style.display = 'none';
    if (dashboardTitle) dashboardTitle.textContent = 'Group Stage Dashboard';
    if (leaderboardTitleText) leaderboardTitleText.textContent = 'Live Leaderboard (Group Stage)';

    // Always show advancement options during Group Stage (Stage 1) for Admins
    if (appState.currentStage === 1 && appState.isAdmin) {
      if (advanceCard) {
        advanceCard.style.display = 'flex';
        const advanceIcon = document.getElementById('dashboard-advance-icon');
        const advanceTitle = document.getElementById('dashboard-advance-title');
        const advanceDesc = document.getElementById('dashboard-advance-desc');
        const advanceBtnText = document.getElementById('btn-dashboard-advance-text');

        if (checkStage1Completion()) {
          if (advanceIcon) advanceIcon.textContent = 'celebration';
          if (advanceTitle) advanceTitle.textContent = 'Group Stage Completed!';
          if (advanceDesc) advanceDesc.textContent = 'All qualifying matches across all courts have been completed. Seeding tiers are ready!';
          if (advanceBtnText) advanceBtnText.textContent = 'Advance to Final Stage';
        } else {
          if (advanceIcon) advanceIcon.textContent = 'warning';
          if (advanceTitle) advanceTitle.textContent = 'Final Stage Transition';
          if (advanceDesc) advanceDesc.textContent = 'Group Stage qualifying matches are still in progress. You can manually force-advance to Final Stage based on current scores.';
          if (advanceBtnText) advanceBtnText.textContent = 'Force-Start Final Stage';
        }
      }
    } else {
      if (advanceCard) advanceCard.style.display = 'none';
    }
  }

  // 1. Render Court Select Tabs
  const courtTabs = document.getElementById('dashboard-court-tabs');
  courtTabs.innerHTML = '';
  activeCourts.forEach(c => {
    const isSelected = c.courtNumber === appState.selectedCourtNumber;

    const completedCount = c.matches ? c.matches.filter(m => m.isCompleted).length : 0;
    const totalCount = c.matches ? c.matches.length : 0;
    const courtCompleted = totalCount > 0 && completedCount === totalCount;

    const tab = document.createElement('div');
    tab.className = `tab-chip ${isSelected ? 'active' : ''} ${courtCompleted ? 'completed' : ''}`;

    const courtDisplayName = c.courtName || `Court ${c.courtNumber}`;

    if (appState.currentStage === 2 && !appState.stage2ViewingQualifying) {
      const tierName = (TIER_NAMES[c.courtNumber - 1] || `Tier ${c.courtNumber}`).replace(/\s*tier/gi, '');
      
      let badgeHtml = '';
      if (courtCompleted) {
        badgeHtml = `<span class="material-symbols-outlined" style="font-size: 15px; font-weight: 800; color: var(--green);">check_circle</span>`;
      } else if (completedCount > 0) {
        badgeHtml = `<span class="tab-progress-badge" style="margin-left: 0; margin-top: 2px;">${completedCount}/${totalCount}</span>`;
      }

      tab.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.2; height: 100%;">
          <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700;">
            ${badgeHtml}
            ${courtDisplayName}
          </span>
          <span style="font-size: 8px; font-weight: 800; opacity: 0.6; letter-spacing: 1px; text-transform: uppercase; margin-top: 1px;">${tierName}</span>
        </div>
      `;
    } else {
      if (courtCompleted) {
        tab.innerHTML = `<span class="material-symbols-outlined" style="font-size: 15px; font-weight: 800; color: var(--green); margin-right: 6px;">check_circle</span>${courtDisplayName}`;
      } else if (completedCount > 0) {
        tab.innerHTML = `${courtDisplayName}<span class="tab-progress-badge">${completedCount}/${totalCount}</span>`;
      } else {
        tab.textContent = courtDisplayName;
      }
    }

    tab.addEventListener('click', () => {
      appState.selectedCourtNumber = c.courtNumber;
      appState.viewingRound = c.activeRound;
      render();
    });
    courtTabs.appendChild(tab);
  });

  // 2. Render Round Selector chips
  const roundChips = document.getElementById('dashboard-round-chips');
  roundChips.innerHTML = '';

  for (let i = 1; i <= totalRounds; i++) {
    const isViewing = i === appState.viewingRound;
    const isActiveRound = i === court.activeRound;
    const isCompleted = court.matches[i - 1] && court.matches[i - 1].isCompleted;

    const chip = document.createElement('div');
    chip.className = `round-chip ${isViewing ? 'viewing' : ''} ${isActiveRound ? 'active-round' : ''} ${isCompleted ? 'completed' : ''}`;

    if (isCompleted) {
      chip.innerHTML = `<span class="material-symbols-outlined" style="font-size: 15px; font-weight: 800; color: var(--green); margin-right: 6px;">check_circle</span>Game ${i}`;
    } else {
      chip.textContent = `Game ${i}`;
    }

    chip.addEventListener('click', () => {
      appState.viewingRound = i;
      render();
    });
    roundChips.appendChild(chip);
  }

  // 3. Render Match Card
  const matchCard = document.getElementById('dashboard-match-card');
  const matchIndex = appState.viewingRound - 1;
  const match = court.matches[matchIndex];

  if (match) {
    let courtLabel = court.courtName || `Court ${court.courtNumber}`;
    if (appState.currentStage === 2 && !appState.stage2ViewingQualifying) {
      const tierName = (TIER_NAMES[court.courtNumber - 1] || `Tier ${court.courtNumber}`).replace(/\s*tier/gi, '');
      const courtDisplayName = court.courtName || `Court ${court.courtNumber}`;
      courtLabel = `
        <div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.2;">
          <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">${courtDisplayName}</span>
          <span style="font-size: 8px; font-weight: 800; color: var(--text-secondary); opacity: 0.7; letter-spacing: 0.8px; text-transform: uppercase; margin-top: 1px;">${tierName}</span>
        </div>
      `;
    }

    // Render Card Contents
    matchCard.innerHTML = `
      <div class="match-card-status-row" style="flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; gap: 8px; align-items: center;">
          <div class="status-chip">
            ${match.isCompleted ? `
              <span class="material-symbols-outlined" style="color: var(--green); font-size: 14px;">check_circle</span>
              <span>COMPLETED</span>
            ` : `
              <span class="pulse-dot"></span>
              <span>IN PROGRESS</span>
            `}
          </div>
          <div style="font-size: 13px; font-weight: 700; color: var(--text-secondary); background: var(--surface-highest); padding: 4px 10px; border-radius: 6px;">
            ${courtLabel}
          </div>
        </div>
        ${match.isCompleted ? `
          <div class="match-card-score-container" style="margin-left: auto;">
            <div class="match-card-score">${match.team1Score} - ${match.team2Score}</div>
            <div class="match-card-score-diff">
              Diff: ${Math.abs(match.team1Score - match.team2Score)}
            </div>
          </div>
        ` : ''}
      </div>
      <div class="match-teams-row">
        <div class="match-team" style="gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderPlayerAvatar(match.team1Player1, 24)}
            <h4 style="margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary); text-align: left;">${formatPlayerName(match.team1Player1.name)}</h4>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderPlayerAvatar(match.team1Player2, 24)}
            <h4 style="margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary); text-align: left;">${formatPlayerName(match.team1Player2.name)}</h4>
          </div>
        </div>
        <div class="vs-badge">VS</div>
        <div class="match-team team-2" style="gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-end;">
            <h4 style="margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary); text-align: right;">${formatPlayerName(match.team2Player1.name)}</h4>
            ${renderPlayerAvatar(match.team2Player1, 24)}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-end;">
            <h4 style="margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary); text-align: right;">${formatPlayerName(match.team2Player2.name)}</h4>
            ${renderPlayerAvatar(match.team2Player2, 24)}
          </div>
        </div>
      </div>
      <button class="match-action-btn neon-glow-active">
        <span class="material-symbols-outlined">${match.isCompleted ? 'edit_square' : 'add_circle'}</span>
        ${match.isCompleted ? 'Edit Score' : 'Input Score'}
      </button>
    `;

    // Action button opens Modal Stepper
    const actionBtn = matchCard.querySelector('.match-action-btn');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        appState.modal.open = true;
        appState.modal.courtNumber = court.courtNumber;
        appState.modal.matchIndex = matchIndex;

        if (match.isCompleted) {
          appState.modal.score1 = match.team1Score;
          appState.modal.score2 = match.team2Score;
        } else {
          appState.modal.score1 = 0;
          appState.modal.score2 = 0;
        }

        render();
      });
    }

    // 4. Render Next Round info
    const deckNames = document.getElementById('dashboard-on-deck-names');
    if (matchIndex + 1 < court.matches.length) {
      const nextMatch = court.matches[matchIndex + 1];
      deckNames.innerHTML = `
        <div class="next-team" style="display: flex; align-items: center; gap: 6px;">
          ${renderPlayerAvatar(nextMatch.team1Player1, 20)}
          ${renderPlayerAvatar(nextMatch.team1Player2, 20)}
          <span style="font-weight: 700; color: var(--text-primary); margin-left: 4px;">
            ${formatPlayerName(nextMatch.team1Player1.name)} & ${formatPlayerName(nextMatch.team1Player2.name)}
          </span>
        </div>
        <div class="next-vs">VS</div>
        <div class="next-team" style="display: flex; align-items: center; gap: 6px; justify-content: flex-end;">
          <span style="font-weight: 700; color: var(--text-primary); margin-right: 4px;">
            ${formatPlayerName(nextMatch.team2Player1.name)} & ${formatPlayerName(nextMatch.team2Player2.name)}
          </span>
          ${renderPlayerAvatar(nextMatch.team2Player1, 20)}
          ${renderPlayerAvatar(nextMatch.team2Player2, 20)}
        </div>
      `;
      document.getElementById('dashboard-on-deck-banner').style.display = 'flex';
    } else {
      document.getElementById('dashboard-on-deck-banner').style.display = 'none';
    }
  } else {
    matchCard.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No matches generated for this game.</p>';
    document.getElementById('dashboard-on-deck-banner').style.display = 'none';
  }

  // 5. Render Leaderboard Items sorted descending
  const leaderboardContainer = document.getElementById('leaderboard-items-container');
  leaderboardContainer.innerHTML = '';

  const sortedPlayers = [...court.players];
  sortedPlayers.sort((a, b) => {
    if (b.totalScore !== a.totalScore) {
      return b.totalScore - a.totalScore;
    }
    return a.initialIndex - b.initialIndex;
  });

  sortedPlayers.forEach((player, idx) => {
    const rank = idx + 1;
    const isFirst = rank === 1;

    const score = player.totalScore;
    const isPositive = score > 0;
    const isNegative = score < 0;

    let scoreClass = 'score-neutral';
    let prefix = '';
    if (isPositive) {
      scoreClass = 'score-positive';
      prefix = '+';
    } else if (isNegative) {
      scoreClass = 'score-negative';
    } else {
      prefix = '+';
    }

    const item = document.createElement('div');
    item.className = `leaderboard-item ${isFirst ? 'first-place' : ''}`;
    item.innerHTML = `
      <span class="leaderboard-rank">${rank}</span>
      <div style="display: flex; align-items: center; gap: 10px; flex-grow: 1; min-width: 0;">
        ${renderPlayerAvatar(player, 28)}
        <span class="leaderboard-name" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${formatPlayerName(player.name)}</span>
      </div>
      <span class="leaderboard-score-chip ${scoreClass}">${prefix}${score}</span>
    `;
    leaderboardContainer.appendChild(item);
  });

  // 6. Render Match Results Overview
  const overviewContainer = document.getElementById('match-results-overview-container');
  if (overviewContainer) {
    overviewContainer.innerHTML = '';
    
    if (court && court.matches && court.matches.length > 0) {
      court.matches.forEach((m, idx) => {
        const gameNum = idx + 1;
        const isActive = gameNum === court.activeRound;
        
        let statusHtml = '';
        let scoreHtml = '';
        
        if (m.isCompleted) {
          statusHtml = `<span class="overview-row-status-text completed">Completed</span>`;
          scoreHtml = `<span class="overview-row-score-badge">${m.team1Score} - ${m.team2Score}</span>`;
        } else if (isActive) {
          statusHtml = `<span class="overview-row-status-text in-progress"><span class="pulse-dot" style="width: 4px; height: 4px;"></span>In Progress</span>`;
          scoreHtml = `<span class="overview-row-vs-badge">VS</span>`;
        } else {
          statusHtml = `<span class="overview-row-status-text">Pending</span>`;
          scoreHtml = `<span class="overview-row-vs-badge">VS</span>`;
        }
        
        const showDuprParam = new URLSearchParams(window.location.search).get('show_dupr') === 'true';
        let team1AvgHtml = '';
        let team2AvgHtml = '';
        let diffHtml = '';
        
        if (showDuprParam) {
          const t1p1 = getPlayerDupr(m.team1Player1.name);
          const t1p2 = getPlayerDupr(m.team1Player2.name);
          const t2p1 = getPlayerDupr(m.team2Player1.name);
          const t2p2 = getPlayerDupr(m.team2Player2.name);
          
          const t1Avg = (t1p1 + t1p2) / 2;
          const t2Avg = (t2p1 + t2p2) / 2;
          const diff = Math.abs(t1Avg - t2Avg);
          
          team1AvgHtml = `<span style="font-size: 10px; color: var(--text-secondary); margin-top: 2px; font-weight: 500;">Avg: ${t1Avg.toFixed(2)}</span>`;
          team2AvgHtml = `<span style="font-size: 10px; color: var(--text-secondary); margin-top: 2px; font-weight: 500;">Avg: ${t2Avg.toFixed(2)}</span>`;
          diffHtml = `<span style="font-size: 10px; color: var(--text-secondary); font-weight: 500; margin-top: 4px;">&Delta; ${diff.toFixed(2)}</span>`;
        }

        const gameRow = document.createElement('div');
        gameRow.className = 'overview-row';
        gameRow.innerHTML = `
          <div class="overview-row-header">
            <span class="overview-row-game-label">Game ${gameNum}</span>
            ${statusHtml}
          </div>
          <div class="overview-row-body">
            <div class="overview-row-team">
              <span>${formatPlayerName(m.team1Player1.name)}</span>
              <span>${formatPlayerName(m.team1Player2.name)}</span>
              ${team1AvgHtml}
            </div>
            <div class="overview-row-score-cell"${showDuprParam ? ' style="flex-direction: column;"' : ''}>
              ${scoreHtml}
              ${diffHtml}
            </div>
            <div class="overview-row-team team-2">
              <span>${formatPlayerName(m.team2Player1.name)}</span>
              <span>${formatPlayerName(m.team2Player2.name)}</span>
              ${team2AvgHtml}
            </div>
          </div>
        `;
        
        overviewContainer.appendChild(gameRow);
      });
    } else {
      overviewContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 16px 0;">No matches generated for this court.</p>';
    }
  }

  // 7. Render Standings Grid
  const gridContainer = document.getElementById('standings-grid-container');
  if (gridContainer) {
    gridContainer.innerHTML = '';

    if (court && court.players && court.players.length > 0) {
      const sortedPlayers = [...court.players];
      sortedPlayers.sort((a, b) => {
        if (b.totalScore !== a.totalScore) {
          return b.totalScore - a.totalScore;
        }
        return a.initialIndex - b.initialIndex;
      });

      const globalRanks = getGlobalRanksMap();
      let listHtml = '';

      sortedPlayers.forEach((player, idx) => {
        const globalRank = globalRanks.get(player.name) || '-';

        // Find matches player played on this court
        const playerMatches = (court.matches || []).filter(m => 
          m.team1Player1.name === player.name || 
          m.team1Player2.name === player.name || 
          m.team2Player1.name === player.name || 
          m.team2Player2.name === player.name
        );

        const diffs = [];
        const maxGames = 4;
        for (let i = 0; i < maxGames; i++) {
          if (i < playerMatches.length) {
            const match = playerMatches[i];
            if (match.isCompleted) {
              const isTeam1 = (match.team1Player1.name === player.name || match.team1Player2.name === player.name);
              const diff = isTeam1 ? (match.team1Score - match.team2Score) : (match.team2Score - match.team1Score);
              diffs.push(diff);
            } else {
              diffs.push('-');
            }
          } else {
            diffs.push('-');
          }
        }

        const hasPlayedAny = playerMatches.some(m => m.isCompleted);
        const groupRank = hasPlayedAny ? (idx + 1) : '-';

        // Format game pills HTML
        let pillsHtml = '';
        diffs.forEach(diff => {
          if (diff === '-') {
            pillsHtml += `<div class="game-pill neutral">-</div>`;
          } else if (diff > 0) {
            pillsHtml += `<div class="game-pill positive">+${diff}</div>`;
          } else if (diff < 0) {
            pillsHtml += `<div class="game-pill negative">${diff}</div>`;
          } else {
            pillsHtml += `<div class="game-pill neutral">0</div>`;
          }
        });

        // Format total score badge
        let totalClass = 'neutral';
        let totalVal = player.totalScore;
        if (hasPlayedAny) {
          if (player.totalScore > 0) {
            totalClass = 'positive';
            totalVal = `+${player.totalScore}`;
          } else if (player.totalScore < 0) {
            totalClass = 'negative';
          }
        } else {
          if (player.totalScore === -99) {
            totalClass = 'negative';
          } else if (player.totalScore > 0) {
            totalClass = 'positive';
            totalVal = `+${player.totalScore}`;
          } else if (player.totalScore < 0) {
            totalClass = 'negative';
          }
        }

        listHtml += `
          <div class="grid-player-row">
            <div class="grid-player-main">
              <div class="grid-player-left">
                <div class="grid-group-rank-badge">#${groupRank}</div>
                <div class="grid-player-details">
                  <span class="grid-player-name">${formatPlayerName(player.name).toUpperCase()}</span>
                  <span class="grid-player-tot-rank">Overall Rank: #${globalRank}</span>
                </div>
              </div>
              <div class="grid-player-right">
                <div class="grid-player-total-badge ${totalClass}">${totalVal} pts</div>
              </div>
            </div>
            <div class="grid-player-games">
              <span class="grid-games-label">GAMES:</span>
              <div class="grid-games-pills">
                ${pillsHtml}
              </div>
            </div>
          </div>
        `;
      });

      gridContainer.innerHTML = listHtml;
    } else {
      gridContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 16px 0;">No players found on this court.</p>';
    }
  }
}

// --- DIALOG MODAL SCORE STEPPER RENDER ---
function renderScoreModal() {
  const modal = document.getElementById('score-modal');

  if (!appState.modal.open) {
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
    return;
  }

  modal.classList.remove('view-hidden');
  // Delayed class append to trigger smooth CSS transition slide-up
  setTimeout(() => {
    document.body.classList.add('modal-open');
  }, 10);

  const court = appState.courts.find(c => c.courtNumber === appState.modal.courtNumber);
  const match = court && court.matches ? court.matches[appState.modal.matchIndex] : null;

  if (!court || !match || !match.team1Player1 || !match.team1Player2 || !match.team2Player1 || !match.team2Player2) {
    appState.modal.open = false;
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
    return;
  }

  // Resolve custom court/tier label
  let courtLabel = court.courtName || `Court ${court.courtNumber}`;
  if (appState.currentStage === 2 && !appState.stage2ViewingQualifying) {
    const TIER_NAMES = ["Gold Tier", "Silver Tier", "Bronze Tier", "Copper Tier", "Iron Tier", "Slate Tier"];
    const tierName = (TIER_NAMES[court.courtNumber - 1] || `Tier ${court.courtNumber}`).replace(/\s*tier/gi, '');
    const courtDisplayName = court.courtName || `Court ${court.courtNumber}`;
    courtLabel = `${courtDisplayName} (${tierName})`;
  }

  // Set players names in modal
  document.getElementById('modal-court-round-badge').textContent = `${courtLabel} • Game ${appState.modal.matchIndex + 1}`;
  document.getElementById('modal-team1-names').textContent = `${formatPlayerName(match.team1Player1.name)} & ${formatPlayerName(match.team1Player2.name)}`;
  document.getElementById('modal-team2-names').textContent = `${formatPlayerName(match.team2Player1.name)} & ${formatPlayerName(match.team2Player2.name)}`;

  // Steppers Score Text
  const val1 = document.getElementById('stepper-val-1');
  const val2 = document.getElementById('stepper-val-2');
  if (val1) val1.value = appState.modal.score1;
  if (val2) val2.value = appState.modal.score2;

  // Color highlights on winning stepper
  if (appState.modal.score1 > appState.modal.score2) {
    val1.className = 'stepper-value winning';
    val2.className = 'stepper-value';
  } else if (appState.modal.score2 > appState.modal.score1) {
    val2.className = 'stepper-value winning';
    val1.className = 'stepper-value';
  } else {
    val1.className = 'stepper-value';
    val2.className = 'stepper-value';
  }


}

// ----------------------------------------------------
// SCORE SUBMISSION ENGINE
// ----------------------------------------------------

function submitScore(courtNumber, matchIndex, score1, score2) {
  const court = appState.courts.find(c => c.courtNumber === courtNumber);
  if (!court) return;
  const match = court.matches[matchIndex];
  if (!match) return;

  // Helper to safely find and update player totalScore by name in court.players
  const updatePlayerScore = (name, amount) => {
    const playerObj = court.players.find(p => p.name === name);
    if (playerObj) {
      playerObj.totalScore += amount;
    }
  };

  // 1. Revert previous score changes if the match was already completed
  if (match.isCompleted && match.team1Score !== null && match.team2Score !== null) {
    const oldDiff1 = match.team1Score - match.team2Score;
    const oldDiff2 = match.team2Score - match.team1Score;

    // Revert on match object player copies
    match.team1Player1.totalScore -= oldDiff1;
    match.team1Player2.totalScore -= oldDiff1;
    match.team2Player1.totalScore -= oldDiff2;
    match.team2Player2.totalScore -= oldDiff2;

    // Revert on actual court players
    updatePlayerScore(match.team1Player1.name, -oldDiff1);
    updatePlayerScore(match.team1Player2.name, -oldDiff1);
    updatePlayerScore(match.team2Player1.name, -oldDiff2);
    updatePlayerScore(match.team2Player2.name, -oldDiff2);
  }

  // 2. Set new score details
  match.team1Score = score1;
  match.team2Score = score2;
  match.isCompleted = true;

  const diff1 = score1 - score2;
  const diff2 = score2 - score1;

  // Update on match object player copies
  match.team1Player1.totalScore += diff1;
  match.team1Player2.totalScore += diff1;
  match.team2Player1.totalScore += diff2;
  match.team2Player2.totalScore += diff2;

  // Update on actual court players
  updatePlayerScore(match.team1Player1.name, diff1);
  updatePlayerScore(match.team1Player2.name, diff1);
  updatePlayerScore(match.team2Player1.name, diff2);
  updatePlayerScore(match.team2Player2.name, diff2);

  // If the score was input on the court's current active round, auto advance the active round if appropriate
  if (matchIndex + 1 === court.activeRound && court.activeRound < court.matches.length) {
    court.activeRound++;
    appState.viewingRound = court.activeRound;
  }
}

// ----------------------------------------------------
// EVENT HANDLERS REGISTRATION
// ----------------------------------------------------

function setupEventListeners() {
  // Theme Toggle Button Handler
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');
  if (themeToggle && themeIcon) {
    // Check saved preference
    const savedTheme = localStorage.getItem('theme') || 'light';
    if (savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      themeIcon.textContent = 'dark_mode';
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeIcon.textContent = 'light_mode';
    }

    themeToggle.addEventListener('click', () => {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'dark');
        themeIcon.textContent = 'light_mode';
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
        themeIcon.textContent = 'dark_mode';
      }
    });
  }

  // AppBar Back Button Handler (Hidden by CSS, kept for safety)
  const backBtn = document.getElementById('app-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (!appState.isAdmin) return; // User mode has no back button navigation
      if (appState.currentView === 'player-entry') {
        navigateTo('court-setup');
      } else if (appState.currentView === 'dashboard') {
        navigateTo('court-setup');
      }
    });
  }

  // Inline Back Buttons
  const inlineBackEntry = document.getElementById('inline-back-entry');
  if (inlineBackEntry) {
    inlineBackEntry.addEventListener('click', () => {
      if (!appState.isAdmin) return;
      navigateTo('court-setup');
    });
  }

  const inlineBackStage2 = document.getElementById('inline-back-stage2');
  if (inlineBackStage2) {
    inlineBackStage2.addEventListener('click', () => {
      if (!appState.isAdmin) return;
      navigateTo('dashboard');
    });
  }

  // Screen 1 Setup: Next button click
  const setupNextBtn = document.getElementById('setup-next-btn');
  if (setupNextBtn) {
    setupNextBtn.addEventListener('click', () => {
      navigateTo('player-entry');
    });
  }

  // Screen 2 Entry: Generate Pairings button click
  const entryGenerateBtn = document.getElementById('entry-generate-btn');
  if (entryGenerateBtn) {
    entryGenerateBtn.addEventListener('click', () => {
      const activeCourts = appState.courts.filter(c => c.isActive);

      // Commit Names & Run Matchmaking Engine for all active courts
      activeCourts.forEach(court => {
        const entry = appState.entryState[court.courtNumber];
        court.players = entry.names
          .filter(n => n.trim() !== '')
          .map((n, idx) => new Player(n.trim(), idx));

        generatePairingsForCourt(court);
      });

      // Default viewing select states for Dashboard
      appState.selectedCourtNumber = activeCourts[0].courtNumber;
      appState.viewingRound = activeCourts[0].activeRound;

      navigateTo('admin-success');
      saveStateToCloud(); // Save automatically to Firestore
    });
  }

  // Modal Stepper Controllers
  const stepperPlus1 = document.getElementById('stepper-plus-1');
  if (stepperPlus1) {
    stepperPlus1.addEventListener('click', () => {
      if (appState.modal.score1 < 21) {
        appState.modal.score1++;
        render();
      }
    });
  }

  const stepperMinus1 = document.getElementById('stepper-minus-1');
  if (stepperMinus1) {
    stepperMinus1.addEventListener('click', () => {
      if (appState.modal.score1 > 0) {
        appState.modal.score1--;
        render();
      }
    });
  }

  const stepperPlus2 = document.getElementById('stepper-plus-2');
  if (stepperPlus2) {
    stepperPlus2.addEventListener('click', () => {
      if (appState.modal.score2 < 21) {
        appState.modal.score2++;
        render();
      }
    });
  }

  const stepperMinus2 = document.getElementById('stepper-minus-2');
  if (stepperMinus2) {
    stepperMinus2.addEventListener('click', () => {
      if (appState.modal.score2 > 0) {
        appState.modal.score2--;
        render();
      }
    });
  }

  const val1Select = document.getElementById('stepper-val-1');
  if (val1Select) {
    val1Select.addEventListener('input', (e) => {
      appState.modal.score1 = parseInt(e.target.value, 10) || 0;
      render();
    });
  }

  const val2Select = document.getElementById('stepper-val-2');
  if (val2Select) {
    val2Select.addEventListener('input', (e) => {
      appState.modal.score2 = parseInt(e.target.value, 10) || 0;
      render();
    });
  }

  // Modal Actions
  const modalCloseBtn = document.getElementById('modal-close-btn');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      appState.modal.open = false;
      render();
    });
  }

  const modalConfirmBtn = document.getElementById('modal-confirm-btn');
  if (modalConfirmBtn) {
    modalConfirmBtn.addEventListener('click', () => {
      submitScore(
        appState.modal.courtNumber,
        appState.modal.matchIndex,
        appState.modal.score1,
        appState.modal.score2
      );
      appState.modal.open = false;

      // Auto-advancement hook during Group Stage (Stage 1) for both Admins and Players
      if (appState.currentStage === 1 && checkStage1Completion()) {
        launchFinalStageAutomatically();
        saveStateToCloud(); // Save auto-advancement to Cloud!
        if (appState.isAdmin) {
          navigateTo('admin-success');
        } else {
          navigateTo('dashboard');
        }
      } else {
        render();
        saveStateToCloud(); // Save automatically to Firestore
      }
    });
  }

  // Cloud Saving Actions
  const cloudSaveBtn = document.getElementById('btn-cloud-save');
  if (cloudSaveBtn) {
    cloudSaveBtn.addEventListener('click', () => {
      saveStateToCloud();
    });
  }

  const resetMixerBtn = document.getElementById('btn-reset-mixer');
  if (resetMixerBtn) {
    resetMixerBtn.addEventListener('click', () => {
      showCustomConfirm(
        "DANGER ZONE",
        "Are you absolutely sure you want to reset the mixer? This will permanently delete all current scores, pairings, and cloud data for this tournament.",
        "delete_forever",
        () => {
          resetMixer();
        }
      );
    });
  }

  const redirectToPlayerDashboard = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('admin');
    url.hash = ''; // Clear any hash
    if (url.pathname.endsWith('admin.html')) {
      url.pathname = url.pathname.replace('admin.html', 'index.html');
    }
    window.open(url.toString(), '_blank');
  };

  const resumeDashboardBtn = document.getElementById('btn-resume-dashboard');
  if (resumeDashboardBtn) {
    resumeDashboardBtn.addEventListener('click', () => {
      navigateTo('admin-success');
    });
  }

  // Stage 2 Navigation & Promotion Bindings
  const dashboardAdvanceBtn = document.getElementById('btn-dashboard-advance');
  if (dashboardAdvanceBtn) {
    dashboardAdvanceBtn.addEventListener('click', () => {
      if (appState.currentStage === 2) {
        if (confirm("Are you sure you want to re-seed the Final Stage? This will overwrite current Final Stage matches and scores, but your Group Stage scores are 100% safe.")) {
          launchFinalStageAutomatically();
          render();
          saveStateToCloud(); // Save to cloud!
        }
        return;
      }

      const hasCompleted = checkStage1Completion();
      const msg = hasCompleted
        ? "All Group Stage matches are completed! Do you want to automatically launch the Final Stage?"
        : "Group Stage matches are not all completed. Do you want to force-launch the Final Stage based on current scores?";
      if (confirm(msg)) {
        launchFinalStageAutomatically();
        saveStateToCloud(); // Save to cloud!
        navigateTo('admin-success');
      }
    });
  }

  const confirmStage2Btn = document.getElementById('btn-confirm-stage2');
  if (confirmStage2Btn) {
    confirmStage2Btn.addEventListener('click', () => {
      confirmStage2();
    });
  }

  const toggleStageViewBtn = document.getElementById('btn-toggle-stage-view');
  if (toggleStageViewBtn) {
    toggleStageViewBtn.addEventListener('click', () => {
      appState.stage2ViewingQualifying = !appState.stage2ViewingQualifying;

      // Switch active court selections to match viewing stage
      const sourceCourts = appState.stage2ViewingQualifying ? appState.stage1Courts : appState.courts;
      const activeCourts = sourceCourts.filter(c => c.isActive);
      if (activeCourts.length > 0) {
        appState.selectedCourtNumber = activeCourts[0].courtNumber;
        appState.viewingRound = activeCourts[0].activeRound;
      }
      render();
    });
  }

  const successViewLiveBtn = document.getElementById('btn-success-view-live');
  if (successViewLiveBtn) {
    successViewLiveBtn.addEventListener('click', () => {
      redirectToPlayerDashboard();
    });
  }

  const successToSetupBtn = document.getElementById('btn-success-to-setup');
  if (successToSetupBtn) {
    successToSetupBtn.addEventListener('click', () => {
      navigateTo('court-setup');
    });
  }

  const successSaveHistoryBtn = document.getElementById('btn-success-save-history');
  if (successSaveHistoryBtn) {
    successSaveHistoryBtn.addEventListener('click', () => {
      showSaveGameModal(successSaveHistoryBtn);
    });
  }

  const setupSaveHistoryBtn = document.getElementById('btn-setup-save-history');
  if (setupSaveHistoryBtn) {
    setupSaveHistoryBtn.addEventListener('click', () => {
      showSaveGameModal(setupSaveHistoryBtn);
    });
  }

  const successViewHistoryBtn = document.getElementById('btn-success-view-history');
  if (successViewHistoryBtn) {
    successViewHistoryBtn.addEventListener('click', () => {
      window.open('/history', '_blank');
    });
  }

  const successResetBtn = document.getElementById('btn-success-reset');
  if (successResetBtn) {
    successResetBtn.addEventListener('click', () => {
      showCustomConfirm(
        "RESET TOURNAMENT",
        "Are you sure you want to reset the entire tournament? This will clear all players, matches, and scores across all courts locally and in the Cloud.",
        "delete_forever",
        () => {
          resetMixer();
        }
      );
    });
  }

  // Premium Bottom Navigation items click events
  const navRound1 = document.getElementById('nav-round1');
  if (navRound1) {
    navRound1.addEventListener('click', () => {
      if (appState.currentStage === 1) {
        if (appState.currentView === 'dashboard') {
          // Already in Group Stage dashboard
          return;
        }
        navigateTo('dashboard');
        return;
      }

      if (!appState.stage2ViewingQualifying) {
        appState.stage2ViewingQualifying = true;

        // Switch active court selections to match Stage 1 courts
        const activeCourts = appState.stage1Courts ? appState.stage1Courts.filter(c => c.isActive) : [];
        if (activeCourts.length > 0) {
          appState.selectedCourtNumber = activeCourts[0].courtNumber;
          appState.viewingRound = activeCourts[0].activeRound;
        }
      }
      navigateTo('dashboard');
    });
  }

  const navRound2 = document.getElementById('nav-round2');
  if (navRound2) {
    navRound2.addEventListener('click', () => {
      if (appState.currentStage === 1) {
        const hasCompleted = checkStage1Completion();
        if (hasCompleted) {
          // Fail-safe: if all Group Stage matches are completed, clicking the tab auto-launches Stage 2!
          launchFinalStageAutomatically();
          saveStateToCloud(); // Save to cloud!
          if (appState.isAdmin) {
            navigateTo('admin-success');
          } else {
            navigateTo('dashboard');
          }
          return;
        }

        if (appState.isAdmin) {
          const msg = "Group Stage matches are not all completed. Do you want to force-launch the Final Stage based on current scores?";
          if (confirm(msg)) {
            launchFinalStageAutomatically();
            saveStateToCloud(); // Save to cloud!
            navigateTo('admin-success');
          }
        } else {
          showPremiumToast("Final Stage will begin automatically once all Group Stage matches are completed!");
        }
        return;
      }

      if (appState.stage2ViewingQualifying) {
        appState.stage2ViewingQualifying = false;

        // Switch active court selections to match Stage 2 courts
        const activeCourts = appState.courts ? appState.courts.filter(c => c.isActive) : [];
        if (activeCourts.length > 0) {
          appState.selectedCourtNumber = activeCourts[0].courtNumber;
          appState.viewingRound = activeCourts[0].activeRound;
        }
      }
      navigateTo('dashboard');
    });
  }

  const navLeaderboard = document.getElementById('nav-leaderboard');
  if (navLeaderboard) {
    navLeaderboard.addEventListener('click', () => {
      navigateTo('global-leaderboard');
    });
  }

  const navSetup = document.getElementById('nav-setup');
  if (navSetup) {
    navSetup.addEventListener('click', () => {
      if (appState.isAdmin) {
        showCustomConfirm(
          "Go to Setup?",
          "Are you sure you want to go back to the setup page? You will leave the active dashboard.",
          "settings",
          () => {
            navigateTo('court-setup');
          }
        );
      }
    });
  }

  // Setup Confirm Modal Handlers
  const confirmModalCancel = document.getElementById('confirm-modal-cancel');
  const confirmModalOk = document.getElementById('confirm-modal-ok');

  if (confirmModalCancel) {
    confirmModalCancel.addEventListener('click', hideCustomConfirm);
  }

  if (confirmModalOk) {
    confirmModalOk.addEventListener('click', () => {
      hideCustomConfirm();
      if (confirmCallback) {
        confirmCallback();
      }
    });
  }

  // Court Name Modal Handlers
  const courtNameModal = document.getElementById('court-name-modal');
  const courtNameModalCancel = document.getElementById('court-name-modal-cancel');
  const courtNameModalSave = document.getElementById('court-name-modal-save');
  const courtNameModalInput = document.getElementById('court-name-modal-input');

  if (courtNameModalCancel) {
    courtNameModalCancel.addEventListener('click', hideCourtNameModal);
  }

  if (courtNameModalSave) {
    courtNameModalSave.addEventListener('click', saveCourtNameFromModal);
  }

  if (courtNameModalInput) {
    courtNameModalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveCourtNameFromModal();
      } else if (e.key === 'Escape') {
        hideCourtNameModal();
      }
    });
  }

  if (courtNameModal) {
    courtNameModal.addEventListener('click', (e) => {
      if (e.target === courtNameModal) {
        hideCourtNameModal();
      }
    });
  }

  // How It Works / Player Help Modal Logic
  const helpModal = document.getElementById('help-modal');
  const btnPlayerHelp = document.getElementById('btn-player-help');
  const btnStandbyHelp = document.getElementById('btn-standby-help');
  const helpCloseBtn = document.getElementById('help-modal-close-btn');
  const helpConfirmBtn = document.getElementById('help-modal-confirm-btn');

  const showHelpModal = () => {
    if (helpModal) {
      helpModal.classList.remove('view-hidden');
      document.body.classList.add('modal-open');
    }
  };

  const hideHelpModal = () => {
    if (helpModal) {
      helpModal.classList.add('view-hidden');
      document.body.classList.remove('modal-open');
    }
  };

  if (btnPlayerHelp) btnPlayerHelp.addEventListener('click', showHelpModal);
  if (btnStandbyHelp) btnStandbyHelp.addEventListener('click', showHelpModal);
  if (helpCloseBtn) helpCloseBtn.addEventListener('click', hideHelpModal);
  if (helpConfirmBtn) helpConfirmBtn.addEventListener('click', hideHelpModal);

  // Also close help modal if overlay is clicked
  if (helpModal) {
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) {
        hideHelpModal();
      }
    });
  }

  // Set up AI magic auto fill
  setupMagicAutoFill();
}

// ----------------------------------------------------
// FIREBASE PERSISTENCE HELPER ACTIONS
// ----------------------------------------------------
function updateSyncStatus(status) {
  const syncStatusEl = document.getElementById('cloud-sync-status');
  if (!syncStatusEl) return;

  const textEl = syncStatusEl.querySelector('.sync-text');
  const iconEl = syncStatusEl.querySelector('span');

  if (appState.currentView !== 'court-setup') {
    syncStatusEl.style.display = 'inline-flex';
  }

  if (status === 'syncing') {
    syncStatusEl.className = 'sync-status status-syncing';
    textEl.textContent = 'Syncing...';
    iconEl.textContent = 'cloud_sync';
  } else if (status === 'saved') {
    syncStatusEl.className = 'sync-status status-saved';
    textEl.textContent = 'Cloud Synced';
    iconEl.textContent = 'cloud_done';
  } else if (status === 'error') {
    syncStatusEl.className = 'sync-status status-error';
    textEl.textContent = 'Offline';
    iconEl.textContent = 'cloud_off';
  } else if (status === 'connecting') {
    syncStatusEl.className = 'sync-status status-syncing';
    textEl.textContent = 'Connecting...';
    iconEl.textContent = 'cloud_sync';
  } else if (status === 'new') {
    syncStatusEl.className = 'sync-status status-saved';
    textEl.textContent = 'Ready';
    iconEl.textContent = 'cloud';
  }
}

function debouncedSaveStateToCloud() {
  updateSyncStatus('syncing');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveStateToCloud();
  }, 1000);
}

async function saveStateToCloud() {
  const cloudSaveBtn = document.getElementById('btn-cloud-save');

  let originalHtml = '';
  if (cloudSaveBtn) {
    originalHtml = cloudSaveBtn.innerHTML;
    cloudSaveBtn.disabled = true;
    cloudSaveBtn.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 16px; animation: pulse 1s infinite ease-in-out;">sync</span>
      Saving...
    `;
  }
  updateSyncStatus('syncing');

  try {
    const serializedState = {
      currentView: appState.currentView,
      currentStage: appState.currentStage,
      draftingStyle: appState.draftingStyle || 'snake',
      stage1Courts: appState.stage1Courts,
      stage2ViewingQualifying: appState.stage2ViewingQualifying,
      stage2PreviewTiers: appState.stage2PreviewTiers,
      courts: JSON.parse(JSON.stringify(appState.courts)),
      selectedCourtNumber: appState.selectedCourtNumber,
      viewingRound: appState.viewingRound,
      entryState: JSON.parse(JSON.stringify(appState.entryState)),
      avatars: appState.avatars || {}
    };

    await setDoc(mixerDocRef, serializedState);

    updateSyncStatus('saved');
    if (cloudSaveBtn) {
      cloudSaveBtn.innerHTML = `
        <span class="material-symbols-outlined" style="font-size: 16px; color: var(--green);">check_circle</span>
        Saved!
      `;

      setTimeout(() => {
        cloudSaveBtn.disabled = false;
        cloudSaveBtn.innerHTML = originalHtml;
      }, 2000);
    }
  } catch (error) {
    console.error("Firestore cloud save error:", error);
    updateSyncStatus('error');
    if (cloudSaveBtn) {
      cloudSaveBtn.disabled = false;
      cloudSaveBtn.innerHTML = originalHtml;
    }
  }
}

// Modal Logic for Save Game
function showSaveGameModal(btnElement) {
  const modal = document.getElementById('save-game-modal');
  const input = document.getElementById('save-game-name-input');
  const cancelBtn = document.getElementById('save-game-cancel');
  const confirmBtn = document.getElementById('save-game-confirm');
  
  if (!modal) return;
  
  input.value = ''; // Reset input
  modal.classList.remove('view-hidden');
  document.body.classList.add('modal-open');
  
  // Need a small timeout for focus to work after display block
  setTimeout(() => input.focus(), 50);
  
  const closeHandler = () => {
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
    cleanup();
  };
  
  const confirmHandler = () => {
    const gameName = input.value.trim();
    modal.classList.add('view-hidden');
    document.body.classList.remove('modal-open');
    saveGameToHistory(btnElement, gameName);
    cleanup();
  };
  
  const cleanup = () => {
    cancelBtn.removeEventListener('click', closeHandler);
    confirmBtn.removeEventListener('click', confirmHandler);
  };
  
  cancelBtn.addEventListener('click', closeHandler);
  confirmBtn.addEventListener('click', confirmHandler);
}

async function saveGameToHistory(btnElement, gameName) {
  let originalHtml = '';
  if (btnElement) {
    originalHtml = btnElement.innerHTML;
    btnElement.disabled = true;
    btnElement.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 16px; animation: pulse 1s infinite ease-in-out;">sync</span>
      Saving...
    `;
  }

  try {
    const timestamp = Date.now();
    const historyId = timestamp.toString();
    const serializedState = {
      savedAt: timestamp,
      currentView: appState.currentView,
      currentStage: appState.currentStage,
      stage1Courts: appState.stage1Courts,
      stage2ViewingQualifying: appState.stage2ViewingQualifying,
      stage2PreviewTiers: appState.stage2PreviewTiers,
      courts: JSON.parse(JSON.stringify(appState.courts)),
      selectedCourtNumber: appState.selectedCourtNumber,
      viewingRound: appState.viewingRound,
      entryState: JSON.parse(JSON.stringify(appState.entryState)),
      gameName: gameName || "Tournament Snapshot"
    };

    const historyDocRef = doc(db, "mixers_history", historyId);
    await setDoc(historyDocRef, serializedState);

    if (btnElement) {
      btnElement.innerHTML = `
        <span class="material-symbols-outlined" style="font-size: 16px; color: var(--green);">check_circle</span>
        Saved to History!
      `;
      setTimeout(() => {
        btnElement.disabled = false;
        btnElement.innerHTML = originalHtml;
      }, 2000);
    }
  } catch (error) {
    console.error("Firestore history save error:", error);
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = originalHtml;
    }
    alert("Error saving game to history. Please check console.");
  }
}

async function resetMixer() {
  const resetBtn = document.getElementById('btn-reset-mixer');
  const originalHtml = resetBtn.innerHTML;
  resetBtn.disabled = true;
  resetBtn.innerHTML = `
    <span class="material-symbols-outlined" style="font-size: 16px; animation: pulse 1s infinite ease-in-out;">sync</span>
    Clearing...
  `;

  // Reset local state to default
  appState.currentView = 'court-setup';
  appState.currentStage = 1;
  appState.draftingStyle = 'snake';
  appState.stage1Courts = null;
  appState.stage2ViewingQualifying = false;
  appState.stage2PreviewTiers = [];
  appState.selectedCourtNumber = 1;
  appState.viewingRound = 1;
  const existingCourts = appState.courts || [];
  appState.courts = Array.from({ length: 6 }, (_, i) => {
    const courtNum = i + 1;
    const existing = existingCourts.find(c => c.courtNumber === courtNum);
    return {
      courtNumber: courtNum,
      courtName: existing ? (existing.courtName || '') : '',
      isActive: false,
      players: [],
      matches: [],
      activeRound: 1
    };
  });

  for (let i = 1; i <= 6; i++) {
    appState.entryState[i] = {
      names: ['', '', '', ''],
      count: 4
    };
  }

  // Clear reserves bench
  appState.entryState.bench = {
    names: [],
    count: 0
  };


  try {
    await setDoc(mixerDocRef, {
      currentView: 'court-setup',
      currentStage: 1,
      draftingStyle: 'snake',
      stage1Courts: null,
      stage2ViewingQualifying: false,
      stage2PreviewTiers: [],
      courts: JSON.parse(JSON.stringify(appState.courts)),
      selectedCourtNumber: 1,
      viewingRound: 1,
      entryState: JSON.parse(JSON.stringify(appState.entryState))
    });

    resetBtn.disabled = false;
    resetBtn.innerHTML = originalHtml;

    updateSyncStatus('new');
    navigateTo('court-setup');
  } catch (error) {
    console.error("Firestore cloud reset error:", error);
    updateSyncStatus('error');
    resetBtn.disabled = false;
    resetBtn.innerHTML = originalHtml;
    alert("Cloud error while resetting. Local state has been reset.");
    navigateTo('court-setup');
  }
}

// ----------------------------------------------------
// MULTI-STAGE TOURNAMENT FLOW LOGIC
// ----------------------------------------------------
function checkStage1Completion() {
  if (appState.currentStage !== 1) return false;
  const activeCourts = appState.courts.filter(c => c.isActive);
  if (activeCourts.length === 0) return false;

  // Every match on every active court must be completed
  return activeCourts.every(court => {
    return court.matches.length > 0 && court.matches.every(m => m.isCompleted);
  });
}

function launchFinalStageAutomatically() {
  const TIER_NAMES = ["Gold Tier", "Silver Tier", "Bronze Tier", "Copper Tier", "Iron Tier", "Slate Tier"];
  const allPlayers = [];

  const sourceCourtsForSeeding = (appState.currentStage === 2 && appState.stage1Courts)
    ? appState.stage1Courts
    : appState.courts;

  // Gather and seed all players from Stage 1 active courts
  sourceCourtsForSeeding.filter(c => c.isActive).forEach(court => {
    // Sort this court stably to compute ranks
    const sorted = [...court.players].sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return a.initialIndex - b.initialIndex;
    });

    sorted.forEach((p, idx) => {
      allPlayers.push({
        name: p.name,
        stage1Score: p.totalScore,
        courtNumber: court.courtNumber,
        courtRank: idx + 1
      });
    });
  });

  // Seeding sort order:
  // 1. Lower court rank first (e.g. all Rank 1s seed higher than Rank 2s)
  // 2. Higher qualifying score differential breaks ties
  allPlayers.sort((a, b) => {
    if (a.courtRank !== b.courtRank) {
      return a.courtRank - b.courtRank;
    }
    return b.stage1Score - a.stage1Score;
  });

  // Partition into optimal tier sizes for Stage 2
  const activeStage1Courts = sourceCourtsForSeeding.filter(c => c.isActive);
  const maxCourts = activeStage1Courts.length > 0 ? activeStage1Courts.length : 4;
  const partition = findOptimalPartition(allPlayers.length, maxCourts);
  if (!partition) {
    alert("Error: Mathematically unable to partition " + allPlayers.length + " players into groups of 4, 5, or 6.");
    return;
  }

  let playerIdx = 0;
  const tiers = partition.map((size, tierIdx) => {
    const tierPlayers = [];
    for (let j = 0; j < size; j++) {
      tierPlayers.push({
        ...allPlayers[playerIdx++],
        seedRank: playerIdx
      });
    }
    return {
      tierName: TIER_NAMES[tierIdx] || `Tier ${tierIdx + 1}`,
      players: tierPlayers
    };
  });

  // Archive Stage 1 courts and scores
  appState.stage1Courts = JSON.parse(JSON.stringify(appState.courts));

  // Deactivate all courts first
  appState.courts.forEach(c => {
    c.isActive = false;
    c.players = [];
    c.matches = [];
    c.activeRound = 1;
  });

  // Setup Stage 2 tiered courts
  tiers.forEach((tier, tierIdx) => {
    const courtNum = tierIdx + 1;
    const court = appState.courts[tierIdx];
    court.isActive = true;

    // Initialize new Player structures starting at 0, stable indices
    court.players = tier.players.map((p, pIdx) => new Player(p.name, pIdx));

    // Set entryState caches just in case they switch screens
    appState.entryState[courtNum] = {
      names: tier.players.map(p => p.name),
      count: tier.players.length
    };

    // Build Stage 2 Double Round-Robin pairings for this tier
    generatePairingsForCourt(court);
  });

  appState.currentStage = 2;
  appState.stage2ViewingQualifying = false;
  appState.selectedCourtNumber = 1;
  appState.viewingRound = 1;

  // Save new Final Stage to Cloud!
  saveStateToCloud();
}

function advanceToStage2() {
  const TIER_NAMES = ["Gold Tier", "Silver Tier", "Bronze Tier", "Copper Tier", "Iron Tier", "Slate Tier"];
  const allPlayers = [];

  // Gather and seed all players from Stage 1 active courts
  appState.courts.filter(c => c.isActive).forEach(court => {
    // Sort this court stably to compute ranks
    const sorted = [...court.players].sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return a.initialIndex - b.initialIndex;
    });

    sorted.forEach((p, idx) => {
      allPlayers.push({
        name: p.name,
        stage1Score: p.totalScore,
        courtNumber: court.courtNumber,
        courtRank: idx + 1
      });
    });
  });

  // Seeding sort order:
  // 1. Lower court rank first (e.g. all Rank 1s seed higher than Rank 2s)
  // 2. Higher qualifying score differential breaks ties
  allPlayers.sort((a, b) => {
    if (a.courtRank !== b.courtRank) {
      return a.courtRank - b.courtRank;
    }
    return b.stage1Score - a.stage1Score;
  });

  // Partition into optimal tier sizes for Stage 2
  const activeStage1Courts = appState.courts ? appState.courts.filter(c => c.isActive) : [];
  const maxCourts = activeStage1Courts.length > 0 ? activeStage1Courts.length : 4;
  const partition = findOptimalPartition(allPlayers.length, maxCourts);
  if (!partition) {
    alert("Error: Mathematically unable to partition " + allPlayers.length + " players into groups of 4, 5, or 6.");
    return;
  }

  let playerIdx = 0;
  appState.stage2PreviewTiers = partition.map((size, tierIdx) => {
    const tierPlayers = [];
    for (let j = 0; j < size; j++) {
      tierPlayers.push({
        ...allPlayers[playerIdx++],
        seedRank: playerIdx
      });
    }
    return {
      tierName: TIER_NAMES[tierIdx] || `Tier ${tierIdx + 1}`,
      players: tierPlayers
    };
  });

  // Show preview review Screen 4
  navigateTo('stage2-review');
}

function renderStage2Review() {
  const container = document.getElementById('seeding-tiers-container');
  container.innerHTML = '';

  const iconNames = ["emoji_events", "shield", "workspace_premium", "sports_score", "stars", "military_tech"];
  const themeClasses = ["tier-card-gold", "tier-card-silver", "tier-card-bronze", "tier-card-bronze", "tier-card-bronze", "tier-card-bronze"];

  appState.stage2PreviewTiers.forEach((tier, tierIdx) => {
    const card = document.createElement('div');
    card.className = `card ${themeClasses[tierIdx] || 'tier-card-bronze'}`;

    let playersListHtml = '';
    tier.players.forEach(p => {
      const scorePrefix = p.stage1Score > 0 ? '+' : '';
      playersListHtml += `
        <div class="tier-player-item">
          <span style="font-weight: 700; color: var(--text-primary);">${formatPlayerName(p.name)}</span>
          <span class="seed-badge">
            Rank ${p.courtRank} (${getCourtName(p.courtNumber, 1)}) • ${scorePrefix}${p.stage1Score} diff
          </span>
        </div>
      `;
    });

    card.innerHTML = `
      <h3 class="tier-header-title">
        <span class="material-symbols-outlined">${iconNames[tierIdx] || 'emoji_events'}</span>
        ${tier.tierName}
      </h3>
      <div class="tier-players-list">
        ${playersListHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

function confirmStage2() {
  // Archive Stage 1 courts and scores
  appState.stage1Courts = JSON.parse(JSON.stringify(appState.courts));

  // Deactivate all courts first
  appState.courts.forEach(c => {
    c.isActive = false;
    c.players = [];
    c.matches = [];
    c.activeRound = 1;
  });

  // Setup Stage 2 tiered courts
  appState.stage2PreviewTiers.forEach((tier, tierIdx) => {
    const courtNum = tierIdx + 1;
    const court = appState.courts[tierIdx];
    court.isActive = true;

    // Initialize new Player structures starting at 0, stable indices
    court.players = tier.players.map((p, pIdx) => new Player(p.name, pIdx));

    // Set entryState caches just in case they switch screens
    appState.entryState[courtNum] = {
      names: tier.players.map(p => p.name),
      count: tier.players.length
    };

    // Build Stage 2 Double Round-Robin pairings for this tier
    generatePairingsForCourt(court);
  });

  appState.currentStage = 2;
  appState.stage2ViewingQualifying = false;
  appState.selectedCourtNumber = 1;
  appState.viewingRound = 1;

  // Save new Final Stage to Cloud!
  saveStateToCloud();

  // Navigate to Success Screen
  navigateTo('admin-success');
}

// --- ADMIN SUCCESS RENDER ---
function renderAdminSuccess() {
  const activeCourts = appState.courts.filter(c => c.isActive);

  const activeCourtsEl = document.getElementById('success-active-courts-count');
  if (activeCourtsEl) activeCourtsEl.textContent = `${activeCourts.length} Court${activeCourts.length === 1 ? '' : 's'}`;

  // Dynamic header based on stage
  const headerContainer = document.getElementById('success-header-title');
  const subtitleContainer = document.getElementById('success-header-subtitle');
  if (headerContainer && subtitleContainer) {
    if (appState.currentStage === 2) {
      headerContainer.textContent = "Final Stage Launched!";
      subtitleContainer.textContent = "Seeding tiers and real-time scoreboards for the Final Stage are now active. Player dashboards are synced!";
    } else {
      headerContainer.textContent = "Tournament Launched!";
      subtitleContainer.textContent = "Court pairings and real-time scoreboards are now active. All player dashboards are synced and running!";
    }
  }
}

// --- GLOBAL LEADERBOARD LOGIC ---
function renderGlobalLeaderboard(sourceCourts) {
  const container = document.getElementById('global-leaderboard-container');
  if (!container) return;

  const TIER_NAMES = ["Gold Tier", "Silver Tier", "Bronze Tier", "Copper Tier", "Iron Tier", "Slate Tier"];

  // Handle Stage 2 segmented toggle switcher
  const toggleContainer = document.getElementById('leaderboard-stage-toggle-container');
  const btnCumulative = document.getElementById('btn-leaderboard-cumulative');
  const btnStage2 = document.getElementById('btn-leaderboard-stage2');
  const btnStage1 = document.getElementById('btn-leaderboard-stage1');
  const subtitle = document.getElementById('leaderboard-subtitle');

  if (appState.currentStage === 2) {
    if (toggleContainer) toggleContainer.style.display = 'flex';

    const mode = appState.leaderboardViewMode;

    if (btnCumulative) {
      btnCumulative.classList.toggle('active', mode === 'cumulative');
      btnCumulative.style.color = mode === 'cumulative' ? 'var(--neon)' : 'var(--text-secondary)';
    }
    if (btnStage2) {
      btnStage2.classList.toggle('active', mode === 'stage2');
      btnStage2.style.color = mode === 'stage2' ? 'var(--neon)' : 'var(--text-secondary)';
    }
    if (btnStage1) {
      btnStage1.classList.toggle('active', mode === 'stage1');
      btnStage1.style.color = mode === 'stage1' ? 'var(--neon)' : 'var(--text-secondary)';
    }

    if (subtitle) {
      if (mode === 'cumulative') {
        subtitle.textContent = "All players sorted by cumulative total score (Stage 1 + Stage 2).";
      } else if (mode === 'stage2') {
        subtitle.textContent = "All players sorted by Final Stage total score.";
      } else {
        subtitle.textContent = "All players sorted by Group Stage total score.";
      }
    }

    // Bind listeners
    if (btnCumulative && !btnCumulative.onclick) {
      btnCumulative.onclick = () => {
        appState.leaderboardViewMode = 'cumulative';
        render();
      };
    }
    if (btnStage2 && !btnStage2.onclick) {
      btnStage2.onclick = () => {
        appState.leaderboardViewMode = 'stage2';
        render();
      };
    }
    if (btnStage1 && !btnStage1.onclick) {
      btnStage1.onclick = () => {
        appState.leaderboardViewMode = 'stage1';
        render();
      };
    }
  } else {
    if (toggleContainer) toggleContainer.style.display = 'none';
    if (subtitle) subtitle.textContent = "All players sorted by total score.";
  }

  let allPlayers = [];

  // Aggregate players based on active mode
  if (appState.currentStage === 2 && appState.leaderboardViewMode === 'cumulative') {
    // 1. Gather all players from Stage 1 archived courts
    const stage1Map = new Map();
    if (appState.stage1Courts) {
      appState.stage1Courts.forEach(court => {
        if (court.isActive && court.players) {
          court.players.forEach(p => {
            stage1Map.set(p.name, {
              name: p.name,
              totalScore: p.totalScore || 0,
              pointsPlayed: p.pointsPlayed || 0,
              qualifyingCourt: court.courtNumber,
              avatar: p.avatar
            });
          });
        }
      });
    }

    // 2. Gather players from Stage 2 tiered courts and merge them
    if (appState.courts) {
      appState.courts.forEach(court => {
        if (court.isActive && court.players) {
          court.players.forEach(p => {
            const s1 = stage1Map.get(p.name) || { totalScore: 0, pointsPlayed: 0, qualifyingCourt: null, avatar: '' };
            allPlayers.push({
              name: p.name,
              totalScore: s1.totalScore + (p.totalScore || 0),
              pointsPlayed: s1.pointsPlayed + (p.pointsPlayed || 0),
              courtNumber: court.courtNumber, // current Stage 2 court for tier display
              qualifyingCourt: s1.qualifyingCourt,
              isCumulative: true,
              avatar: p.avatar || s1.avatar
            });
          });
        }
      });
    }
  } else {
    // Standard single stage view
    const targetCourts = (appState.currentStage === 2 && appState.leaderboardViewMode === 'stage1')
      ? appState.stage1Courts
      : appState.courts;

    if (targetCourts && Array.isArray(targetCourts)) {
      targetCourts.forEach(court => {
        if (court.isActive && court.players && Array.isArray(court.players)) {
          court.players.forEach(p => {
            if (!allPlayers.some(existing => existing.name === p.name)) {
              allPlayers.push({
                name: p.name,
                totalScore: p.totalScore || 0,
                courtNumber: court.courtNumber,
                pointsPlayed: p.pointsPlayed || 0,
                isCumulative: false,
                avatar: p.avatar
              });
            }
          });
        }
      });
    }
  }

  // Sort descending by total score, then by points played (tiebreaker)
  allPlayers.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return b.pointsPlayed - a.pointsPlayed;
  });

  if (allPlayers.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 40px; text-align: center; color: var(--text-secondary); font-size: 14px;">No players found in the system yet.</div>`;
    return;
  }

  container.innerHTML = allPlayers.map((p, index) => {
    let rankColor = 'var(--text-secondary)';
    let trophyIcon = '';

    if (index === 0) { rankColor = 'gold'; trophyIcon = '<span class="material-symbols-outlined" style="color: gold; font-size: 16px;">emoji_events</span>'; }
    else if (index === 1) { rankColor = 'silver'; trophyIcon = '<span class="material-symbols-outlined" style="color: silver; font-size: 16px;">emoji_events</span>'; }
    else if (index === 2) { rankColor = '#cd7f32'; trophyIcon = '<span class="material-symbols-outlined" style="color: #cd7f32; font-size: 16px;">emoji_events</span>'; }

    let subtitleHtml = '';
    if (p.isCumulative) {
      const tierName = (TIER_NAMES[p.courtNumber - 1] || `Tier ${p.courtNumber}`).replace(/\s*tier/gi, '');
      const courtName = getCourtName(p.courtNumber, 2);
      subtitleHtml = `${courtName} (${tierName}) • Group ${getCourtName(p.qualifyingCourt, 1)}`;
    } else {
      const courtName = getCourtName(p.courtNumber, 2);
      const tierName = (TIER_NAMES[p.courtNumber - 1] || `Tier ${p.courtNumber}`).replace(/\s*tier/gi, '');
      subtitleHtml = (appState.currentStage === 2 && appState.leaderboardViewMode !== 'stage1')
        ? `${courtName} (${tierName})`
        : getCourtName(p.courtNumber, 1);
    }

    return `
      <div class="leaderboard-item" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
        <div style="display: flex; align-items: center; gap: 14px; min-width: 0; flex-grow: 1; padding-right: 12px;">
          <div style="width: 28px; text-align: center; font-weight: 800; color: ${rankColor}; font-size: 16px; flex-shrink: 0;">
            ${index + 1}
          </div>
          ${renderPlayerAvatar(p, 32)}
          <div style="display: flex; flex-direction: column; min-width: 0; flex-grow: 1;">
            <div style="font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${formatPlayerName(p.name)} ${trophyIcon}
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${subtitleHtml}
            </div>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0;">
          <div style="font-weight: 800; color: var(--neon); font-size: 16px;">${p.totalScore >= 0 ? '+' : ''}${p.totalScore} pts</div>
          <div style="font-size: 10px; color: var(--text-secondary);">${p.pointsPlayed} total pts</div>
        </div>
      </div>
    `;
  }).join('');
}

// --- PREMIUM TOAST HELPER ---
function showPremiumToast(message) {
  let toast = document.getElementById('premium-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'premium-toast';
    toast.style.position = 'fixed';
    toast.style.top = '24px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
    toast.style.background = 'var(--surface-highest)';
    toast.style.backdropFilter = 'blur(20px) saturate(200%)';
    toast.style.border = '1px solid var(--border-gloss)';
    toast.style.borderRadius = '16px';
    toast.style.padding = '12px 20px';
    toast.style.color = 'var(--text-primary)';
    toast.style.fontSize = '13px';
    toast.style.fontWeight = '500';
    toast.style.zIndex = '999999';
    toast.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.15), 0 0 15px var(--neon-glow)';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '8px';
    toast.style.pointerEvents = 'none';
    document.body.appendChild(toast);
  }

  toast.innerHTML = `
    <span class="material-symbols-outlined" style="color: var(--neon); font-size: 18px;">info</span>
    <span>${message}</span>
  `;

  // Trigger transition
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity = '1';
  }, 10);

  // Hide after delay
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    toast.style.opacity = '0';
  }, 3500);
}

// ----------------------------------------------------
// AI MAGIC AUTO-FILL & SNAKE DRAFT BALANCING
// ----------------------------------------------------

function getCourtAverageDUPR(namesArray) {
  if (!namesArray || namesArray.length === 0) return 0;
  let totalDupr = 0;
  let count = 0;
  namesArray.forEach(name => {
    if (name && name.trim() !== '') {
      // Find DUPR suffix in the name, e.g. (3.42) or (2.312)
      const match = name.match(/\((\d+(?:\.\d+)?)\)/);
      if (match) {
        totalDupr += parseFloat(match[1]);
      } else {
        totalDupr += 2.50; // Fallback unrated players to 2.50 if name has content
      }
      count++;
    }
  });
  return count > 0 ? totalDupr / count : 0;
}

function convertFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 1500;

        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Compress as JPEG
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({
          base64: dataUrl.split(',')[1],
          canvas: canvas
        });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

async function extractPlayersAndDUPRFromImages(imageDataList) {
  const savedKey = localStorage.getItem('ai_api_key') || '';
  const savedProvider = localStorage.getItem('ai_provider') || 'gemini';
  const base64Images = imageDataList.map(img => img.base64);

  const firstImage = imageDataList[0];
  const canvasWidth = firstImage && firstImage.canvas ? firstImage.canvas.width : 375;
  const canvasHeight = firstImage && firstImage.canvas ? firstImage.canvas.height : 1500;

  const promptText = `You are a highly accurate pickleball registration AI. Your task is to extract player names, DUPR ratings, and profile picture avatar bounding boxes from the provided screenshot(s) of player profiles.

IMAGE DIMENSIONS:
- Width: ${canvasWidth} pixels
- Height: ${canvasHeight} pixels

GRID FORMAT & ALIGNMENT EXPLANATION:
- The screenshot displays participants in a grid of 4 columns.
- Systematic grouping: Every participant profile is an isolated vertical group containing:
  1. A circular profile picture avatar at the top.
  2. The player's name directly below the avatar (e.g. 'YIP YK', 'Ng C T', 'Adrian Low', 'Victor Lee', 'Jackson Yap').
  3. Optional green text 'Friend' or yellow icon 'Reserved' below the name.
  4. Optional blue 'DUPR X.XXX' or 'DUPR X' badge at the bottom of the group.

CRITICAL NAME INTEGRITY & DETECTION RULES:
- Count the player profiles dynamically. A screenshot can contain any number of players. Do NOT assume a fixed or hardcoded number of players.
- IGNORE empty placeholder/invitation slots. If a slot contains a grey circle, dashed circle, or has no player name text displayed directly below it, it is a placeholder slot. Do NOT transcribe it.
- Combine multi-line names into one player's full name (e.g. 'Adrian\nLow' -> 'Adrian Low').

AVATAR BOUNDING BOXES IN RAW PIXELS:
- For each player, you MUST detect the bounding box of their circular profile picture avatar at the top of their vertical profile group.
- You MUST specify the bounding box in raw pixel coordinates on the ${canvasWidth}x${canvasHeight} image as [ymin, xmin, ymax, xmax] (e.g. [115, 10, 167, 62]).
- CRITICAL: Do NOT return normalized 0-1000 coordinates. Return actual pixel coordinates. ymin/ymax are vertical pixel values (0 = top, ${canvasHeight} = bottom) and xmin/xmax are horizontal pixel values (0 = left, ${canvasWidth} = right).
- Ensure the bounding box tightly wraps ONLY the circular profile photo (avatar) itself. The player's name and rating badge/text below the avatar MUST NOT be included inside the bounding box.

CRITICAL ALIGNMENT RULES:
- A player has a DUPR rating ONLY if there is a blue DUPR badge directly underneath their name in that column.
- If no valid numeric DUPR badge or rating exists, assign a default rating of 2.50.

Respond ONLY with a JSON object in this format:
{
  "chain_of_thought": "Write your detailed step-by-step transcription...",
  "players": [
    {
      "name": "Player Name",
      "transcribed_subtext": "Exact subtext text under name",
      "dupr": 3.754,
      "image_index": 0,
      "avatar_box": [ymin, xmin, ymax, xmax]
    }
  ]
}`;

  const content = [
    {
      type: "text",
      text: promptText
    },
    ...base64Images.map(b64 => ({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${b64}`
      }
    }))
  ];

  const response = await fetch("/api/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": savedKey,
      "X-AI-Provider": savedProvider
    },
    body: JSON.stringify({
      model: savedProvider === 'openai' ? 'gpt-4o' : 'gemini-2.5-flash',
      messages: [
        {
          role: "user",
          content: content
        }
      ],
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error: ${response.statusCode || response.status} - ${errorText}`);
  }

  const resultData = await response.json();
  const parsed = JSON.parse(resultData.choices[0].message.content);
  console.log("CoT Extraction Result:", parsed.chain_of_thought);
  
  const rawPlayers = parsed.players || [];

  // Determine if the coordinates returned are raw pixel values or normalized 0-1000 coordinates.
  let maxVal = 0;
  rawPlayers.forEach(p => {
    if (p.avatar_box && Array.isArray(p.avatar_box)) {
      p.avatar_box.forEach(v => { if (v > maxVal) maxVal = v; });
    }
  });

  const isRawPixels = maxVal > 1000 || (canvasHeight <= 1000);
  
  // Detect if joint 1:1 scaling was used for normalized coordinates
  let jointScaling = false;
  if (!isRawPixels) {
    rawPlayers.forEach(p => {
      if (p.avatar_box && Array.isArray(p.avatar_box) && p.avatar_box.length === 4) {
        const box = p.avatar_box;
        const boxW = box[3] - box[1];
        const boxH = box[2] - box[0];
        if (Math.abs(boxW - boxH) < 5 && Math.abs(canvasWidth - canvasHeight) > 50) {
          jointScaling = true;
        }
      }
    });
  }

  const scaleX = isRawPixels ? 1 : (canvasWidth / 1000);
  const scaleY = isRawPixels ? 1 : (jointScaling ? (canvasWidth / 1000) : (canvasHeight / 1000));

  // Determine first row's top boundary in raw canvas pixels
  let firstRowYmin = Infinity;
  rawPlayers.forEach(p => {
    if (p.avatar_box && Array.isArray(p.avatar_box) && p.avatar_box.length === 4) {
      const yminRaw = p.avatar_box[0] * scaleY;
      if (yminRaw < firstRowYmin) {
        firstRowYmin = yminRaw;
      }
    }
  });
  
  if (firstRowYmin === Infinity) {
    firstRowYmin = 0.31 * canvasWidth;
  }

  const filteredPlayers = rawPlayers.filter(player => {
    if (!player.name) return false;
    const nameTrimmed = player.name.trim().replace(/\s+/g, ' ');
    if (!nameTrimmed) return false;
    
    const nameLower = nameTrimmed.toLowerCase();
    
    if (
      nameLower === 'unknown' ||
      nameLower === 'unknown player' ||
      nameLower === 'placeholder' ||
      nameLower === 'n/a' ||
      nameLower === 'na' ||
      nameLower === 'null' ||
      nameLower === 'none' ||
      nameLower.includes('add player') ||
      nameLower.includes('invite') ||
      nameLower === '+' ||
      nameLower === 'empty'
    ) {
      return false;
    }
    
    return true;
  }).map(player => {
    let finalDupr = 2.50;
    if (typeof player.dupr === 'number' && !isNaN(player.dupr)) {
      finalDupr = player.dupr;
    } else if (typeof player.dupr === 'string') {
      const parsedFloat = parseFloat(player.dupr);
      if (!isNaN(parsedFloat)) {
        finalDupr = parsedFloat;
      }
    }

    // Crop avatar if coordinate box is provided
    let avatarUrl = '';
    try {
      const imgIdx = typeof player.image_index === 'number' ? player.image_index : 0;
      const targetData = imageDataList[imgIdx] || imageDataList[0];
      if (targetData && player.avatar_box && Array.isArray(player.avatar_box) && player.avatar_box.length === 4) {
        const canvas = targetData.canvas;
        const box = player.avatar_box;
        
        const yminRaw = box[0] * scaleY;
        const xminRaw = box[1] * scaleX;
        
        const colWidth = canvas.width / 4;
        const rowHeight = colWidth * 1.6;
        
        // Determine column and row indices
        const col = Math.max(0, Math.min(3, Math.round(xminRaw / colWidth)));
        const row = Math.max(0, Math.round((yminRaw - firstRowYmin) / colWidth));
        
        // Reconstruct crop coordinates mathematically
        const cropSize = colWidth * 0.65;
        const xmin = (col + 0.5) * colWidth - cropSize / 2;
        const ymin = firstRowYmin + row * rowHeight;
        
        const boxWidth = cropSize;
        const boxHeight = cropSize;
        
        const clipXmin = Math.max(0, Math.min(canvas.width - 1, xmin));
        const clipYmin = Math.max(0, Math.min(canvas.height - 1, ymin));
        const clipWidth = Math.max(1, Math.min(canvas.width - clipXmin, boxWidth));
        const clipHeight = Math.max(1, Math.min(canvas.height - clipYmin, boxHeight));
        
        if (clipWidth > 5 && clipHeight > 5) {
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = 64;
          cropCanvas.height = 64;
          const cropCtx = cropCanvas.getContext('2d');
          
          cropCtx.drawImage(canvas, clipXmin, clipYmin, clipWidth, clipHeight, 0, 0, 64, 64);
          avatarUrl = cropCanvas.toDataURL('image/jpeg', 0.75);
          
          // Store globally
          const cleanName = player.name.trim().replace(/\s+/g, ' ');
          if (!appState.avatars) appState.avatars = {};
          appState.avatars[cleanName] = avatarUrl;
        }
      }
    } catch (cropErr) {
      console.error("Avatar cropping failed for", player.name, cropErr);
    }

    return {
      name: player.name.trim().replace(/\s+/g, ' '),
      dupr: finalDupr,
      avatar: avatarUrl
    };
  });

  return filteredPlayers;
}

function assignBalancedPlayersToCourts(extractedPlayers) {
  // extractedPlayers is an array of objects: { name: string, dupr: number }
  // Sort descending by dupr
  extractedPlayers.sort((a, b) => b.dupr - a.dupr);

  // Get active courts
  const activeCourts = appState.courts ? appState.courts.filter(c => c.isActive) : [];
  if (activeCourts.length === 0) return;

  const numCourts = activeCourts.length;

  // Initialize player list for each active court
  const courtPlayersList = Array.from({ length: numCourts }, () => []);

  // Snake draft distribution: C1 -> C2 -> C3 -> C3 -> C2 -> C1...
  let goingForward = true;
  let courtIndex = 0;
  for (let i = 0; i < extractedPlayers.length; i++) {
    const player = extractedPlayers[i];
    let formattedDupr = player.dupr.toString();
    const dotIdx = formattedDupr.indexOf('.');
    if (dotIdx === -1) {
      formattedDupr = player.dupr.toFixed(2);
    } else {
      const decimals = formattedDupr.length - dotIdx - 1;
      if (decimals < 2) {
        formattedDupr = player.dupr.toFixed(2);
      }
    }
    const nameWithDupr = `${player.name} (${formattedDupr})`;
    courtPlayersList[courtIndex].push(nameWithDupr);

    // Move to next court in snake draft sequence
    if (goingForward) {
      if (courtIndex === numCourts - 1) {
        goingForward = false;
      } else {
        courtIndex++;
      }
    } else {
      if (courtIndex === 0) {
        goingForward = true;
      } else {
        courtIndex--;
      }
    }
  }

  // Clear reserves bench
  appState.entryState.bench = {
    names: [],
    count: 0
  };

  // Assign to court entryState and pad to at least 4
  activeCourts.forEach((court, idx) => {
    const names = courtPlayersList[idx];
    while (names.length < 4) {
      names.push('');
    }
    if (names.length > 7) {
      names.length = 7;
    }

    appState.entryState[court.courtNumber] = {
      names: names,
      count: names.length
    };
  });

  // Re-render entry screen to update averages and display
  renderPlayerEntry(activeCourts);
  saveStateToCloud();
}

function setupMagicAutoFill() {
  const autofillBtn = document.getElementById('magic-autofill-btn');
  const aiModal = document.getElementById('ai-upload-modal');
  const closeBtn = document.getElementById('ai-modal-close-btn');
  const fileInput = document.getElementById('ai-image-upload');
  const uploadZone = document.getElementById('ai-upload-zone');
  const processingState = document.getElementById('ai-processing-state');

  // AI settings DOM elements
  const settingsToggleBtn = document.getElementById('ai-settings-toggle-btn');
  const settingsGearIcon = document.getElementById('ai-settings-gear-icon');
  const settingsZone = document.getElementById('ai-settings-zone');
  const providerSelect = document.getElementById('ai-settings-provider');
  const keyInput = document.getElementById('ai-settings-key');
  const keyVisibilityBtn = document.getElementById('ai-settings-key-visibility-btn');
  const visibilityIcon = document.getElementById('ai-visibility-icon');
  const saveSettingsBtn = document.getElementById('ai-settings-save-btn');
  
  if (!autofillBtn || !aiModal) return;

  // Load and refresh input values from localStorage
  const loadSettings = () => {
    const savedKey = localStorage.getItem('ai_api_key') || '';
    const savedProvider = localStorage.getItem('ai_provider') || 'gemini';
    if (providerSelect) providerSelect.value = savedProvider;
    if (keyInput) keyInput.value = savedKey;
  };



  autofillBtn.addEventListener('click', () => {
    aiModal.classList.remove('view-hidden');
    setTimeout(() => {
      document.body.classList.add('modal-open');
    }, 10);
    fileInput.value = '';
    
    // Default show upload zone, hide settings and loading
    if (uploadZone) uploadZone.style.display = 'flex';
    if (processingState) processingState.style.display = 'none';
    if (settingsZone) settingsZone.style.display = 'none';
    if (settingsGearIcon) settingsGearIcon.classList.remove('gear-spin-active');
    isSettingsOpen = false;
    
    loadSettings();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.body.classList.remove('modal-open');
      setTimeout(() => {
        aiModal.classList.add('view-hidden');
      }, 300);
    });
  }

  // Toggle API Key text visibility
  if (keyVisibilityBtn && keyInput && visibilityIcon) {
    keyVisibilityBtn.addEventListener('click', () => {
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      visibilityIcon.textContent = isPassword ? 'visibility_off' : 'visibility';
    });
  }

  // Toggle Settings Zone display
  let isSettingsOpen = false;
  if (settingsToggleBtn && settingsGearIcon && settingsZone && uploadZone && processingState) {
    settingsToggleBtn.addEventListener('click', () => {
      isSettingsOpen = !isSettingsOpen;
      if (isSettingsOpen) {
        settingsGearIcon.classList.add('gear-spin-active');
        uploadZone.style.display = 'none';
        processingState.style.display = 'none';
        settingsZone.style.display = 'flex';
        loadSettings();
      } else {
        settingsGearIcon.classList.remove('gear-spin-active');
        settingsZone.style.display = 'none';
        processingState.style.display = 'none';
        uploadZone.style.display = 'flex';
      }
    });
  }

  // Save Settings logic
  if (saveSettingsBtn && keyInput && providerSelect && settingsGearIcon && settingsZone && uploadZone) {
    saveSettingsBtn.addEventListener('click', () => {
      const keyVal = keyInput.value.trim();
      const providerVal = providerSelect.value;

      if (!keyVal) {
        alert("Please enter a valid API key before saving.");
        return;
      }

      localStorage.setItem('ai_api_key', keyVal);
      localStorage.setItem('ai_provider', providerVal);

      showPremiumToast(`API credentials saved successfully!`);
      
      // Auto transition back to upload view
      isSettingsOpen = false;
      settingsGearIcon.classList.remove('gear-spin-active');
      settingsZone.style.display = 'none';
      uploadZone.style.display = 'flex';
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      // Show processing state
      if (uploadZone) uploadZone.style.display = 'none';
      if (processingState) processingState.style.display = 'flex';

      try {
        const promises = Array.from(files).map(file => convertFileToBase64(file));
        const imageDataList = await Promise.all(promises);
        
        const extractedPlayers = await extractPlayersAndDUPRFromImages(imageDataList);
        
        if (extractedPlayers && extractedPlayers.length > 0) {
          assignBalancedPlayersToCourts(extractedPlayers);
          showPremiumToast(`Successfully extracted and snake-drafted ${extractedPlayers.length} players!`);
          document.body.classList.remove('modal-open');
          setTimeout(() => {
            aiModal.classList.add('view-hidden');
            navigateTo('player-entry');
          }, 300);
        } else {
          alert("No players could be extracted from the uploaded images. Please try again with clearer screenshots.");
          if (uploadZone) uploadZone.style.display = 'flex';
          if (processingState) processingState.style.display = 'none';
        }
      } catch (error) {
        console.error("AI Auto-Fill error:", error);
        alert(`Error during AI extraction: ${error.message}`);
        if (uploadZone) uploadZone.style.display = 'flex';
        if (processingState) processingState.style.display = 'none';
      }
    });
  }
}
