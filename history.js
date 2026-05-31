import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Firebase Configuration (freedomrent-proo)
const firebaseConfig = {
  authDomain: "freedomrent-proo.firebaseapp.com",
  projectId: "freedomrent-proo",
  storageBucket: "freedomrent-proo.firebasestorage.app",
  messagingSenderId: "542369288151",
  appId: "1:542369288151:web:ddf8582f6f4370776b6bb1",
  measurementId: "G-9QNNP9Y1Z4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const historyContainer = document.getElementById('history-list-container');

async function loadHistory() {
  try {
    const q = query(collection(db, "mixers_history"), orderBy("savedAt", "desc"));
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.empty) {
      historyContainer.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); padding: 60px 20px; background: var(--surface); border-radius: 20px; border: 1px dashed var(--surface-highest);">
          <span class="material-symbols-outlined" style="font-size: 48px; margin-bottom: 16px; color: var(--surface-highest);">history</span>
          <p style="font-weight: 600;">No saved games found.</p>
          <p style="font-size: 13px; margin-top: 8px;">Save a game from the Admin Dashboard to see it here.</p>
        </div>
      `;
      return;
    }

    historyContainer.innerHTML = '';
    
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const id = docSnap.id;
      
      const date = new Date(data.savedAt || parseInt(id));
      const dateString = date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      
      const activeCourts = data.courts ? data.courts.filter(c => c.isActive).length : 0;
      const stage = data.currentStage === 2 ? 'Championship Stage' : 'Group Stage';
      
      const card = document.createElement('div');
      card.className = 'history-card neon-glow';
      
      card.innerHTML = `
        <div class="history-header">
          <div class="history-title">Tournament Snapshot</div>
          <div class="history-date">${dateString}</div>
        </div>
        <div class="history-stats">
          <div class="history-stat-item">
            <span class="material-symbols-outlined" style="font-size: 18px; color: var(--neon);">grid_view</span>
            ${activeCourts} Active Courts
          </div>
          <div class="history-stat-item">
            <span class="material-symbols-outlined" style="font-size: 18px; color: var(--neon);">emoji_events</span>
            ${stage}
          </div>
        </div>
        <div class="history-actions">
          <button class="btn-primary neon-glow-active load-btn" data-id="${id}" style="flex: 1; height: 44px; border-radius: 12px; font-size: 14px; font-weight: 700; gap: 8px;">
            <span class="material-symbols-outlined" style="font-size: 18px;">restore</span>
            Load Game
          </button>
          <button class="add-players-btn delete-btn" data-id="${id}" style="height: 44px; padding: 0 16px; border-radius: 12px; border-color: rgba(248, 113, 113, 0.4); color: var(--red); background: transparent;">
            <span class="material-symbols-outlined" style="font-size: 20px;">delete</span>
          </button>
        </div>
      `;
      
      historyContainer.appendChild(card);
      
      // Bind events
      const loadBtn = card.querySelector('.load-btn');
      loadBtn.addEventListener('click', () => loadGame(id, data, loadBtn));
      
      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', () => deleteGame(id, card));
    });
    
  } catch (err) {
    console.error("Error loading history:", err);
    historyContainer.innerHTML = `
      <div style="text-align: center; color: var(--red); padding: 40px; background: var(--red-bg); border-radius: 16px; border: 1px dashed rgba(248, 113, 113, 0.4);">
        <p style="font-weight: 700;">Error loading history.</p>
        <p style="font-size: 13px; margin-top: 8px;">Check your connection and try again.</p>
      </div>
    `;
  }
}

async function loadGame(id, data, btnElement) {
  const originalHtml = btnElement.innerHTML;
  btnElement.innerHTML = `<span class="material-symbols-outlined" style="animation: pulse 1s infinite;">sync</span> Loading...`;
  btnElement.disabled = true;
  
  try {
    const mixerDocRef = doc(db, "mixers", "current_mixer");
    
    // We remove the savedAt key before writing to current_mixer just to keep it clean, though it doesn't hurt.
    const stateToRestore = { ...data };
    delete stateToRestore.savedAt;
    
    await setDoc(mixerDocRef, stateToRestore);
    
    btnElement.innerHTML = `<span class="material-symbols-outlined">check_circle</span> Loaded!`;
    
    setTimeout(() => {
      // Redirect to admin index
      window.location.href = '/index.html?admin=true';
    }, 800);
    
  } catch (err) {
    console.error("Error restoring game:", err);
    alert("Failed to load game. Check console.");
    btnElement.innerHTML = originalHtml;
    btnElement.disabled = false;
  }
}

async function deleteGame(id, cardElement) {
  if (!confirm("Are you sure you want to permanently delete this saved game? This cannot be undone.")) return;
  
  try {
    await deleteDoc(doc(db, "mixers_history", id));
    cardElement.style.opacity = '0.5';
    cardElement.style.pointerEvents = 'none';
    
    setTimeout(() => {
      cardElement.remove();
      if (historyContainer.children.length === 0) {
        historyContainer.innerHTML = `
          <div style="text-align: center; color: var(--text-secondary); padding: 60px 20px; background: var(--surface); border-radius: 20px; border: 1px dashed var(--surface-highest);">
            <span class="material-symbols-outlined" style="font-size: 48px; margin-bottom: 16px; color: var(--surface-highest);">history</span>
            <p style="font-weight: 600;">No saved games found.</p>
            <p style="font-size: 13px; margin-top: 8px;">Save a game from the Admin Dashboard to see it here.</p>
          </div>
        `;
      }
    }, 300);
  } catch (err) {
    console.error("Error deleting game:", err);
    alert("Failed to delete game.");
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
});
