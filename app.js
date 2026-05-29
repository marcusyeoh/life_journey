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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const mixerDocRef = doc(db, "mixers", "current_mixer");

// Application State
const appState = {
  isAdmin: checkAdminMode(),
  currentView: checkAdminMode() ? 'court-setup' : 'user-landing',
  currentStage: 1, // 1: Qualifying, 2: Championship
  stage1Courts: null,
  stage2ViewingQualifying: false,
  stage2PreviewTiers: [],
  
  // List of 6 Courts
  courts: Array.from({ length: 6 }, (_, i) => ({
    courtNumber: i + 1,
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
      if (match.isCompleted && match.team1Score !== null && match.team2Score !== null) {
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

function generatePairingsForCourt(court) {
  court.matches = [];
  // Reset all players scores to 0 for a fresh start
  court.players.forEach(p => p.totalScore = 0);
  court.activeRound = 1;
  
  const n = court.players.length;
  const p = court.players;
  
  if (n === 4) {
    // 3 rounds - everyone partners with everyone else exactly once
    court.matches.push(new Match(p[0], p[1], p[2], p[3]));
    court.matches.push(new Match(p[0], p[2], p[1], p[3]));
    court.matches.push(new Match(p[0], p[3], p[1], p[2]));
  } else if (n === 5) {
    // 5 rounds - everyone partners with everyone exactly once, 1 bye per round
    court.matches.push(new Match(p[0], p[3], p[1], p[2])); // Bye: p[4]
    court.matches.push(new Match(p[1], p[4], p[2], p[3])); // Bye: p[0]
    court.matches.push(new Match(p[2], p[0], p[3], p[4])); // Bye: p[1]
    court.matches.push(new Match(p[3], p[1], p[4], p[0])); // Bye: p[2]
    court.matches.push(new Match(p[4], p[2], p[0], p[1])); // Bye: p[3]
  } else if (n === 6) {
    // 6 rounds - perfect rotation, every player plays exactly 4 rounds, no duplicate partnerships
    // Matches are interleaved to prevent any player from sitting out two consecutive rounds
    court.matches.push(new Match(p[0], p[1], p[2], p[3])); // Byes: p[4], p[5]
    court.matches.push(new Match(p[0], p[4], p[1], p[5])); // Byes: p[2], p[3]
    court.matches.push(new Match(p[2], p[4], p[3], p[5])); // Byes: p[0], p[1]
    court.matches.push(new Match(p[0], p[2], p[1], p[3])); // Byes: p[4], p[5]
    court.matches.push(new Match(p[0], p[5], p[1], p[4])); // Byes: p[2], p[3]
    court.matches.push(new Match(p[2], p[5], p[3], p[4])); // Byes: p[0], p[1]
  }
}

// ----------------------------------------------------
// INTEGER PARTITIONING ALGORITHM
// ----------------------------------------------------
function findOptimalPartition(playerCount) {
  if (playerCount < 4 || playerCount > 36) return null;
  
  const results = [];
  
  function backtrack(remaining, currentPartition) {
    if (remaining === 0) {
      if (currentPartition.length <= 6) {
        results.push([...currentPartition]);
      }
      return;
    }
    if (currentPartition.length >= 6) return;
    
    // Try sizes 6, 5, 4 (prefer larger group sizes first as possibilities)
    for (let size of [6, 5, 4]) {
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
    if (i === 1) {
      // Elegant demo data for Court 1
      initialNames = ['Sarah Jenkins', 'Mike Rossi', 'Emma Watson', 'David Chen'];
    }
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
  updateSyncStatus('connecting');
  
  onSnapshot(mixerDocRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      console.log("Real-time cloud update received!");
      
      appState.currentStage = data.currentStage || 1;
      appState.stage1Courts = data.stage1Courts || null;
      appState.stage2ViewingQualifying = data.stage2ViewingQualifying || false;
      appState.stage2PreviewTiers = data.stage2PreviewTiers || [];
      
      if (data.courts) {
        appState.courts = data.courts;
      }
      if (data.entryState) {
        appState.entryState = data.entryState;
      }
      
      // Determine navigation dynamically based on role and mixer activity
      const hasActiveMixer = appState.courts && appState.courts.some(c => c.isActive && c.matches && c.matches.length > 0);
      
      let targetView = 'user-landing';
      if (appState.isAdmin) {
        // Admins follow the saved view
        targetView = data.currentView || 'court-setup';
        
        // Ensure selections are valid inside the active courts list
        const activeCourts = appState.courts.filter(c => c.isActive);
        if (activeCourts.length > 0 && !activeCourts.some(c => c.courtNumber === appState.selectedCourtNumber)) {
          appState.selectedCourtNumber = activeCourts[0].courtNumber;
        }
      } else {
        // Players (User Mode) are automatically locked to active screens
        if (hasActiveMixer) {
          targetView = 'dashboard';
          // Ensure active court tab is selected if none currently chosen
          const activeCourts = appState.courts.filter(c => c.isActive);
          if (activeCourts.length > 0) {
            if (!activeCourts.some(c => c.courtNumber === appState.selectedCourtNumber)) {
              appState.selectedCourtNumber = activeCourts[0].courtNumber;
              appState.viewingRound = activeCourts[0].activeRound;
            }
          }
        } else {
          targetView = 'user-landing';
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
    console.error("Firebase real-time sync failed:", error);
    updateSyncStatus('error');
    
    // Graceful fallback to local render
    render();
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
    const isActive = court.isActive;
    
    const card = document.createElement('div');
    card.className = `card court-card ${isActive ? 'active' : ''}`;
    card.setAttribute('data-court-number', court.courtNumber);
    
    card.innerHTML = `
      <div class="court-card-header">
        <div class="court-title-area">
          <span class="material-symbols-outlined">grid_view</span>
          <span>Court ${court.courtNumber}</span>
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
        court.isActive = toggle.checked;
        saveStateToCloud(); // Save instantly to Cloud to sync all views and prevent race conditions!
        render();
      });
    }
    
    // Add players button listener
    if (isActive) {
      const btn = card.querySelector('.add-players-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          // Select this court as the active input court
          const activeCourts = appState.courts.filter(c => c.isActive);
          appState.selectedCourtNumber = court.courtNumber;
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

  if (hasActiveMixer) {
    if (title) title.textContent = 'Tournament Settings';
    if (subtitle) subtitle.textContent = 'Modify active courts or players. Warning: Editing active courts may require match regeneration.';
    if (warningBanner) warningBanner.style.display = 'flex';
    if (resumeBtn) resumeBtn.style.display = 'flex';
  } else {
    if (title) title.textContent = 'New Mixer Setup';
    if (subtitle) subtitle.textContent = 'Select the courts available for this tournament block. Add designated players if required.';
    if (warningBanner) warningBanner.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';
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
    const col = document.createElement('div');
    col.className = 'board-column';
    col.setAttribute('data-list-id', court.courtNumber.toString());

    // Defensive: Get court entry and ensure names exists
    let entry = appState.entryState[court.courtNumber];
    if (!entry) {
      entry = { names: [], count: 4 };
      appState.entryState[court.courtNumber] = entry;
    }
    if (!entry.names) {
      entry.names = [];
    }
    const filledCount = entry.names.filter(n => n && n.trim() !== '').length;

    // Capacity validation badge styling
    let badgeText = `${filledCount}/6 Players`;
    let badgeClass = 'valid';

    if (filledCount < 4) {
      badgeText = `Needs 4-6 Players`;
      badgeClass = 'invalid';
    } else if (filledCount === 6) {
      badgeText = `6/6 (Full)`;
      badgeClass = 'valid';
    }

    const colHeader = document.createElement('div');
    colHeader.className = 'board-column-header';
    colHeader.innerHTML = `
      <div class="board-column-title">
        <span class="material-symbols-outlined">grid_view</span>
        <span>Court ${court.courtNumber}</span>
      </div>
      <span class="capacity-badge ${badgeClass}">${badgeText}</span>
    `;
    col.appendChild(colHeader);

    const dragList = document.createElement('div');
    dragList.className = 'player-drag-list';
    dragList.setAttribute('data-list-id', court.courtNumber.toString());

    entry.names.forEach((name, idx) => {
      const item = document.createElement('div');
      item.className = 'player-drag-item';
      item.setAttribute('data-index', idx.toString());
      item.innerHTML = `
        <span class="material-symbols-outlined drag-handle">drag_indicator</span>
        <input type="text" placeholder="Player Name" class="player-drag-input" value="${name || ''}" data-idx="${idx}">
        <button class="delete-player-btn" aria-label="Delete player">
          <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
        </button>
      `;

      // Event listener for name change (without destructive rendering to prevent focus loss)
      const input = item.querySelector('.player-drag-input');
      if (input) {
        input.addEventListener('input', (e) => {
          entry.names[idx] = e.target.value.trim();
          
          // Dynamically update count badge and bottom generate button state
          const updatedFilled = entry.names.filter(n => n && n.trim() !== '').length;
          const badge = col.querySelector('.capacity-badge');
          if (badge) {
            if (updatedFilled < 4) {
              badge.textContent = `Needs 4-6 Players`;
              badge.className = 'capacity-badge invalid';
            } else if (updatedFilled === 6) {
              badge.textContent = `6/6 (Full)`;
              badge.className = 'capacity-badge valid';
            } else {
              badge.textContent = `${updatedFilled}/6 Players`;
              badge.className = 'capacity-badge valid';
            }
          }
          
          validateEntryGeneration(activeCourts);
        });
      }

      // Event listener for delete player
      const deleteBtn = item.querySelector('.delete-player-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          entry.names.splice(idx, 1);
          renderPlayerEntry(activeCourts);
        });
      }

      dragList.appendChild(item);
    });

    col.appendChild(dragList);

    // Inline + Add Player button at bottom of court list (max 6 players)
    if (entry.names.length < 6) {
      const addBtn = document.createElement('button');
      addBtn.className = 'inline-add-player-btn';
      addBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">add</span> Add Player`;
      addBtn.addEventListener('click', () => {
        entry.names.push('');
        listToFocus = court.courtNumber.toString();
        renderPlayerEntry(activeCourts);
      });
      col.appendChild(addBtn);
    }

    container.appendChild(col);
  });

  // 3. Keep newly added inputs in focus
  if (listToFocus) {
    const focusedCol = container.querySelector(`.board-column[data-list-id="${listToFocus}"]`);
    if (focusedCol) {
      const inputs = focusedCol.querySelectorAll('.player-drag-input');
      if (inputs.length > 0) {
        const lastInput = inputs[inputs.length - 1];
        lastInput.focus();
      }
    }
    listToFocus = null;
  }

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
    // Each active court must have EXACTLY 4, 5, or 6 players to generate pairings
    if (filledCount !== 4 && filledCount !== 5 && filledCount !== 6) {
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

          // Enforce max 6 player slots on courts
          const targetCapacity = 6;
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
    if (advanceCard) advanceCard.style.display = 'none';
    if (backLinkContainer) backLinkContainer.style.display = 'flex';
    
    const toggleText = appState.stage2ViewingQualifying ? 'Back to Championship Stage Standings' : 'View Group Stage Standings';
    const btnToggleText = document.getElementById('btn-toggle-stage-text');
    if (btnToggleText) btnToggleText.textContent = toggleText;
    
    if (dashboardTitle) {
      dashboardTitle.textContent = appState.stage2ViewingQualifying ? 'Group Stage Dashboard' : 'Championship Stage Dashboard';
    }
    if (leaderboardTitleText) {
      leaderboardTitleText.textContent = appState.stage2ViewingQualifying ? 'Live Leaderboard (Group Stage)' : 'Live Leaderboard (Championship Stage)';
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
          if (advanceBtnText) advanceBtnText.textContent = 'Advance to Championship Stage';
        } else {
          if (advanceIcon) advanceIcon.textContent = 'warning';
          if (advanceTitle) advanceTitle.textContent = 'Championship Stage Transition';
          if (advanceDesc) advanceDesc.textContent = 'Group Stage qualifying matches are still in progress. You can manually force-advance to Championship Stage based on current scores.';
          if (advanceBtnText) advanceBtnText.textContent = 'Force-Start Championship Stage';
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
    const tab = document.createElement('div');
    tab.className = `tab-chip ${isSelected ? 'active' : ''}`;
    
    const tabName = (appState.currentStage === 2 && !appState.stage2ViewingQualifying)
      ? `${TIER_NAMES[c.courtNumber - 1] || `Tier ${c.courtNumber}`} (Court ${c.courtNumber})`
      : `Court ${c.courtNumber}`;
      
    tab.textContent = tabName;
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
    
    const chip = document.createElement('div');
    chip.className = `round-chip ${isViewing ? 'viewing' : ''} ${isActiveRound ? 'active-round' : ''}`;
    chip.textContent = `Round ${i}`;
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
    const byes = [];
    const playing = new Set([
      match.team1Player1.name,
      match.team1Player2.name,
      match.team2Player1.name,
      match.team2Player2.name
    ]);
    
    court.players.forEach(p => {
      if (!playing.has(p.name)) {
        byes.push(p.name);
      }
    });
    
    // Render Card Contents
    matchCard.innerHTML = `
      <div class="match-card-status-row">
        <div class="status-chip">
          ${match.isCompleted ? `
            <span class="material-symbols-outlined" style="color: var(--green); font-size: 14px;">check_circle</span>
            <span>COMPLETED</span>
          ` : `
            <span class="pulse-dot"></span>
            <span>IN PROGRESS</span>
          `}
        </div>
        <div style="font-size: 13px; font-weight: 700; color: var(--text-secondary); background: var(--surface-highest); padding: 4px 10px; border-radius: 6px; margin-left: auto; margin-right: ${match.isCompleted ? '12px' : '0'};">
          Court ${court.courtNumber}
        </div>
        ${match.isCompleted ? `
          <div class="match-card-score">${match.team1Score} - ${match.team2Score}</div>
        ` : ''}
      </div>
      <div class="match-teams-row">
        <div class="match-team">
          <h4>Team Alpha</h4>
          <p>${match.team1Player1.name}<br>${match.team1Player2.name}</p>
        </div>
        <div class="vs-badge">VS</div>
        <div class="match-team team-2">
          <h4>Team Bravo</h4>
          <p>${match.team2Player1.name}<br>${match.team2Player2.name}</p>
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
          appState.modal.score1 = 15;
          appState.modal.score2 = 10;
        }
        
        render();
      });
    }
    
    // 4. Render On Deck Byes list
    const deckNames = document.getElementById('dashboard-on-deck-names');
    if (byes.length > 0) {
      deckNames.textContent = byes.join(' & ');
      document.getElementById('dashboard-on-deck-banner').style.display = 'flex';
    } else {
      document.getElementById('dashboard-on-deck-banner').style.display = 'none';
    }
  } else {
    matchCard.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No matches generated for this round.</p>';
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
      <span class="leaderboard-name">${player.name}</span>
      <span class="leaderboard-score-chip ${scoreClass}">${prefix}${score}</span>
    `;
    leaderboardContainer.appendChild(item);
  });
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
  const match = court.matches[appState.modal.matchIndex];
  
  // Set players names in modal
  document.getElementById('modal-court-round-badge').textContent = `Court ${court.courtNumber} • Round ${appState.modal.matchIndex + 1}`;
  document.getElementById('modal-team1-names').textContent = `${match.team1Player1.name} & ${match.team1Player2.name}`;
  document.getElementById('modal-team2-names').textContent = `${match.team2Player1.name} & ${match.team2Player2.name}`;
  
  // Steppers Score Text
  const val1 = document.getElementById('stepper-val-1');
  const val2 = document.getElementById('stepper-val-2');
  val1.textContent = appState.modal.score1;
  val2.textContent = appState.modal.score2;
  
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
      if (appState.modal.score1 < 99) {
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
      if (appState.modal.score2 < 99) {
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
      
      // Auto-advancement hook during Group Stage (Stage 1) for Admins
      if (appState.currentStage === 1 && checkStage1Completion() && appState.isAdmin) {
        advanceToStage2();
        saveStateToCloud(); // Save immediately to sync advanced stage and view
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

  const resumeDashboardBtn = document.getElementById('btn-resume-dashboard');
  if (resumeDashboardBtn) {
    resumeDashboardBtn.addEventListener('click', () => {
      navigateTo('dashboard');
    });
  }
  
  // Stage 2 Navigation & Promotion Bindings
  const dashboardAdvanceBtn = document.getElementById('btn-dashboard-advance');
  if (dashboardAdvanceBtn) {
    dashboardAdvanceBtn.addEventListener('click', () => {
      advanceToStage2();
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

  // Admin Success Screen Bindings
  const successViewLiveBtn = document.getElementById('btn-success-view-live');
  if (successViewLiveBtn) {
    successViewLiveBtn.addEventListener('click', () => {
      navigateTo('dashboard');
    });
  }
  
  const successResetBtn = document.getElementById('btn-success-reset');
  if (successResetBtn) {
    successResetBtn.addEventListener('click', () => {
      resetMixer();
    });
  }
  
  // Premium Bottom Navigation items click events
  const navRound1 = document.getElementById('nav-round1');
  if (navRound1) {
    navRound1.addEventListener('click', () => {
      if (appState.currentStage === 1) {
        // Already in Group Stage
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
        if (appState.isAdmin) {
          const hasCompleted = checkStage1Completion();
          const msg = hasCompleted 
            ? "All Group Stage matches are completed! Do you want to advance to Championship Stage?"
            : "Group Stage matches are not all completed. Do you want to force-advance to Championship Stage based on current scores?";
          if (confirm(msg)) {
            advanceToStage2();
            saveStateToCloud();
          }
        } else {
          showPremiumToast("Championship Stage will begin once the admin advances the tournament!");
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

async function saveStateToCloud() {
  const cloudSaveBtn = document.getElementById('btn-cloud-save');
  if (!cloudSaveBtn) return;
  
  const originalHtml = cloudSaveBtn.innerHTML;
  cloudSaveBtn.disabled = true;
  cloudSaveBtn.innerHTML = `
    <span class="material-symbols-outlined" style="font-size: 16px; animation: pulse 1s infinite ease-in-out;">sync</span>
    Saving...
  `;
  updateSyncStatus('syncing');
  
  try {
    const serializedState = {
      currentView: appState.currentView,
      currentStage: appState.currentStage,
      stage1Courts: appState.stage1Courts,
      stage2ViewingQualifying: appState.stage2ViewingQualifying,
      stage2PreviewTiers: appState.stage2PreviewTiers,
      courts: JSON.parse(JSON.stringify(appState.courts)),
      selectedCourtNumber: appState.selectedCourtNumber,
      viewingRound: appState.viewingRound,
      entryState: JSON.parse(JSON.stringify(appState.entryState))
    };
    
    await setDoc(mixerDocRef, serializedState);
    
    updateSyncStatus('saved');
    cloudSaveBtn.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 16px; color: var(--green);">check_circle</span>
      Saved!
    `;
    
    setTimeout(() => {
      cloudSaveBtn.disabled = false;
      cloudSaveBtn.innerHTML = originalHtml;
    }, 2000);
  } catch (error) {
    console.error("Firestore cloud save error:", error);
    updateSyncStatus('error');
    cloudSaveBtn.disabled = false;
    cloudSaveBtn.innerHTML = originalHtml;
  }
}

async function resetMixer() {
  if (!confirm("Are you sure you want to reset the entire tournament? This will clear all players, matches, and scores across all courts locally and in the Cloud.")) {
    return;
  }
  
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
  appState.stage1Courts = null;
  appState.stage2ViewingQualifying = false;
  appState.stage2PreviewTiers = [];
  appState.selectedCourtNumber = 1;
  appState.viewingRound = 1;
  appState.courts = Array.from({ length: 6 }, (_, i) => ({
    courtNumber: i + 1,
    isActive: false,
    players: [],
    matches: [],
    activeRound: 1
  }));
  
  for (let i = 1; i <= 6; i++) {
    let initialNames = ['', '', '', ''];
    if (i === 1) {
      initialNames = ['Sarah Jenkins', 'Mike Rossi', 'Emma Watson', 'David Chen'];
    }
    appState.entryState[i] = {
      names: initialNames,
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
  const partition = findOptimalPartition(allPlayers.length);
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
          <span style="font-weight: 700; color: var(--text-primary);">${p.name}</span>
          <span class="seed-badge">
            Rank ${p.courtRank} (Court ${p.courtNumber}) • ${scorePrefix}${p.stage1Score} diff
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
  
  // Save new Championship stage to Cloud!
  saveStateToCloud();
  
  // Navigate to Dashboard
  navigateTo('dashboard');
}

// --- ADMIN SUCCESS RENDER ---
function renderAdminSuccess() {
  const activeCourts = appState.courts.filter(c => c.isActive);
  
  const activeCourtsEl = document.getElementById('success-active-courts-count');
  if (activeCourtsEl) activeCourtsEl.textContent = `${activeCourts.length} Court${activeCourts.length === 1 ? '' : 's'}`;
}

// --- GLOBAL LEADERBOARD LOGIC ---
function renderGlobalLeaderboard(sourceCourts) {
  const container = document.getElementById('global-leaderboard-container');
  if (!container) return;
  
  let allPlayers = [];
  
  // Aggregate players from all courts
  if (sourceCourts && Array.isArray(sourceCourts)) {
    sourceCourts.forEach(court => {
      if (court.isActive && court.players && Array.isArray(court.players)) {
        court.players.forEach(p => {
          // ensure uniqueness by name
          if (!allPlayers.some(existing => existing.name === p.name)) {
            allPlayers.push({
              name: p.name,
              totalScore: p.totalScore || 0,
              courtNumber: court.courtNumber,
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
  
  if (allPlayers.length === 0) {
    container.innerHTML = `<div class="empty-state">No players found in the system yet.</div>`;
    return;
  }
  
  container.innerHTML = allPlayers.map((p, index) => {
    let rankColor = 'var(--text-secondary)';
    let trophyIcon = '';
    
    if (index === 0) { rankColor = 'gold'; trophyIcon = '<span class="material-symbols-outlined" style="color: gold; font-size: 16px;">emoji_events</span>'; }
    else if (index === 1) { rankColor = 'silver'; trophyIcon = '<span class="material-symbols-outlined" style="color: silver; font-size: 16px;">emoji_events</span>'; }
    else if (index === 2) { rankColor = '#cd7f32'; trophyIcon = '<span class="material-symbols-outlined" style="color: #cd7f32; font-size: 16px;">emoji_events</span>'; }
    
    return `
      <div class="leaderboard-item" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="width: 28px; text-align: center; font-weight: 800; color: ${rankColor}; font-size: 16px;">
            ${index + 1}
          </div>
          <div style="display: flex; flex-direction: column;">
            <div style="font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 6px;">
              ${p.name} ${trophyIcon}
            </div>
            <div style="font-size: 11px; color: var(--text-secondary);">
              Qualifying Court ${p.courtNumber}
            </div>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end;">
          <div style="font-weight: 800; color: var(--neon); font-size: 16px;">${p.totalScore} pts</div>
          <div style="font-size: 10px; color: var(--text-secondary);">${p.pointsPlayed} played</div>
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
    toast.style.background = 'rgba(32, 31, 31, 0.95)';
    toast.style.border = '1px solid var(--neon)';
    toast.style.borderRadius = '16px';
    toast.style.padding = '12px 20px';
    toast.style.color = 'var(--text-primary)';
    toast.style.fontSize = '13px';
    toast.style.fontWeight = '500';
    toast.style.zIndex = '999999';
    toast.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.3), 0 0 15px var(--neon-glow)';
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
