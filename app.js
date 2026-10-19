const $ = (sel) => document.querySelector(sel);

// --- State ---
let library = JSON.parse(localStorage.getItem('muSync_library')) || [];
let queue = [];
let currentIndex = -1;
let currentMode = 'smart';
let currentAudioUrl = null;
let SQL = null;

// --- Init ---
async function init() {
  renderLibrary();
  renderQueue();
  updateCounts();
  
  try {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });
  } catch (e) {
    console.warn("SQL.js failed to load.", e);
  }

  $('#add').addEventListener('click', addSong);
  $('#search').addEventListener('input', renderLibrary);
  $('#sort').addEventListener('change', renderLibrary);
  $('#build').addEventListener('click', buildQueue);
  $('#clear').addEventListener('click', clearQueue);
  
  $('#skip').addEventListener('click', playNext);
  $('#stop').addEventListener('click', stopPlayback);
  $('#audio').addEventListener('ended', playNext);
  
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => { currentMode = e.target.value; });
  });

  $('#dl').addEventListener('click', downloadLibrary);
  $('#ul').addEventListener('click', () => $('#ul-file').click());
  $('#ul-file').addEventListener('change', uploadLibrary);
  $('#csv-btn').addEventListener('click', () => $('#csv-file').click());
  $('#csv-file').addEventListener('change', importCSV);

  const lastPlayed = localStorage.getItem('muSync_lastPlayed');
  if (lastPlayed && library.length > 0) {
    const song = library.find(s => s.id === lastPlayed);
    if (song) loadSong(song, false);
  }
}

// --- Core Functions ---
function addSong() {
  const title = $('#title').value.trim();
  const artist = $('#artist').value.trim();
  if (!title || !artist) return alert('Please enter both title and artist.');

  // Create the song WITHOUT an audio file first
  const newSong = {
    id: Date.now().toString(),
    title,
    artist,
    audioUrl: null, // Empty for now
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

// New function to attach audio to an existing song
function attachAudio(id) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const song = library.find(s => s.id === id);
    if (song) {
      song.audioUrl = URL.createObjectURL(file);
      saveLibrary();
      renderLibrary(); // Re-render to show it's attached
    }
  };
  
  fileInput.click();
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
      
      // Check if audio is attached to show the right button
      const audioStatus = song.audioUrl 
        ? `<button class="mini" onclick="playSong('${song.id}')">Play</button>` 
        : `<button class="mini" style="background: #333; color: #aaa;" onclick="attachAudio('${song.id}')">Attach Audio</button>`;

      li.innerHTML = `
        <div>
          <div class="t">${song.title}</div>
          <div class="s muted">${song.artist} • ${song.plays} plays</div>
        </div>
        <div class="acts">
          ${audioStatus}
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
  // Only queue songs that have audio attached
  queue = library.filter(s => s.audioUrl);
  
  if (queue.length === 0) return alert('No songs have audio attached yet!');
  
  if (currentMode === 'random') {
    queue.sort(() => Math.random() - 0.5);
  } else if (currentMode === 'smart') {
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
  loadSong(queue[currentIndex], true);
}

function playSong(id) {
  const song = library.find(s => s.id === id);
  if (!song) return;
  
  if (!song.audioUrl) {
    return alert("This song doesn't have an audio file attached yet. Click 'Attach Audio' first.");
  }

  if (!queue.find(s => s.id === id)) {
    queue.push(song);
    renderQueue();
  }
  currentIndex = queue.findIndex(s => s.id === id);
  loadSong(song, true);
}

function loadSong(song, autoPlay = true) {
  $('#player').hidden = false;
  $('#np-title').textContent = song.title;
  $('#np-artist').textContent = song.artist;
  
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  const audioElement = $('#audio');
  
  if (song.audioUrl) {
    currentAudioUrl = song.audioUrl;
    audioElement.src = currentAudioUrl;
    if (autoPlay) {
      audioElement.play().catch(e => console.log("Playback blocked:", e));
      song.plays++;
      saveLibrary();
      renderLibrary();
    }
  } else {
    audioElement.src = '';
  }
  localStorage.setItem('muSync_lastPlayed', song.id);
  renderQueue();
}

function stopPlayback() {
  const audioElement = $('#audio');
  audioElement.pause();
  audioElement.currentTime = 0;
  $('#player').hidden = true;
}

// --- BACKUP & IMPORT LOGIC ---
function downloadLibrary() {
  if (library.length === 0) return alert("Your library is empty!");
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(library, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "musync_backup.json");
  document.body.appendChild(downloadAnchorNode);
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

async function uploadLibrary(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.name.endsWith('.db') || file.name.endsWith('.sqlite')) {
    if (!SQL) return alert("SQL engine not loaded. Please check your internet connection and refresh.");
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const uint8Array = new Uint8Array(e.target.result);
        const db = new SQL.Database(uint8Array);
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        if (tables.length === 0) throw new Error("No tables found in database.");
        const tableName = tables[0].values[0][0];
        const res = db.exec(`SELECT * FROM ${tableName}`);
        if (res.length === 0) throw new Error("Table is empty.");
        
        const columns = res[0].columns.map(c => c.toLowerCase());
        const values = res[0].values;
        const titleIdx = columns.findIndex(c => c.includes('title') || c.includes('name') || c.includes('song'));
        const artistIdx = columns.findIndex(c => c.includes('artist') || c.includes('band') || c.includes('author'));

        if (titleIdx === -1 || artistIdx === -1) throw new Error("Could not find 'title' and 'artist' columns.");

        let importedCount = 0;
        values.forEach((row, i) => {
          library.push({
            id: Date.now().toString() + i,
            title: row[titleIdx] ? row[titleIdx].toString() : 'Unknown Title',
            artist: row[artistIdx] ? row[artistIdx].toString() : 'Unknown Artist',
            audioUrl: null,
            added: Date.now(),
            plays: 0
          });
          importedCount++;
        });
        saveLibrary(); renderLibrary(); updateCounts();
        alert(`Successfully imported ${importedCount} songs! You will need to attach audio files to them.`);
        event.target.value = '';
      } catch (err) {
        alert("Error reading DB file: " + err.message);
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const importedData = JSON.parse(e.target.result);
        if (Array.isArray(importedData)) {
          // Ensure imported songs have an audioUrl property
          importedData.forEach(s => { if (s.audioUrl === undefined) s.audioUrl = null; });
          library = importedData;
          saveLibrary(); renderLibrary(); updateCounts();
          alert("Library restored successfully from JSON!");
        } else {
          alert("Invalid backup file format.");
        }
      } catch (err) {
        alert("Error reading JSON: " + err.message);
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }
}

function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split('\n');
    let importedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length >= 2) {
        const title = parts[0].replace(/^"|"$/g, '').trim();
        const artist = parts[1].replace(/^"|"$/g, '').trim();
        if (title && artist) {
          library.push({
            id: Date.now().toString() + i,
            title: title,
            artist: artist,
            audioUrl: null,
            added: Date.now(),
            plays: 0
          });
          importedCount++;
        }
      }
    }
    saveLibrary(); renderLibrary(); updateCounts();
    alert(`Imported ${importedCount} songs. You will need to attach audio files.`);
    event.target.value = '';
  };
  reader.readAsText(file);
}

// Start
document.addEventListener('DOMContentLoaded', init);

// Global functions
window.playSong = playSong;
window.deleteSong = deleteSong;
window.attachAudio = attachAudio;
