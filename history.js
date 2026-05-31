import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc, query, orderBy, limit, startAfter } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
const loadMoreContainer = document.getElementById('load-more-container');
const loadMoreBtn = document.getElementById('load-more-btn');

let lastVisible = null;
let isLoadingMore = false;

async function loadHistory(isLoadMore = false) {
  if (isLoadMore && !lastVisible) return;
  if (isLoadingMore) return;
  
  isLoadingMore = true;
  if (isLoadMore) {
    const originalText = loadMoreBtn.innerHTML;
    loadMoreBtn.innerHTML = '<span class="material-symbols-outlined" style="animation: pulse 1s infinite;">sync</span> Loading...';
    loadMoreBtn.dataset.originalText = originalText;
  }

  try {
    let q;
    if (isLoadMore) {
      q = query(collection(db, "mixers_history"), orderBy("savedAt", "desc"), startAfter(lastVisible), limit(20));
    } else {
      q = query(collection(db, "mixers_history"), orderBy("savedAt", "desc"), limit(20));
    }
    
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.empty && !isLoadMore) {
      historyContainer.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); padding: 60px 20px; background: var(--surface); border-radius: 20px; border: 1px dashed var(--surface-highest);">
          <span class="material-symbols-outlined" style="font-size: 48px; margin-bottom: 16px; color: var(--surface-highest);">history</span>
          <p style="font-weight: 600;">No saved games found.</p>
          <p style="font-size: 13px; margin-top: 8px;">Save a game from the Admin Dashboard to see it here.</p>
        </div>
      `;
      loadMoreContainer.style.display = 'none';
      return;
    }

    if (!isLoadMore) {
      historyContainer.innerHTML = '';
    }
    
    // Update cursor
    if (!querySnapshot.empty) {
      lastVisible = querySnapshot.docs[querySnapshot.docs.length - 1];
    }
    
    // Handle load more button visibility
    if (querySnapshot.docs.length < 20) {
      loadMoreContainer.style.display = 'none';
      lastVisible = null;
    } else {
      loadMoreContainer.style.display = 'block';
    }
    
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const id = docSnap.id;
      
      const date = new Date(data.savedAt || parseInt(id));
      const dateString = date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      
      const activeCourts = data.courts ? data.courts.filter(c => c.isActive).length : 0;
      const stage = data.currentStage === 2 ? 'Championship Stage' : 'Group Stage';
      const title = data.gameName || 'Tournament Snapshot';
      
      const card = document.createElement('div');
      card.className = 'history-card neon-glow';
      
      card.innerHTML = `
        <div class="history-header">
          <div class="history-title">${title}</div>
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
          <button class="btn-primary neon-glow-active load-btn" data-id="${id}" style="flex: 1; display: flex; align-items: center; justify-content: center; white-space: nowrap; height: 44px; border-radius: 12px; font-size: 14px; font-weight: 700; gap: 8px;">
            <span class="material-symbols-outlined" style="font-size: 18px;">open_in_new</span>
            Open Game
          </button>
          <button class="add-players-btn delete-btn" data-id="${id}" style="display: flex; align-items: center; justify-content: center; height: 44px; width: 64px; padding: 0; border-radius: 12px; border: 1px solid rgba(248, 113, 113, 0.4); color: var(--red); background: transparent; cursor: pointer; transition: all 0.2s ease;">
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
    if (!isLoadMore) {
      historyContainer.innerHTML = `
        <div style="text-align: center; color: var(--red); padding: 40px; background: var(--red-bg); border-radius: 16px; border: 1px dashed rgba(248, 113, 113, 0.4);">
          <p style="font-weight: 700;">Error loading history.</p>
          <p style="font-size: 13px; margin-top: 8px;">Check your connection and try again.</p>
        </div>
      `;
    } else {
      alert("Error loading more games. Please check your connection.");
    }
  } finally {
    isLoadingMore = false;
    if (isLoadMore && loadMoreBtn.dataset.originalText) {
      loadMoreBtn.innerHTML = loadMoreBtn.dataset.originalText;
    }
  }
}

if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', () => loadHistory(true));
}

async function loadGame(id, data, btnElement) {
  const originalHtml = btnElement.innerHTML;
  btnElement.innerHTML = `<span class="material-symbols-outlined">check_circle</span> Opened!`;
  
  // Open the game in a new tab using standard query parameter to avoid Vercel rewrite issues
  window.open(`/?game_id=${id}`, '_blank');
  
  setTimeout(() => {
    btnElement.innerHTML = originalHtml;
  }, 2000);
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

// Theme Initialization
const themeToggleBtn = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

function initTheme() {
  const currentTheme = localStorage.getItem('theme') || 'dark';
  if (currentTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (themeIcon) themeIcon.textContent = 'dark_mode';
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'dark');
        if (themeIcon) {
          themeIcon.textContent = 'light_mode';
          themeIcon.style.transform = 'rotate(0deg)';
        }
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
        if (themeIcon) {
          themeIcon.textContent = 'dark_mode';
          themeIcon.style.transform = 'rotate(180deg)';
        }
      }
    });
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadHistory();
});
