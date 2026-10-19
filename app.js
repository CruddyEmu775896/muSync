const $ = (sel) => document.querySelector(sel);

// --- State ---
let library = JSON.parse(localStorage.getItem('muSync_library')) || [];
let queue = [];
let currentIndex = -1;
let currentMode = 'smart';
let currentAudioUrl = null; // Keeps track of the currently playing audio URL

// --- Init ---
function init() {
  renderLibrary();
  renderQueue();
  updateCounts();
  
  // Event Listeners for main UI
  $('#add').addEventListener('click', addSong);
  $('#search').addEventListener('input', renderLibrary);
  $('#sort').addEventListener('change', renderLibrary);
  $('#build').addEventListener('click', buildQueue);
  $('#clear').addEventListener('click', clearQueue);
  
  // Player Controls
  $('#skip').addEventListener('click', playNext);
  $('#stop').addEventListener('click', stopPlayback);
  
  // Playback Mode Radios
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => { currentMode = e.target.value; });
  });

  // Backup & Import Listeners
  $('#dl').addEventListener('click', downloadLibrary);
  $('#ul').addEventListener('click', () => $('#ul-file').click());
  $('#ul-file').addEventListener('change', uploadLibrary);
  $('#csv-btn').addEventListener('click', () => $('#csv-file').click());
  $('#csv-file').addEventListener('change', importCSV);

  // Restore last played song if exists
  const lastPlayed = localStorage.getItem('muSync_lastPlayed');
  if (lastPlayed && library.length > 0) {
    const song = library.find(s => s.id === lastPlayed);
    if (song) loadSong(song, false); // Load but don't auto-play
  }
}

// --- Core Functions ---
function addSong() {
  const title = $('#title').value.trim();
  const artist = $('#artist').value.trim();
  if (!title || !artist) return alert('Please enter both title and artist.');

  // Create a hidden file input to let the user pick an audio file
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Create a temporary local URL for the audio file
    const audioUrl = URL.createObjectURL(file);

    const newSong = {
      id: Date.now().toString(),
      title,
      artist,
      audioUrl: audioUrl,
      added: Date.now(),
      plays: 0
    };

    library.push(newSong);
    saveLibrary();
    $('#title').value = '';
    $('#artist').value = '';
    renderLibrary();
    updateCounts();
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
  loadSong(song, true);
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
  loadSong(song, true);
}

function loadSong(song, autoPlay = true) {
  $('#player').hidden = false;
  $('#np-title').textContent = song.title;
  $('#np-artist').textContent = song.artist;
  
  // Revoke old URL to save memory
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
  }
  
  const audioElement = $('#audio');
  
  // If the song has an actual audio file attached
  if (song.audioUrl) {
    currentAudioUrl = song.audioUrl;
    audioElement.src = currentAudioUrl;
    
    if (autoPlay) {
      audioElement.play().catch(e => console.log("Playback blocked by browser:", e));
      
      // Increment play count
      song.plays++;
      saveLibrary();
      renderLibrary();
    }
  } else {
    // Fallback if no audio file was uploaded (e.g., imported from CSV)
    audioElement.src = '';
    alert("This song doesn't have a local audio file attached.");
  }
  
  // Track last played
  localStorage.setItem('muSync_lastPlayed', song.id);
  renderQueue();
}

// Handle audio ending
$('#audio').addEventListener('ended', playNext);

function stopPlayback() {
  const audioElement = $('#audio');
  audioElement.pause();
  audioElement.currentTime = 0;
  $('#player').hidden = true;
}

// --- Backup & Import ---
function downloadLibrary() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(library));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "musync_backup.json");
  document.body.appendChild(downloadAnchorNode);
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

function uploadLibrary(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const importedData = JSON.parse(e.target.result);
      if (Array.isArray(importedData)) {
        library = importedData;
        saveLibrary();
        renderLibrary();
        updateCounts();
        alert("Library restored successfully!");
      } else {
        alert("Invalid backup file format.");
      }
    } catch (err) {
      alert("Error reading file: " + err.message);
    }
  };
  reader.readAsText(file);
}

function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split('\n');
    let importedCount = 0;
    
    // Simple CSV parser (assumes format: Title, Artist)
    for (let i = 1; i < lines.length; i++) { // Skip header row
      const line = lines[i].trim();
      if (!line) continue;
      
      // Handle simple comma separation (doesn't handle quotes with commas perfectly, but works for basic exports)
      const parts = line.split(',');
      if (parts.length >= 2) {
        const title = parts[0].replace(/^"|"$/g, '').trim();
        const artist = parts[1].replace(/^"|"$/g, '').trim();
        
        if (title && artist) {
          library.push({
            id: Date.now().toString() + i,
            title: title,
            artist: artist,
            added: Date.now(),
            plays: 0
          });
          importedCount++;
        }
      }
    }
    
    saveLibrary();
    renderLibrary();
    updateCounts();
    alert(`Imported ${importedCount} songs from CSV.`);
  };
  reader.readAsText(file);
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// Make functions global for inline onclick handlers
window.playSong = playSong;
window.deleteSong = deleteSong;
