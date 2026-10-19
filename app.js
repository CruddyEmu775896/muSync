// app.js
const $ = (sel) => document.querySelector(sel);

// --- State ---
let library = JSON.parse(localStorage.getItem('muSync_library')) || [];
let queue = [];
let currentIndex = -1;
let currentMode = 'smart';

// --- Init ---
function init() {
  renderLibrary();
  renderQueue();
  updateCounts();
  
  // Event Listeners
  $('#add').addEventListener('click', addSong);
  $('#search').addEventListener('input', renderLibrary);
  $('#sort').addEventListener('change', renderLibrary);
  $('#build').addEventListener('click', buildQueue);
  $('#clear').addEventListener('click', clearQueue);
  $('#skip').addEventListener('click', playNext);
  $('#stop').addEventListener('click', stopPlayback);
  
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => { currentMode = e.target.value; });
  });

  // Restore last played song if exists
  const lastPlayed = localStorage.getItem('muSync_lastPlayed');
  if (lastPlayed && library.length > 0) {
    const song = library.find(s => s.id === lastPlayed);
    if (song) loadSong(song);
  }
}

// --- Core Functions ---
function addSong() {
  const title = $('#title').value.trim();
  const artist = $('#artist').value.trim();
  if (!title || !artist) return alert('Please enter both title and artist.');

  const newSong = {
    id: Date.now().toString(),
    title,
    artist,
    added: Date.now(),
    plays: 0
  };

  library.push(newSong);
  saveLibrary();
  $('#title').value = '';
  $('#artist').value = '';
  renderLibrary();
  updateCounts();
}

function saveLibrary() {
  localStorage.setItem('muSync_library', JSON.stringify(library));
}

function renderLibrary() {
  const list = $('#list');
  const search = $('#search').value.toLowerCase();
  const sort = $('#sort').value;
  
  let filtered = library.filter(s => 
    s.title.toLowerCase().includes(search) || 
    s.artist.toLowerCase().includes(search)
  );

  // Sorting
  if (sort === 'added-desc') filtered.sort((a, b) => b.added - a.added);
  if (sort === 'added-asc') filtered.sort((a, b) => a.added - b.added);
  if (sort === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'artist') filtered.sort((a, b) => a.artist.localeCompare(b.artist));
  if (sort === 'plays') filtered.sort((a, b) => b.plays - a.plays);

  list.innerHTML = '';
  if (filtered.length === 0) {
    $('#empty').style.display = 'block';
  } else {
    $('#empty').style.display = 'none';
    filtered.forEach(song => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div>
          <div class="t">${song.title}</div>
          <div class="s muted">${song.artist} • ${song.plays} plays</div>
        </div>
        <div class="acts">
          <button class="mini" onclick="playSong('${song.id}')">Play</button>
          <button class="mini" onclick="deleteSong('${song.id}')">X</button>
        </div>
      `;
      list.appendChild(li);
    });
  }
}

function deleteSong(id) {
  library = library.filter(s => s.id !== id);
  saveLibrary();
  renderLibrary();
  updateCounts();
}

function updateCounts() {
  $('#lib-count').textContent = `(${library.length})`;
}

// --- Playback & Queue ---
function buildQueue() {
  if (library.length === 0) return alert('Add some songs first!');
  
  queue = [...library];
  
  if (currentMode === 'random') {
    queue.sort(() => Math.random() - 0.5);
  } else if (currentMode === 'smart') {
    // Simple smart shuffle: sort by least played, then random
    queue.sort((a, b) => a.plays - b.plays || Math.random() - 0.5);
  }
  
  currentIndex = -1;
  renderQueue();
  playNext();
}

function clearQueue() {
  queue = [];
  currentIndex = -1;
  renderQueue();
  stopPlayback();
}

function renderQueue() {
  const qList = $('#queue');
  qList.innerHTML = '';
  
  if (queue.length === 0) {
    $('#queue-empty').style.display = 'block';
  } else {
    $('#queue-empty').style.display = 'none';
    queue.forEach((song, i) => {
      const li = document.createElement('li');
      const isPlaying = i === currentIndex;
      li.innerHTML = `
        <div style="${isPlaying ? 'color: var(--accent); font-weight: bold;' : ''}">
          ${i + 1}. ${song.title} <span class="muted s">(${song.artist})</span>
        </div>
      `;
      qList.appendChild(li);
    });
  }
}

function playNext() {
  if (queue.length === 0) return;
  currentIndex = (currentIndex + 1) % queue.length;
  const song = queue[currentIndex];
  loadSong(song);
}

function playSong(id) {
  const song = library.find(s => s.id === id);
  if (!song) return;
  
  // Add to queue if not there
  if (!queue.find(s => s.id === id)) {
    queue.push(song);
    renderQueue();
  }
  
  currentIndex = queue.findIndex(s => s.id === id);
  loadSong(song);
}

function loadSong(song) {
  $('#player').hidden = false;
  $('#np-title').textContent = song.title;
  $('#np-artist').textContent = song.artist;
  
  // Increment play count
  song.plays++;
  saveLibrary();
  renderLibrary();
  
  // Track last played
  localStorage.setItem('muSync_lastPlayed', song.id);
  
  // Since you don't have actual audio files, we simulate playback
  // In a real app, you'd set the <audio> src here
  $('#np-progress').style.width = '0%';
  let progress = 0;
  window.playInterval = setInterval(() => {
    progress += 2;
    $('#np-progress').style.width = `${progress}%`;
    if (progress >= 100) {
      clearInterval(window.playInterval);
      playNext();
    }
  }, 1000); // 50 seconds simulated playback
  
  renderQueue();
}

function stopPlayback() {
  clearInterval(window.playInterval);
  $('#np-progress').style.width = '0%';
  $('#player').hidden = true;
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// Make functions global for inline onclick handlers
window.playSong = playSong;
window.deleteSong = deleteSong;
